"""Gemini 3 Pro 오디오 분석: 감정·BGM·효과음·나레이션 통합.

emotion.py (librosa pitch/SER + chromagram BGM)를 대체.
영상에서 mp3만 추출해 Pro에 넘김 → 토큰 60~70% 절감, 품질 향상.
"""
from __future__ import annotations

import os
import time
import json
import logging
import subprocess
import requests
from pathlib import Path
from dotenv import load_dotenv

logger = logging.getLogger(__name__)

ENV_PATH = Path(__file__).parent.parent.parent / ".env"
load_dotenv(ENV_PATH)

from . import secrets as secrets_svc


def _api_key() -> str:
    return secrets_svc.get_secret("GEMINI_API_KEY", "")


MODEL = "gemini-3.1-pro-preview"

try:
    import imageio_ffmpeg
    FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()
except Exception:
    FFMPEG = "ffmpeg"

_EMO_EMOJI = {
    # legacy 8
    "happy": "😊 기쁨", "excited": "🔥 신남", "sad": "😢 슬픔",
    "angry": "😠 분노", "fearful": "😨 공포", "surprised": "😲 놀람",
    "neutral": "😐 중립", "calm": "😌 차분",
    # v2 추가 6 (총 14)
    "crying": "😭 우는", "nervous": "😰 불안", "curious": "🤔 호기심",
    "serious": "😤 진지", "tired": "😴 피곤", "frustrated": "😩 좌절",
    "cheerful": "😄 명랑", "sarcastic": "🙃 비꼬는", "mischievously": "😏 장난스러운",
}

# v2 14태그 → legacy 8태그 매핑 (frontend 호환)
_EMO_LEGACY = {
    "happy": "happy", "excited": "excited", "sad": "sad", "angry": "angry",
    "fearful": "fearful", "surprised": "surprised", "neutral": "neutral", "calm": "calm",
    "crying": "sad", "nervous": "fearful", "curious": "surprised",
    "serious": "neutral", "tired": "calm", "frustrated": "angry",
    "cheerful": "happy", "sarcastic": "neutral", "mischievously": "excited",
}

_PROMPT_BASE = """이 인스타 릴스의 오디오를 분석해. JSON만 반환.

규칙:
- BGM 변화를 빠짐없이 추출. 같은 곡 내 섹션 전환(intro→verse→chorus)도 분위기 바뀌면 별도 구간.
- 무음/voiceover only 구간도 state: muted로 표시.
- 감정은 speech와 music을 모두 고려하고 근거를 reason에 적어.
- 효과음(swoosh, 벨, 폭발음, 웃음, 삐 소리 등) 타임스탬프와 의도를 기록.
- 감정 14태그: excited, happy, sad, crying, angry, nervous, curious, serious,
  tired, calm, frustrated, cheerful, sarcastic, mischievously
- delivery 5: whispers, shouts, slowly, very_fast, normal
- audio_events 8: laughs, laughing, sighs, clears_throat, gulps, gasps, pause, hesitates

{
  "duration_sec": <총 길이 초>,
  "sound_effects": [
    {"time": "MM:SS", "type": "효과음 종류", "description": "의도"}
  ],
  "bgm_segments": [
    {
      "start": "MM:SS", "end": "MM:SS",
      "state": "playing/muted/transition",
      "mood": "분위기",
      "genre": "장르",
      "tempo_bpm": <정수>,
      "volume_level": "high/medium/low/muted",
      "identified": "아티스트 - 곡명 또는 unknown",
      "change_reason": "왜 이전 구간과 다른지"
    }
  ],
  "emotion_timeline": [
    {
      "start": "MM:SS", "end": "MM:SS",
      "emotion": "<14태그 중 하나>",
      "intensity": 0.0~1.0,
      "delivery": "<5종 중 하나>",
      "source": "speech/music/both",
      "reason": "근거"
    }
  ],
  "audio_events": [
    {"time": "MM:SS", "event": "<8종 중 하나>", "reason": "근거"}
  ],
  __TTS_BLOCK__
  "narration": {"language": "언어", "tone": "톤", "pace": "빠르기"},
  "audio_summary": "전체 오디오 구성 한 줄"
}

순수 JSON만. 코드블록 쓰지 마."""

_TTS_BLOCK = """"tts_script": [
    {"start": "0.0", "end": "2.8",
     "direction": "부사(-게/-히/-며/-듯이) + 발화동사. 두 단어 조합.",
     "text": "원문 그대로"}
  ],
  """


