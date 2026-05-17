"""ElevenLabs v3 TTS 합성 + Gemini Flash로 direction→audio tag 매핑 + 슬롯 길이 매칭(atempo).

핵심 함수:
- synthesize_script(sentences, voice_name, ...) — 전체 합성 (job 폴더 생성)
- regenerate_segment(job_id, idx, emotion_strength) — 한 문장만 재합성 + 재합치기
- get_job(job_id) — 작업 상태 조회

저장 구조:
  tts/
    job_<unix>_<voice>/
      meta.json
      seg_000.mp3, seg_001.mp3, ...
      final.mp3
TTL: 2시간 (cleanup_old_files).
"""

import os
import re
import json
import time
import shutil
import subprocess
from pathlib import Path

import requests

try:
    import imageio_ffmpeg
    FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()
except Exception:
    FFMPEG = "ffmpeg"  # Vercel 등 imageio_ffmpeg 미설치 환경 fallback

ROOT = Path(__file__).resolve().parents[2]


def _resolve_tts_dir():
    """TTS 출력 디렉터리 — 서버리스(Vercel/Lambda)는 /tmp만 writable이므로 자동 분기.
    1) TTS_DIR 환경변수 명시 시 그것 사용
    2) Vercel/AWS Lambda → /tmp/tts
    3) 그 외(로컬 dev) → <project>/tts"""
    override = os.environ.get("TTS_DIR")
    if override:
        return Path(override)
    if os.environ.get("VERCEL") or os.environ.get("AWS_LAMBDA_FUNCTION_NAME"):
        return Path("/tmp") / "tts"
    return ROOT / "tts"


TTS_DIR = _resolve_tts_dir()
try:
    TTS_DIR.mkdir(parents=True, exist_ok=True)
except OSError:
    # 예: read-only fs인데 미리 추측 실패 시 /tmp로 강제
    TTS_DIR = Path("/tmp") / "tts"
    TTS_DIR.mkdir(parents=True, exist_ok=True)

GEMINI_MODEL = "gemini-3-flash-preview"

PRESETS = {
    # accepts: voice가 자연스럽게 들리는 페르소나 성별 — female / male / any
    "yuna":     {"id": "xi3rF0t7dg7uN2M0WUhr", "label": "Yuna (여성, 부드러움)",       "accepts": "female"},
    "han_aim":  {"id": "8jHHF8rMqMlg8if2mOUe", "label": "Han Aim (여성, 캐주얼)",      "accepts": "female"},
    "jennie":   {"id": "z6Kj0hecH20CdetSElRT", "label": "Jennie (여성, 자신감)",       "accepts": "female"},
    "male":     {"id": "oezp1w0IATNLah6Gnq1W", "label": "숏폼 남성",                    "accepts": "male"},
    "joonpark": {"id": "7Nah3cbXKVmGX7gQUuwz", "label": "JoonPark (남녀 공용, professional)", "accepts": "any"},
}

DEFAULT_TTL_SEC = 7200  # 2시간 (로컬 임시 캐시 — 결과는 Supabase에 영구 보관)
DEFAULT_EMOTION = 0.5   # 슬라이더 50 (= 기본값)
TTS_BUCKET = "tts-files"  # Supabase Storage bucket (public)


def _upload_final_to_supabase(job_id, local_path):
    """final.mp3를 Supabase Storage에 업로드 → public URL 반환.
    실패해도 raise 안 함 — local fallback (TTS 자체는 성공)."""
    from services import supabase as sb
    try:
        sb.storage_create_bucket(TTS_BUCKET, public=True)  # idempotent, in-process cached
    except Exception:
        pass  # 버킷 있다고 가정하고 upload 시도
    remote_path = f"{job_id}/final.mp3"
    try:
        data = local_path.read_bytes()
    except OSError as e:
        raise RuntimeError(f"final.mp3 read failed: {e}")
    try:
        ok, err = sb.storage_upload(TTS_BUCKET, remote_path, data, content_type="audio/mpeg", upsert=True)
    except Exception as e:
        # 업로드 자체에 네트워크 에러 — 로컬 fallback URL 반환 (TTS 합성 자체는 성공)
        return None
    if not ok:
        return None  # 로컬 fallback (raise 안 함)
    return sb.storage_public_url(TTS_BUCKET, remote_path)


def _eleven_key():
    k = os.getenv("ELEVENLABS_API_KEY")
    if not k:
        raise RuntimeError("ELEVENLABS_API_KEY 미설정")
    return k


def _gemini_key():
    k = os.getenv("GEMINI_API_KEY")
    if not k:
        raise RuntimeError("GEMINI_API_KEY 미설정")
    return k


