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
