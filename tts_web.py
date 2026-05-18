"""TTS Web Service — Render 배포용 (Python + ffmpeg).

ElevenLabs v3 합성 + 슬롯 길이 매칭(atempo) + Supabase Storage 업로드.
api.services.elevenlabs를 그대로 활용하고, TTS endpoint만 노출.
"""
from __future__ import annotations
import logging
import os
import sys
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel

ROOT = Path(__file__).parent
load_dotenv(ROOT / ".env")
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "api"))

from api.services import elevenlabs as tts_svc  # noqa: E402

logger = logging.getLogger("uvicorn.error")

app = FastAPI(title="tts-worker")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class TtsSynthRequest(BaseModel):
    sentences: list[dict]
    voice_name: str = "yuna"
    model_id: str = "eleven_v3"
    emotion_strength: float = 0.5
    persona: dict | None = None  # name, gender → 인라인 cue로 voice 톤 시프트
    speed_factor: float = 1.0  # atempo 후처리 (1.0=자연, >1.0=가속)
    target_duration: float | None = None  # 주어지면 자동 speed_factor 계산
    segment_match: bool = False  # segment별 atempo로 REF 정밀 매칭


class TtsSegmentRequest(BaseModel):
    job_id: str
    idx: int
    strength_level: int


@app.get("/")
@app.get("/api/health")
def health():
    return {"ok": True, "service": "tts-worker"}


@app.get("/api/tts/voices")
def voices():
    return {
        "presets": [
            {"value": k, "label": v["label"], "accepts": v.get("accepts", "any")}
            for k, v in tts_svc.PRESETS.items()
        ],
        "ttl_sec": tts_svc.DEFAULT_TTL_SEC,
    }


class TtsAutoEmotionRequest(BaseModel):
    sentences: list[dict]
    intensity: str = "medium"  # low / medium / high


@app.post("/api/tts/auto-emotion")
def auto_emotion(req: TtsAutoEmotionRequest):
    """입력 문장들에 LLM으로 어절 감정 자동 할당."""
    if not req.sentences:
        raise HTTPException(400, "sentences 비어있음")
    try:
        result = tts_svc.analyze_phrase_emotion(req.sentences, req.intensity)
        logger.info("[tts/auto-emotion] OK count=%d intensity=%s", len(result), req.intensity)
        return {"sentences": result}
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        logger.error("[tts/auto-emotion] FAILED: %s", e)
        raise HTTPException(500, f"감정 분석 실패: {e}")


@app.post("/api/tts/synthesize")
def synthesize(req: TtsSynthRequest):
    if not req.sentences:
        raise HTTPException(400, "sentences 비어있음")
    if req.voice_name not in tts_svc.PRESETS:
        raise HTTPException(400, f"unknown voice preset: {req.voice_name}")
    try:
        tts_svc.cleanup_old_files()
        result = tts_svc.synthesize_script(
            sentences=req.sentences,
            voice_name=req.voice_name,
            model_id=req.model_id,
            emotion_strength=req.emotion_strength,
            persona=req.persona,
            speed_factor=req.speed_factor,
            target_duration=req.target_duration,
            segment_match=req.segment_match,
        )
        logger.info(
            "[tts/synth] OK job=%s voice=%s segs=%d chars=%d dur=%.1fs",
            result["job_id"], req.voice_name, result["segment_count"],
            result["char_count"], result["total_duration"],
        )
        return result
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        logger.error("[tts/synth] FAILED: %s", e)
        raise HTTPException(500, f"TTS 합성 실패: {e}")


@app.post("/api/tts/segment")
def regenerate_segment(req: TtsSegmentRequest):
    if not isinstance(req.strength_level, int) or req.strength_level < -2 or req.strength_level > 2:
        raise HTTPException(400, "strength_level은 -2 ~ +2 정수")
    try:
        result = tts_svc.regenerate_segment(req.job_id, req.idx, req.strength_level)
        logger.info(
            "[tts/segment] OK job=%s idx=%d level=%+d",
            req.job_id, req.idx, req.strength_level,
        )
        return result
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        logger.error("[tts/segment] FAILED: %s", e)
        raise HTTPException(500, f"문장 재합성 실패: {e}")


class TtsApplySpeedsRequest(BaseModel):
    job_id: str
    speeds: dict[str, float]


@app.post("/api/tts/apply-speeds")
def apply_speeds(req: TtsApplySpeedsRequest):
    """post-synth sentence별 speed_factor 일괄 적용 — 재합성 없이 ffmpeg atempo만."""
    try:
        speeds_int = {int(k): float(v) for k, v in (req.speeds or {}).items()}
        result = tts_svc.apply_segment_speeds(req.job_id, speeds_int)
        logger.info("[tts/apply-speeds] OK job=%s n=%d", req.job_id, len(speeds_int))
        return result
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        logger.error("[tts/apply-speeds] FAILED: %s", e)
        raise HTTPException(500, f"속도 적용 실패: {e}")


@app.get("/api/tts/job/{job_id}")
def job_state(job_id: str):
    try:
        return tts_svc.get_job(job_id)
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))


@app.get("/api/tts/files/{job_id}/{filename}")
def download(job_id: str, filename: str):
    """로컬 fallback (Supabase 업로드 실패 시). 일반적으로 Supabase URL을 직접 사용."""
    p = tts_svc.file_path(job_id, filename)
    if not p:
        raise HTTPException(404, "file not found or expired")
    return FileResponse(str(p), media_type="audio/mpeg", filename=filename)