def emotion_to_voice_settings(strength: float) -> dict:
    """슬라이더 0.0~1.0 → voice_settings.
    v3 alpha는 segment 간 voice 일관성을 chaining(request_ids/prev_text)으로 잡을 수 없어서
    voice_settings로만 락해야 함 → stability/similarity_boost를 강하게 고정.
    표현력은 audio tag([excited][shouting] 등)으로 살림.
    strength=0.0 → 담백 (style=0.05, stab=0.8)
    strength=0.5 → 기본 (style=0.30, stab=0.7)
    strength=1.0 → 격앙 (style=0.55, stab=0.6)"""
    s = max(0.0, min(1.0, strength))
    return {
        "stability": round(0.8 - s * 0.2, 4),
        "similarity_boost": 0.95,
        "style": round(0.05 + s * 0.5, 4),
        "use_speaker_boost": True,
    }


STRENGTH_LABELS = ["매우약", "약", "기본", "강", "매우강"]


def map_directions(directions):
    """direction list → base tag list (1 Gemini call, N → N).
    초기 합성에만 사용. 비-base 단계는 lazy(`expand_direction_to_variants`)로 채움."""
    if not directions:
        return []
    if not any(directions):
        return [""] * len(directions)
    prompt = (
        "아래 한국어 발화 지시(direction)들을 ElevenLabs v3 audio tag로 변환해.\n"
        "각 direction에 가장 적합한 2~3개 tag을 [a][b] 형식으로 조합 (보통 강도, level 0).\n\n"
        "사용 가능 tag:\n"
        "- 감정: [calm][happy][sad][angry][excited][whispers][surprised]\n"
        "- 톤: [confident][emphatic][serious][curious][passionate][intense]\n"
        "- 강조: [commanding][shouting]\n\n"
        f"입력: {json.dumps(directions, ensure_ascii=False)}\n\n"
        "JSON 배열만 (입력과 동일 길이).\n"
        '예: ["[confident][emphatic]", "[excited][passionate]", "[calm][serious]"]'
    )
    r = requests.post(
        f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent?key={_gemini_key()}",
        json={
            "contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": {"responseMimeType": "application/json", "maxOutputTokens": 4096},
        },
        timeout=120,
    )
    if r.status_code != 200:
        raise RuntimeError(f"Gemini error {r.status_code}: {r.text[:400]}")
    tags = json.loads(r.json()["candidates"][0]["content"]["parts"][0]["text"])
    if len(tags) < len(directions):
        tags = list(tags) + [""] * (len(directions) - len(tags))
    elif len(tags) > len(directions):
        tags = list(tags)[:len(directions)]
    return tags


def expand_direction_to_variants(direction, base_tag):
    """1 direction → 5단계 variants (Gemini 1회). 사용자가 비-base 강도를 처음 선택했을 때만 호출."""
    if not direction:
        return [base_tag] * 5
    prompt = (
        f"한국어 발화 지시: \"{direction}\"\n"
        f"기본 tag (level 0): {base_tag}\n\n"
        "이 direction에 대해 ElevenLabs v3 audio tag을 5단계 강도로 생성:\n"
        "- 매우 약 (담백): 1개 tag (예: [calm], [neutral], [whispers])\n"
        "- 약 (살짝): 1~2개 부드러운 tag\n"
        "- 기본 (보통): 위 base와 비슷하거나 동일\n"
        "- 강 (강한 감정): 2~3개, 강한 단어 ([commanding][intense] 등)\n"
        "- 매우 강 (격앙): 3개, 가장 센 단어 ([shouting][ecstatic][thunderous] 등)\n\n"
        "사용 가능 tag:\n"
        "- 감정: [calm][neutral][happy][sad][angry][surprised][excited][whispers][ecstatic][overjoyed][devastated][furious][weeping][cackling][gasping]\n"
        "- 톤: [confident][emphatic][serious][curious][commanding][passionate][intense][thunderous][trembling][shouting]\n\n"
        "JSON 배열 5개 (낮음→높음 순).\n"
        '예: ["[calm]", "[confident][calm]", "[confident][emphatic]", "[commanding][intense][emphatic]", "[shouting][thunderous][commanding]"]'
    )
    r = requests.post(
        f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent?key={_gemini_key()}",
        json={
            "contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": {"responseMimeType": "application/json", "maxOutputTokens": 1024},
        },
        timeout=60,
    )
    if r.status_code != 200:
        raise RuntimeError(f"Gemini error {r.status_code}: {r.text[:400]}")
    row = json.loads(r.json()["candidates"][0]["content"]["parts"][0]["text"])
    if not isinstance(row, list):
        row = [base_tag] * 5
    if len(row) < 5:
        row = row + [base_tag] * (5 - len(row))
    elif len(row) > 5:
        row = row[:5]
    # base level이 비어있으면 원래 base로 복원
    if not row[2]:
        row[2] = base_tag
    return row


