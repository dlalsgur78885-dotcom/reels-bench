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
    "yuna":     {"id": "xi3rF0t7dg7uN2M0WUhr", "label": "Yuna (여성, 부드러움)"},
    "han_aim":  {"id": "8jHHF8rMqMlg8if2mOUe", "label": "Han Aim (여성, 캐주얼)"},
    "jennie":   {"id": "z6Kj0hecH20CdetSElRT", "label": "Jennie (여성, 자신감)"},
    "male":     {"id": "oezp1w0IATNLah6Gnq1W", "label": "숏폼 남성"},
    "joonpark": {"id": "7Nah3cbXKVmGX7gQUuwz", "label": "JoonPark (남성, professional)"},
}

DEFAULT_TTL_SEC = 7200  # 2시간 (로컬 임시 캐시 — 결과는 Supabase에 영구 보관)
DEFAULT_EMOTION = 0.5   # 슬라이더 50 (= 기본값)
TTS_BUCKET = "tts-files"  # Supabase Storage bucket (public)


def _upload_final_to_supabase(job_id, local_path):
    """final.mp3를 Supabase Storage에 업로드 → public URL 반환. 실패 시 None."""
    from services import supabase as sb
    sb.storage_create_bucket(TTS_BUCKET, public=True)  # idempotent
    remote_path = f"{job_id}/final.mp3"
    try:
        data = local_path.read_bytes()
    except OSError as e:
        raise RuntimeError(f"final.mp3 read failed: {e}")
    ok, err = sb.storage_upload(TTS_BUCKET, remote_path, data, content_type="audio/mpeg", upsert=True)
    if not ok:
        raise RuntimeError(f"Supabase Storage upload 실패: {err}")
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
    strength=0.0 → 담백 (style=0, stab=0.7)
    strength=0.5 → 기본 (style=0.3, stab=0.35)
    strength=1.0 → 격앙 (style=0.7, stab=0.15)"""
    s = max(0.0, min(1.0, strength))
    return {
        "stability": round(0.7 - s * 0.55, 4),
        "similarity_boost": 0.75,
        "style": round(s * 0.7, 4),
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


def synth_segment(text, tag, voice_id, model_id, out_path, voice_settings=None):
    if voice_settings is None:
        voice_settings = emotion_to_voice_settings(DEFAULT_EMOTION)
    tagged = f"{tag} {text}".strip()
    r = requests.post(
        f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}",
        headers={"xi-api-key": _eleven_key(), "Content-Type": "application/json"},
        json={
            "text": tagged,
            "model_id": model_id,
            "voice_settings": voice_settings,
        },
        timeout=180,
    )
    if r.status_code != 200:
        raise RuntimeError(f"ElevenLabs error {r.status_code}: {r.text[:500]}")
    out_path.write_bytes(r.content)


def probe_duration(path):
    r = subprocess.run([FFMPEG, "-i", str(path), "-f", "null", "-"], capture_output=True)
    err = r.stderr.decode("utf-8", errors="replace")
    m = re.search(r"Duration: (\d+):(\d+):(\d+\.\d+)", err)
    if not m:
        return 0.0
    h, mn, s = m.groups()
    return int(h) * 3600 + int(mn) * 60 + float(s)


def merge_segments(segments, output, max_speedup=2.0):
    """순차 atempo strict — 슬롯 초과 시 최대 max_speedup까지 압축."""
    durations = [probe_duration(s["path"]) for s in segments]
    tempos, starts, dur_used = [], [], []
    cur_t = 0.0
    for i, seg in enumerate(segments):
        slot = float(seg["end"]) - float(seg["start"])
        natural = durations[i]
        if natural <= slot or slot <= 0:
            tempo, new_dur = 1.0, natural
        else:
            tempo = min(natural / slot, max_speedup)
            new_dur = natural / tempo
        tempos.append(tempo)
        dur_used.append(new_dur)
        st = max(float(seg["start"]), cur_t)
        starts.append(st)
        cur_t = st + new_dur

    inputs, filters = [], []
    for i, seg in enumerate(segments):
        inputs.extend(["-i", str(seg["path"])])
        ms = int(starts[i] * 1000)
        if tempos[i] > 1.001:
            filters.append(f"[{i}:a]atempo={tempos[i]:.4f},adelay={ms}|{ms}[a{i}]")
        else:
            filters.append(f"[{i}:a]adelay={ms}|{ms}[a{i}]")
    mix = "".join(f"[a{i}]" for i in range(len(segments)))
    fc = ";".join(filters) + f";{mix}amix=inputs={len(segments)}:normalize=0:duration=longest[out]"
    cmd = [FFMPEG, "-y", *inputs, "-filter_complex", fc,
           "-map", "[out]", "-c:a", "libmp3lame", "-b:a", "192k", str(output)]
    r = subprocess.run(cmd, capture_output=True)
    if r.returncode != 0:
        err = r.stderr.decode("utf-8", errors="replace")
        raise RuntimeError(f"ffmpeg error:\n{err[-1500:]}")
    return cur_t, tempos


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


def synthesize_script(sentences, voice_name="yuna", model_id="eleven_v3",
                     emotion_strength=DEFAULT_EMOTION):
    """전체 합성. job 폴더 생성하고 meta.json + 모든 seg + final.mp3 저장."""
    if voice_name not in PRESETS:
        raise ValueError(f"unknown voice preset: {voice_name}. choices: {list(PRESETS.keys())}")
    voice_id = PRESETS[voice_name]["id"]

    job_id = f"job_{int(time.time())}_{voice_name}"
    job_dir = _job_dir(job_id)
    job_dir.mkdir(parents=True, exist_ok=True)

    directions = [s.get("direction", "") for s in sentences]
    base_tags = map_directions(directions)  # 단일 tag per direction (Gemini 1회)
    # tag_variants는 base만 채우고 나머지는 lazy로 채움 — 비용 절감
    tag_variants = [["", "", t, "", ""] for t in base_tags]
    voice_settings = emotion_to_voice_settings(emotion_strength)

    sent_meta = []
    seg_paths = []
    total_chars = 0
    for i, s in enumerate(sentences):
        out = job_dir / f"seg_{i:03d}.mp3"
        tag = base_tags[i]
        synth_segment(s["text"], tag, voice_id, model_id, out, voice_settings)
        total_chars += len(f"{tag} {s['text']}".strip())
        sent_meta.append({
            "start": float(s["start"]),
            "end": float(s["end"]),
            "text": s["text"],
            "direction": s.get("direction", ""),
            "tag": tag,
            "strength_level": 0,  # -2 ~ +2
        })
        seg_paths.append({"path": out, "start": float(s["start"]), "end": float(s["end"])})

    final_path = job_dir / "final.mp3"
    total_duration, tempos = merge_segments(seg_paths, final_path)

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
        "tempos": [round(t, 3) for t in tempos],
        "total_duration": round(total_duration, 2),
        "char_count": total_chars,
        "supabase_url": supabase_url,
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
    """한 segment를 새 강도(level) tag로 재합성 + final.mp3 재합치기.
    strength_level: -2 (매우 약) ~ +2 (매우 강).
    base 외 강도 처음 호출 시 해당 segment의 5단계 variants를 lazy로 Gemini가 채움."""
    if not isinstance(strength_level, int) or strength_level < -2 or strength_level > 2:
        raise ValueError(f"strength_level은 -2 ~ +2 정수, got {strength_level}")
    meta = _load_meta(job_id)
    sentences = meta["sentences"]
    if idx < 0 or idx >= len(sentences):
        raise ValueError(f"idx out of range: {idx} (총 {len(sentences)}개)")

    if strength_level != 0:
        _ensure_variants_for_segment(meta, idx)

    variants = meta.get("tag_variants") or []
    row = variants[idx] if idx < len(variants) else ["", "", sentences[idx].get("tag", ""), "", ""]
    new_tag = row[strength_level + 2] or row[2] or sentences[idx].get("tag", "")

    s = sentences[idx]
    voice_settings = emotion_to_voice_settings(meta.get("base_emotion_strength", DEFAULT_EMOTION))
    seg_path = _job_dir(job_id) / f"seg_{idx:03d}.mp3"

    synth_segment(s["text"], new_tag, meta["voice_id"], meta["model_id"],
                  seg_path, voice_settings)
    sentences[idx]["strength_level"] = strength_level
    sentences[idx]["tag"] = new_tag

    seg_paths = []
    for i, sm in enumerate(sentences):
        seg_paths.append({
            "path": _job_dir(job_id) / f"seg_{i:03d}.mp3",
            "start": float(sm["start"]),
            "end": float(sm["end"]),
        })
    final_path = _job_dir(job_id) / "final.mp3"
    total_duration, tempos = merge_segments(seg_paths, final_path)

    # Supabase Storage에 새 final.mp3 업로드 (overwrite)
    supabase_url = _upload_final_to_supabase(job_id, final_path)

    meta["sentences"] = sentences
    meta["tempos"] = [round(t, 3) for t in tempos]
    meta["total_duration"] = round(total_duration, 2)
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