def _build_prompt(whisper_segments: list | None) -> str:
    if whisper_segments:
        seg_text = "\n".join(
            f"[{s.get('start',0):.1f}-{s.get('end',0):.1f}] {s.get('text','').strip()}"
            for s in whisper_segments
        )
        tts_intro = (
            "\n\n# Whisper 세그먼트:\n"
            f"{seg_text}\n\n"
            "# 강제 룰\n"
            "- tts_script: 각 Whisper 세그먼트마다 발화 지시 1개 필수. "
            "**부사(-게/-히/-며/-듯이) + 발화동사** 두 단어 조합만. "
            "✓ OK: '차분하게 중얼거린다', '흥분되게 외친다', '한숨쉬며 말한다', '또박또박 말한다'. "
            "✗ 금지: '만족스러운 표정으로 평가한다', '차분한 목소리로 말한다' "
            "(명사+조사 형태 절대 X), '기쁘게 웃는다' (웃다는 발화동사 X).\n"
            "- emotion_timeline: **각 Whisper 세그먼트마다 emotion 구간 1개 이상 필수**. "
            "같은 문장 안에서 감정/delivery가 바뀌면 쪼개도 됨. "
            "전체가 비슷한 톤이라도 문장 단위로 분할 — 단일 구간으로 뭉치지 말 것.\n"
            "- audio_events: 실제로 들리는 것만. 없으면 빈 배열.\n"
        )
        return _PROMPT_BASE.replace("__TTS_BLOCK__", _TTS_BLOCK) + tts_intro
    return _PROMPT_BASE.replace("__TTS_BLOCK__", "")


def _mmss_to_sec(ts: str | int) -> int:
    if isinstance(ts, int):
        return ts
    try:
        parts = str(ts).split(":")
        if len(parts) == 2:
            return int(parts[0]) * 60 + int(parts[1])
        return int(ts)
    except Exception:
        return 0


def _extract_audio(video_path: str, out_path: str) -> bool:
    """영상에서 mp3 추출"""
    try:
        subprocess.run(
            [FFMPEG, "-y", "-i", video_path, "-vn", "-c:a", "libmp3lame",
             "-b:a", "128k", out_path],
            check=True, capture_output=True, timeout=120,
        )
        return Path(out_path).exists()
    except Exception as e:
        logger.warning("ffmpeg audio extract failed: %s", e)
        return False


def _upload_audio(audio_path: str) -> str | None:
    """Gemini Files API에 오디오 업로드 후 uri 반환. 실패 시 None."""
    size = Path(audio_path).stat().st_size
    try:
        start = requests.post(
            f"https://generativelanguage.googleapis.com/upload/v1beta/files?key={_api_key()}",
            headers={
                "X-Goog-Upload-Protocol": "resumable",
                "X-Goog-Upload-Command": "start",
                "X-Goog-Upload-Header-Content-Length": str(size),
                "X-Goog-Upload-Header-Content-Type": "audio/mpeg",
                "Content-Type": "application/json",
            },
            json={"file": {"display_name": Path(audio_path).name}},
            timeout=60,
        )
        start.raise_for_status()
        url = start.headers["X-Goog-Upload-URL"]
        with open(audio_path, "rb") as f:
            data = f.read()
        up = requests.post(
            url,
            headers={
                "Content-Length": str(size),
                "X-Goog-Upload-Offset": "0",
                "X-Goog-Upload-Command": "upload, finalize",
            },
            data=data, timeout=180,
        )
        up.raise_for_status()
        info = up.json()["file"]

        # 처리 완료 대기 (최대 30초)
        for _ in range(15):
            st = requests.get(
                f"https://generativelanguage.googleapis.com/v1beta/{info['name']}?key={_api_key()}",
                timeout=30,
            ).json()
            state = st.get("state")
            if state == "ACTIVE":
                return info["uri"]
            if state == "FAILED":
                logger.warning("Pro audio file processing FAILED: %s", st)
                return None
            time.sleep(2)
        logger.warning("Pro audio file processing timeout")
        return None
    except Exception as e:
        logger.warning("Pro audio upload error: %s", e)
        return None