# 자동 감정 분석 — phrase 단위 emotion tag 자동 할당 (Gemini Flash 1회 호출)
EMOTION_PRESETS_FOR_LLM = [
    ("[emphatic]",                "강조 (핵심 단어/단언)"),
    ("[shouting][passionate]",    "격앙/외침 (감탄·놀라움 절정)"),
    ("[surprised]",               "놀람 (예상 밖)"),
    ("[gasping][surprised]",      "충격 (강한 놀람)"),
    ("[whispers]",                "속삭임 (비밀스러움)"),
    ("[calm]",                    "차분 (안정)"),
    ("[serious][confident]",      "진지 (전문성)"),
    ("[excited][happy]",          "신남 (밝음·즐거움)"),
]

INTENSITY_GUIDES = {
    "low":    "문장당 강조 어절 0~1개 (꼭 필요한 곳만)",
    "medium": "문장당 강조 어절 1~2개 (자연스러운 흐름)",
    "high":   "문장당 강조 어절 2~4개 (감정 풍부하게)",
}


def analyze_phrase_emotion(sentences, intensity="medium"):
    """문장들을 LLM이 자연 어절 단위로 분리하고 강조 포인트에 emotion tag 자동 할당.
    Input: [{start, end, text, ...}]
    Output: same shape + phrases=[{text, tag}] 가 채워진 sentences
    intensity: low / medium / high — 강조 빈도 조절."""
    if not sentences:
        return []
    intensity = intensity if intensity in INTENSITY_GUIDES else "medium"
    tag_list = "\n".join(f"- {t} ({l})" for t, l in EMOTION_PRESETS_FOR_LLM)
    texts = [s.get("text", "") for s in sentences]

    prompt = (
        "당신은 한국어 숏폼 영상의 음성 합성 감정 디렉터입니다.\n"
        "입력 문장들을 자연스러운 발화 단위(어절)로 나누고, 강조·감정이 필요한 부분에 audio tag을 할당하세요.\n\n"
        f"## 입력 문장 ({len(texts)}개)\n"
        f"{json.dumps(texts, ensure_ascii=False, indent=2)}\n\n"
        "## 사용 가능 tag (이 외엔 금지)\n"
        '- "" (tag 없음 — 평범한 발화)\n'
        f"{tag_list}\n\n"
        "## 어절 분리 규칙\n"
        '- 공백 1:1 분리 ❌ — 의미 묶음으로 (예: "신기한 거" 한 덩어리)\n'
        "- 한 phrase는 보통 1~3 어절, 5어절 넘지 말 것\n"
        '- 조사·연결어미는 앞 단어와 묶음 ("저는 / 이거 정말 / 좋아해요")\n\n'
        "## 강조 규칙\n"
        f"- 강도={intensity}: {INTENSITY_GUIDES[intensity]}\n"
        "- 강조는 의미 핵심 (감탄사, 숫자, 핵심 형용사·동사, 결정적 단어)\n"
        "- 같은 문장 내 동일 tag 연속 X (단조로움 방지)\n"
        "- 후킹/결론 문장은 강조 비중↑, 설명 문장은 ↓\n"
        "- 평범한 phrase 대다수, 강조는 포인트만\n\n"
        "## 출력 JSON (sentences 배열 길이 입력과 동일)\n"
        "{\n"
        '  "sentences": [\n'
        "    {\n"
        '      "phrases": [\n'
        '        {"text": "저는", "tag": ""},\n'
        '        {"text": "이거 정말", "tag": "[emphatic]"},\n'
        '        {"text": "좋아해요", "tag": ""}\n'
        "      ]\n"
        "    }\n"
        "  ]\n"
        "}\n\n"
        "JSON만 출력. 설명 금지. 입력 텍스트의 모든 글자가 phrases.text를 합친 결과에 빠짐없이 들어가야 함."
    )

    r = requests.post(
        f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent?key={_gemini_key()}",
        json={
            "contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": {"responseMimeType": "application/json", "maxOutputTokens": 8192},
        },
        timeout=120,
    )
    if r.status_code != 200:
        raise RuntimeError(f"Gemini error {r.status_code}: {r.text[:400]}")
    data = json.loads(r.json()["candidates"][0]["content"]["parts"][0]["text"])
    raw_sents = data.get("sentences") or []

    out = []
    for i, s in enumerate(sentences):
        new_s = dict(s)
        if i < len(raw_sents):
            phrases_raw = raw_sents[i].get("phrases") or []
            phrases_clean = []
            for p in phrases_raw:
                pt = (p.get("text") or "").strip()
                if not pt:
                    continue
                tag = (p.get("tag") or "").strip()
                # 허용된 tag만 통과 (LLM이 임의 tag 만들면 거름)
                allowed = {t for t, _ in EMOTION_PRESETS_FOR_LLM}
                if tag and tag not in allowed:
                    tag = ""
                phrases_clean.append({"text": pt, "tag": tag} if tag else {"text": pt})
            if phrases_clean:
                # 입력 텍스트와 phrases 합본 비교 — 글자 손실 체크 (의미 안 맞으면 폴백)
                joined = "".join(p["text"] for p in phrases_clean).replace(" ", "")
                orig = (s.get("text") or "").replace(" ", "")
                if joined == orig or abs(len(joined) - len(orig)) <= 2:
                    new_s["phrases"] = phrases_clean
                # 글자 차이 크면 자동 split 폴백 (공백 분리)
                else:
                    tokens = (s.get("text") or "").split()
                    if tokens:
                        new_s["phrases"] = [{"text": t} for t in tokens]
        out.append(new_s)
    return out


