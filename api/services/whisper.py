"""Whisper STT via Groq API (whisper-large-v3)"""

import os
import requests
from pathlib import Path
from dotenv import load_dotenv

ENV_PATH = Path(__file__).parent.parent.parent / ".env"
load_dotenv(ENV_PATH)

GROQ_API_KEY = os.getenv("GROQ_API_KEY")

# Fallback to OpenAI if no Groq key
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")


def transcribe(audio_path):
    """Groq Whisper Large v3: audio → transcript + segments"""
    if GROQ_API_KEY:
        return _groq_transcribe(audio_path)
    if OPENAI_API_KEY:
        return _openai_transcribe(audio_path)
    return None


def _groq_transcribe(audio_path):
    if not audio_path:
        return None
    with open(audio_path, "rb") as f:
        r = requests.post(
            "https://api.groq.com/openai/v1/audio/transcriptions",
            headers={"Authorization": f"Bearer {GROQ_API_KEY}"},
            files={"file": (os.path.basename(audio_path), f, "audio/mpeg")},
            data={
                "model": "whisper-large-v3",
                "language": "ko",
                "response_format": "verbose_json",
                "timestamp_granularities[]": "segment",
            },
            timeout=120,
        )
    if r.status_code == 200:
        result = r.json()
        return {
            "transcript": result.get("text", ""),
            "duration_seconds": result.get("duration", 0),
            "language": result.get("language", "ko"),
            "segments": result.get("segments", []),
        }
    return None


def _openai_transcribe(audio_path):
    """Fallback: OpenAI Whisper API"""
    if not audio_path:
        return None
    with open(audio_path, "rb") as f:
        r = requests.post(
            "https://api.openai.com/v1/audio/transcriptions",
            headers={"Authorization": f"Bearer {OPENAI_API_KEY}"},
            files={"file": (os.path.basename(audio_path), f, "audio/mpeg")},
            data={
                "model": "whisper-1",
                "language": "ko",
                "response_format": "verbose_json",
                "timestamp_granularities[]": "segment",
            },
            timeout=120,
        )
    if r.status_code == 200:
        result = r.json()
        return {
            "transcript": result.get("text", ""),
            "duration_seconds": result.get("duration", 0),
            "language": result.get("language", "ko"),
            "segments": result.get("segments", []),
        }
    return None
