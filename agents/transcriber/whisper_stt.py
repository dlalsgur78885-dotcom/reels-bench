"""Whisper STT via OpenAI API"""

import os
import requests
from pathlib import Path
from dotenv import load_dotenv

ENV_PATH = Path(__file__).parent.parent.parent / ".env"
load_dotenv(ENV_PATH)

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")


def transcribe(audio_path):
    """Audio → transcript + segments with timestamps"""
    if not OPENAI_API_KEY or not audio_path:
        return None

    with open(audio_path, "rb") as f:
        resp = requests.post(
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

    if resp.status_code == 200:
        result = resp.json()
        return {
            "transcript": result.get("text", ""),
            "duration_seconds": result.get("duration", 0),
            "language": result.get("language", "ko"),
            "segments": result.get("segments", []),
        }
    return None