def synth_segment(text, tag, voice_id, model_id, out_path, voice_settings=None,
                  previous_request_ids=None, previous_text=None, next_text=None):
    """단일 segment 합성. voice 일관성을 위해 이전 segment의 request_id를 chain 가능.
    ElevenLabs 공식: 동일 voice라도 호출마다 미세하게 다름 → previous_request_ids로 연결.
    주의: eleven_v3는 previous_text/next_text 미지원 → request_ids만 사용.
    Returns: 응답의 request-id (있으면, 다음 호출 chain용)"""
    if voice_settings is None:
        voice_settings = emotion_to_voice_settings(DEFAULT_EMOTION)
    tagged = f"{tag} {text}".strip()
    payload = {
        "text": tagged,
        "model_id": model_id,
        "voice_settings": voice_settings,
    }
    is_v3 = "v3" in (model_id or "")
    # eleven_v3는 previous_request_ids / previous_text / next_text 전부 미지원 (alpha)
    if not is_v3:
        if previous_request_ids:
            payload["previous_request_ids"] = list(previous_request_ids)[-3:]
        if previous_text:
            payload["previous_text"] = previous_text[-500:]
        if next_text:
            payload["next_text"] = next_text[:500]
    r = requests.post(
        f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}",
        headers={"xi-api-key": _eleven_key(), "Content-Type": "application/json"},
        json=payload,
        timeout=180,
    )
    if r.status_code != 200:
        raise RuntimeError(f"ElevenLabs error {r.status_code}: {r.text[:500]}")
    out_path.write_bytes(r.content)
    return r.headers.get("Request-Id") or r.headers.get("request-id")


def probe_duration(path):
    r = subprocess.run([FFMPEG, "-i", str(path), "-f", "null", "-"], capture_output=True)
    err = r.stderr.decode("utf-8", errors="replace")
    m = re.search(r"Duration: (\d+):(\d+):(\d+\.\d+)", err)
    if not m:
        return 0.0
    h, mn, s = m.groups()
    return int(h) * 3600 + int(mn) * 60 + float(s)


def merge_segments(segments, output, max_speedup=1.0):
    """자연 속도 + 순차 이어붙임. 슬롯 매칭(atempo 가속) 제거 — 음성 톤 보존 우선.

    각 segment의 자연 길이대로 배치 → 영상 sync는 어긋날 수 있으나 음성 변형 없음.
    글자수·감정에 따른 길이는 elevenlabs audio tag가 자체 처리.
    (max_speedup 인자는 backward-compat용 — 무시됨)
    """
    durations = [probe_duration(s["path"]) for s in segments]
    tempos, starts, dur_used = [], [], []
    cur_t = 0.0
    for i, _seg in enumerate(segments):
        natural = durations[i]
        tempos.append(1.0)        # atempo 없음
        dur_used.append(natural)
        starts.append(cur_t)
        cur_t += natural          # 순차 누적

    inputs, filters = [], []
    for i, seg in enumerate(segments):
        inputs.extend(["-i", str(seg["path"])])
        ms = int(starts[i] * 1000)
        filters.append(f"[{i}:a]adelay={ms}|{ms}[a{i}]")
    mix = "".join(f"[a{i}]" for i in range(len(segments)))
    fc = ";".join(filters) + f";{mix}amix=inputs={len(segments)}:normalize=0:duration=longest[out]"
    cmd = [FFMPEG, "-y", *inputs, "-filter_complex", fc,
           "-map", "[out]", "-c:a", "libmp3lame", "-b:a", "192k", str(output)]
    r = subprocess.run(cmd, capture_output=True)
    if r.returncode != 0:
        err = r.stderr.decode("utf-8", errors="replace")
        raise RuntimeError(f"ffmpeg error:\n{err[-1500:]}")
    return cur_t, tempos, starts, dur_used