def _call_pro(uri: str, whisper_segments: list | None = None) -> dict | None:
    prompt = _build_prompt(whisper_segments)
    for attempt in range(2):
        try:
            r = requests.post(
                f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent?key={_api_key()}",
                json={
                    "contents": [{"parts": [
                        {"file_data": {"mime_type": "audio/mpeg", "file_uri": uri}},
                        {"text": prompt},
                    ]}],
                    "generationConfig": {
                        "maxOutputTokens": 24000,
                        "responseMimeType": "application/json",
                    },
                },
                timeout=600,
            )
            if r.status_code == 200:
                body = r.json()
                text = body["candidates"][0]["content"]["parts"][0]["text"]
                try:
                    return json.loads(text)
                except json.JSONDecodeError:
                    # Gemini가 객체 두 개 이어붙이는 경우 → 첫 객체만 추출
                    dec = json.JSONDecoder()
                    parsed, _ = dec.raw_decode(text.lstrip())
                    return parsed
            elif r.status_code == 429:
                time.sleep(10)
            else:
                logger.warning("Pro audio call %s: %s", r.status_code, r.text[:500])
                return None
        except Exception as e:
            logger.warning("Pro audio call error: %s", e)
    return None


def _to_legacy_shape(pro: dict) -> tuple[dict, list]:
    """Pro 구간 데이터 → legacy per-second 포맷으로 변환 (프론트 호환용).

    audio_emotions: {sec: {pitch, volume, silence, emotion, label, confidence}}
    bgm_changes: [{sec, score}]
    """
    audio_emotions: dict[int, dict] = {}
    # Gemini가 [{...}] 리스트로 감싸서 반환할 때 unwrap
    if isinstance(pro, list):
        pro = pro[0] if pro and isinstance(pro[0], dict) else {}
    if not isinstance(pro, dict):
        return {}, []
    total_sec = int(pro.get("duration_sec") or 0)

    for seg in pro.get("emotion_timeline") or []:
        start = _mmss_to_sec(seg.get("start", 0))
        end = _mmss_to_sec(seg.get("end", start + 1))
        emo_v2 = seg.get("emotion", "neutral")
        emo_legacy = _EMO_LEGACY.get(emo_v2, "neutral")  # frontend는 legacy 8태그만 인식
        intensity = float(seg.get("intensity") or 0.5)
        for s in range(max(1, start + 1), end + 2):
            if total_sec and s > total_sec + 1:
                break
            audio_emotions[s] = {
                "pitch": 0,
                "volume": round(50 + intensity * 50, 1),
                "silence": False,
                "emotion": emo_legacy,
                "emotion_v2": emo_v2,  # 14태그 원본 (신규 frontend가 활용)
                "label": _EMO_EMOJI.get(emo_v2, f"❔ {emo_v2}"),
                "confidence": round(intensity, 2),
            }

    # muted 구간은 silence=True로 덮어쓰기
    for seg in pro.get("bgm_segments") or []:
        if seg.get("state") == "muted":
            start = _mmss_to_sec(seg.get("start", 0))
            end = _mmss_to_sec(seg.get("end", start + 1))
            for s in range(max(1, start + 1), end + 2):
                if s in audio_emotions:
                    audio_emotions[s]["silence"] = True
                    audio_emotions[s]["volume"] = 0

    # bgm_changes: 각 segment 경계(start)를 변화점으로
    bgm_changes = []
    prev_end = 0
    for idx, seg in enumerate(pro.get("bgm_segments") or []):
        start = _mmss_to_sec(seg.get("start", 0))
        if idx > 0:
            bgm_changes.append({"sec": start, "score": 1.0})
        prev_end = _mmss_to_sec(seg.get("end", start + 1))

    return audio_emotions, bgm_changes


def analyze_from_video(video_path: str, audio_path: str | None = None,
                       whisper_segments: list | None = None) -> dict:
    """영상 파일에서 오디오 추출 → Pro 분석 → 결과 반환.

    whisper_segments가 있으면 TTS direction(형용사+동사)도 함께 추출.

    반환 구조:
      {
        "pro_audio": <원본 Pro 응답 — emotion 14태그/delivery/audio_events/tts_script 포함>,
        "audio_emotions": <legacy per-sec>,
        "bgm_changes": <legacy 변화점>,
      }
    실패 시 빈 dict 반환.
    """
    if not _api_key():
        logger.warning("GEMINI_API_KEY not set, skip Pro audio")
        return {}

    # 오디오 추출
    if not audio_path:
        audio_path = video_path.rsplit(".", 1)[0] + ".mp3"
    if not Path(audio_path).exists():
        if not _extract_audio(video_path, audio_path):
            return {}

    uri = _upload_audio(audio_path)
    if not uri:
        return {}

    pro = _call_pro(uri, whisper_segments=whisper_segments)
    if not pro:
        return {}

    audio_emotions, bgm_changes = _to_legacy_shape(pro)
    return {
        "pro_audio": pro,
        "audio_emotions": audio_emotions,
        "bgm_changes": bgm_changes,
    }