def _job_dir(job_id):
    return TTS_DIR / job_id


def _load_meta(job_id):
    p = _job_dir(job_id) / "meta.json"
    if not p.exists():
        raise FileNotFoundError(f"job not found: {job_id}")
    return json.loads(p.read_text(encoding="utf-8"))


def _save_meta(job_id, meta):
    (_job_dir(job_id) / "meta.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def _state_response(meta):
    """meta.json → API 응답용 state."""
    job_id = meta["job_id"]
    # Supabase URL이 있으면 그것 사용, 없으면 로컬 fallback
    final_url = meta.get("supabase_url") or f"/api/tts/files/{job_id}/final.mp3"
    return {
        "job_id": job_id,
        "voice_name": meta["voice_name"],
        "model_id": meta["model_id"],
        "sentences": meta["sentences"],
        "tag_variants": meta.get("tag_variants", []),
        "strength_labels": STRENGTH_LABELS,
        "tempos": meta.get("tempos", []),
        "total_duration": meta.get("total_duration", 0),
        "char_count": meta.get("char_count", 0),
        "segment_count": len(meta["sentences"]),
        "final_url": final_url,
        "is_supabase": bool(meta.get("supabase_url")),
        "expires_in_sec": DEFAULT_TTL_SEC,
        "created_at": meta.get("created_at"),
    }


def _collect_directions(sentences):
    """Gemini로 매핑할 free-text direction만 수집 (explicit tag가 있으면 skip).
    Returns [(sent_idx, phrase_idx_or_None, direction)]."""
    collected = []
    for i, s in enumerate(sentences):
        phrases = s.get("phrases") or []
        if phrases:
            for j, p in enumerate(phrases):
                if (p.get("tag") or "").strip():
                    continue  # 명시적 tag 있으면 Gemini 패스
                d = (p.get("direction") or "").strip()
                if d:
                    collected.append((i, j, d))
        else:
            if (s.get("tag") or "").strip():
                continue
            d = (s.get("direction") or "").strip()
            if d:
                collected.append((i, None, d))
    return collected


def _resolve_tag(item, sent_idx, phrase_idx, tag_map):
    """phrase 또는 sentence의 effective tag — explicit tag 우선, 없으면 tag_map."""
    explicit = (item.get("tag") or "").strip()
    if explicit:
        return explicit
    return tag_map.get((sent_idx, phrase_idx), "")


def _build_synth_input(s, sent_idx, tag_map):
    """phrases가 있으면 inline-tagged text 조립, 없으면 plain text + outer tag.
    ElevenLabs v3는 텍스트 중간에 [tag] 삽입 시 그 시점부터 적용됨.
    Returns (text, outer_tag)."""
    phrases = s.get("phrases") or []
    if phrases:
        parts = []
        for j, p in enumerate(phrases):
            tag = _resolve_tag(p, sent_idx, j, tag_map)
            if tag:
                parts.append(f"{tag} {p['text']}")
            else:
                parts.append(p["text"])
        return " ".join(parts), ""  # outer는 비움 — 인라인이 다 핸들
    return s["text"], _resolve_tag(s, sent_idx, None, tag_map)


def _build_full_script_text(sentences, tag_map):
    """전체 스크립트를 단일 호출용 텍스트로 합침.
    문장마다 outer tag(+text) 혹은 인라인 태그 조립된 text를 공백으로 연결.
    voice 일관성 — eleven_v3가 호출마다 미세하게 voice가 흔들리는 문제 회피."""
    parts = []
    for i, s in enumerate(sentences):
        text, outer_tag = _build_synth_input(s, i, tag_map)
        parts.append(f"{outer_tag} {text}".strip() if outer_tag else text)
    return " ".join(parts)


def _rebuild_full_text_from_meta(sentences):
    """저장된 meta의 sentences에서 full text 재조립 (각 segment의 현재 tag 사용).
    regenerate 시 strength_level 반영된 tag를 그대로 활용."""
    parts = []
    for s in sentences:
        if s.get("phrases"):
            phrase_parts = []
            for p in s["phrases"]:
                tag = p.get("tag", "")
                phrase_parts.append(f"{tag} {p['text']}".strip() if tag else p["text"])
            text = " ".join(phrase_parts)
        else:
            tag = s.get("tag", "")
            text = f"{tag} {s['text']}".strip() if tag else s["text"]
        parts.append(text)
    return " ".join(parts)


def _full_synth(text, voice_id, model_id, out_path, voice_settings):
    """단일 호출로 전체 스크립트 합성. final.mp3 한 파일.
    eleven_v3는 호출 간 voice가 흔들려서 segment별 호출 불가 → 항상 단일 호출."""
    r = requests.post(
        f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}",
        headers={"xi-api-key": _eleven_key(), "Content-Type": "application/json"},
        json={
            "text": text,
            "model_id": model_id,
            "voice_settings": voice_settings,
        },
        timeout=600,  # 긴 스크립트 대비
    )
    if r.status_code != 200:
        raise RuntimeError(f"ElevenLabs error {r.status_code}: {r.text[:500]}")
    out_path.write_bytes(r.content)


def _approx_segment_timings(sentences, total_duration):
    """문장 길이 비례로 segment start/end 분배 (단일 호출 → segment별 정확 위치 알 수 없음).
    UI 타임라인용 근사값. 어절 모드는 phrases 합산 길이로."""
    def sent_len(s):
        if s.get("phrases"):
            return sum(len(p.get("text", "")) for p in s["phrases"])
        return len(s.get("text", ""))
    lens = [max(1, sent_len(s)) for s in sentences]
    total = sum(lens)
    timings = []
    cum = 0.0
    for L in lens:
        dur = total_duration * (L / total)
        timings.append((round(cum, 2), round(cum + dur, 2)))
        cum += dur
    return timings


MIN_TOTAL_CHARS = 5  # ElevenLabs v3 hallucination 방어 — 짧은 입력은 환각으로 다른 단어 생성


def build_persona_cue(persona):
    """페르소나 dict → ElevenLabs v3 voice 톤 가이드용 인라인 cue.
    첫 문장 앞에 prepend되며 모델은 cue를 발화 안 하고 톤만 조정.
    예: '(알뜰살뜰 대학생 지수, 여성)' → joonpark voice가 여성 톤으로 시프트.

    형식: '(name 정리, 성별)' — name에서 '#숫자' suffix 제거.
    성별 unknown이면 name만."""
    if not persona:
        return None
    name = (persona.get("name") or "").strip()
    name = re.sub(r"\s*#\d+\s*$", "", name).strip()
    if not name:
        return None
    gender = (persona.get("gender") or "").lower()
    if gender == "female":
        return f"({name}, 여성)"
    if gender == "male":
        return f"({name}, 남성)"
    return f"({name})"


def _sanitize_sentences(sentences):
    """입력 정리:
    1) sentence.text strip — 빈/공백 only면 제거 안 함 (sentence 자체 제거는 의도 위험)
    2) phrase.text strip + 빈 phrase 자동 제거 — 빈 phrase가 audio tag 누수시킴
    3) phrases 다 비면 phrase 모드 해제 (plain text로 폴백)"""
    cleaned = []
    for s in sentences:
        s2 = dict(s)
        s2["text"] = (s2.get("text") or "").strip()
        phrases = s2.get("phrases") or []
        if phrases:
            filtered = []
            for p in phrases:
                pt = (p.get("text") or "").strip()
                if not pt:
                    continue
                p2 = dict(p)
                p2["text"] = pt
                filtered.append(p2)
            if filtered:
                s2["phrases"] = filtered
            else:
                s2.pop("phrases", None)  # 모든 phrase가 빈 거였음 → 일반 모드
        cleaned.append(s2)
    return cleaned


def synthesize_script(sentences, voice_name="joonpark", model_id="eleven_v3",
                     emotion_strength=DEFAULT_EMOTION, persona=None):
    """전체 합성. job 폴더 생성하고 meta.json + 모든 seg + final.mp3 저장.
    어절별 감정: sentence.phrases = [{text, direction}] 형태일 때 inline tag로 합성.
    persona 전달 시 build_persona_cue로 인라인 cue 첫 문장 앞에 prepend — voice 톤 시프트."""
    if voice_name not in PRESETS:
        raise ValueError(f"unknown voice preset: {voice_name}. choices: {list(PRESETS.keys())}")
    voice_id = PRESETS[voice_name]["id"]

    # 입력 정리 + 최소 길이 검증 (v3 hallucination 방어)
    sentences = _sanitize_sentences(sentences)
    total_chars = sum(len(s["text"]) for s in sentences)
    if total_chars < MIN_TOTAL_CHARS:
        raise ValueError(
            f"텍스트 너무 짧음 ({total_chars}자) — 최소 {MIN_TOTAL_CHARS}자 이상 필요. "
            f"ElevenLabs v3는 짧은 입력에서 환각으로 다른 단어 생성함."
        )

    job_id = f"job_{int(time.time())}_{voice_name}"
    job_dir = _job_dir(job_id)
    job_dir.mkdir(parents=True, exist_ok=True)

    # 문장 + 어절 direction 모두 한 번에 Gemini batch
    collected = _collect_directions(sentences)
    all_dirs = [d for _, _, d in collected]
    all_tags = map_directions(all_dirs) if all_dirs else []
    tag_map = {(si, pi): all_tags[k] for k, (si, pi, _) in enumerate(collected)}

    # tag_variants는 phrase 없는 문장에만 의미 있음 (외부 tag 5단계 변환용)
    # phrase 모드는 strength 조절 불가 → variants=None 마커
    tag_variants = []
    for i, s in enumerate(sentences):
        if s.get("phrases"):
            tag_variants.append(None)
        else:
            t = tag_map.get((i, None), "")
            tag_variants.append(["", "", t, "", ""])
    voice_settings = emotion_to_voice_settings(emotion_strength)

    # 단일 호출용 full text 조립 (voice 일관성 — v3는 호출마다 voice 흔들림)
    full_text = _build_full_script_text(sentences, tag_map)
    # 페르소나 cue 인라인 prepend — voice 톤을 페르소나에 맞게 시프트 (joonpark도 여성 가능)
    persona_cue = build_persona_cue(persona)
    if persona_cue:
        full_text = f"{persona_cue} {full_text}"

    # 문장별 메타 (UI 표시용; per-segment mp3는 없음)
    sent_meta = []
    total_chars = len(full_text)
    for i, s in enumerate(sentences):
        text, outer_tag = _build_synth_input(s, i, tag_map)
        phrases_meta = None
        if s.get("phrases"):
            phrases_meta = [
                {
                    "text": p["text"],
                    "direction": p.get("direction", ""),
                    "tag": _resolve_tag(p, i, j, tag_map),
                }
                for j, p in enumerate(s["phrases"])
            ]
        sm = {
            "start": float(s["start"]),
            "end": float(s["end"]),
            "text": s["text"],
            "direction": s.get("direction", ""),
            "tag": outer_tag,
            "strength_level": 0,
        }
        if phrases_meta is not None:
            sm["phrases"] = phrases_meta
        sent_meta.append(sm)

    final_path = job_dir / "final.mp3"
    _full_synth(full_text, voice_id, model_id, final_path, voice_settings)
    total_duration = probe_duration(final_path)

    # 문장 길이 비례로 start/end 근사 분배 (UI 타임라인용)
    timings = _approx_segment_timings(sentences, total_duration)
    for i, sm in enumerate(sent_meta):
        if i < len(timings):
            sm["start"], sm["end"] = timings[i]

    # Supabase Storage 업로드 → public URL
    supabase_url = _upload_final_to_supabase(job_id, final_path)

    meta = {
        "job_id": job_id,
        "voice_id": voice_id,
        "voice_name": voice_name,
        "model_id": model_id,
        "created_at": int(time.time()),
        "sentences": sent_meta,
        "tag_variants": tag_variants,
        "base_emotion_strength": emotion_strength,
        "tempos": [1.0] * len(sentences),  # 단일 호출이라 atempo 의미 없음
        "total_duration": round(total_duration, 2),
        "char_count": total_chars,
        "supabase_url": supabase_url,
        "persona_cue": persona_cue,  # regenerate_segment에서 재사용
    }
    _save_meta(job_id, meta)
    return _state_response(meta)


def _ensure_variants_for_segment(meta, idx):
    """variants[idx] 중 base가 아닌 셀이 비어있으면 Gemini 호출로 5단계 채움 (lazy).
    이미 다 채워져 있으면 no-op."""
    sentences = meta["sentences"]
    variants = meta.get("tag_variants") or [["", "", "", "", ""] for _ in sentences]
    while len(variants) <= idx:
        variants.append(["", "", "", "", ""])
    row = variants[idx] if idx < len(variants) else ["", "", "", "", ""]
    # base 외에 빈 셀이 있는지
    needs_expand = any(not t for j, t in enumerate(row) if j != 2)
    if not needs_expand and row[2]:
        return False
    direction = sentences[idx].get("direction") or sentences[idx].get("text", "")
    base_tag = row[2] or sentences[idx].get("tag", "")
    new_row = expand_direction_to_variants(direction, base_tag)
    variants[idx] = new_row
    meta["tag_variants"] = variants
    return True


def regenerate_segment(job_id: str, idx: int, strength_level: int):
    """한 segment 강도 변경 → 전체 스크립트 재합성 (단일 호출이라 부분 재합성 불가).
    strength_level: -2 (매우 약) ~ +2 (매우 강).
    base 외 강도 처음 호출 시 해당 segment의 5단계 variants를 lazy로 Gemini가 채움."""
    if not isinstance(strength_level, int) or strength_level < -2 or strength_level > 2:
        raise ValueError(f"strength_level은 -2 ~ +2 정수, got {strength_level}")
    meta = _load_meta(job_id)
    sentences = meta["sentences"]
    if idx < 0 or idx >= len(sentences):
        raise ValueError(f"idx out of range: {idx} (총 {len(sentences)}개)")
    if sentences[idx].get("phrases"):
        raise ValueError("어절 모드 문장은 강도 조절 미지원 — 어절별 direction을 직접 수정하세요")

    if strength_level != 0:
        _ensure_variants_for_segment(meta, idx)

    variants = meta.get("tag_variants") or []
    row = variants[idx] if idx < len(variants) else ["", "", sentences[idx].get("tag", ""), "", ""]
    new_tag = row[strength_level + 2] or row[2] or sentences[idx].get("tag", "")

    sentences[idx]["strength_level"] = strength_level
    sentences[idx]["tag"] = new_tag

    # 전체 재합성 (voice 일관성 위해 단일 호출 고수)
    full_text = _rebuild_full_text_from_meta(sentences)
    # 페르소나 cue 동일하게 유지
    persona_cue = meta.get("persona_cue")
    if persona_cue:
        full_text = f"{persona_cue} {full_text}"
    voice_settings = emotion_to_voice_settings(meta.get("base_emotion_strength", DEFAULT_EMOTION))
    final_path = _job_dir(job_id) / "final.mp3"
    _full_synth(full_text, meta["voice_id"], meta["model_id"], final_path, voice_settings)
    total_duration = probe_duration(final_path)

    timings = _approx_segment_timings(sentences, total_duration)
    for i, sm in enumerate(sentences):
        if i < len(timings):
            sm["start"], sm["end"] = timings[i]

    supabase_url = _upload_final_to_supabase(job_id, final_path)

    meta["sentences"] = sentences
    meta["tempos"] = [1.0] * len(sentences)
    meta["total_duration"] = round(total_duration, 2)
    meta["char_count"] = len(full_text)
    meta["supabase_url"] = supabase_url
    meta["updated_at"] = int(time.time())
    _save_meta(job_id, meta)
    return _state_response(meta)


def get_job(job_id: str):
    return _state_response(_load_meta(job_id))


def cleanup_old_files(ttl_sec=DEFAULT_TTL_SEC):
    """tts/ 안의 job_<unix>_* 폴더 + 구버전 tts_*.mp3 중 TTL 초과 항목 삭제."""
    if not TTS_DIR.exists():
        return 0
    now = time.time()
    deleted = 0
    for p in TTS_DIR.iterdir():
        if p.is_dir() and re.match(r"^job_\d{8,}_", p.name):
            if now - p.stat().st_mtime > ttl_sec:
                try:
                    shutil.rmtree(p)
                    deleted += 1
                except OSError:
                    pass
        elif p.is_file() and re.match(r"^tts_\d{8,}_.*\.mp3$", p.name):
            # 구버전 호환 (기존 단일 mp3)
            if now - p.stat().st_mtime > ttl_sec:
                try:
                    p.unlink()
                    deleted += 1
                except OSError:
                    pass
    return deleted


def file_path(job_id_or_filename: str, filename: str = None):
    """안전 검증된 mp3 경로 반환.
    호출 형태:
      file_path("job_xxx_yuna", "final.mp3")
      file_path("job_xxx_yuna", "seg_002.mp3")
      file_path("tts_xxx.mp3")  # 구버전 호환
    """
    if filename is not None:
        # job 모드
        job_id = job_id_or_filename
        if not re.match(r"^job_\d{8,}_[\w]+$", job_id):
            return None
        if "/" in filename or "\\" in filename or ".." in filename:
            return None
        if not (filename == "final.mp3" or re.match(r"^seg_\d{3}\.mp3$", filename)):
            return None
        p = TTS_DIR / job_id / filename
    else:
        # 구버전: 단일 파일
        fn = job_id_or_filename
        if "/" in fn or "\\" in fn or ".." in fn:
            return None
        if not fn.startswith("tts_") or not fn.endswith(".mp3"):
            return None
        p = TTS_DIR / fn
    return p if p.exists() else None
