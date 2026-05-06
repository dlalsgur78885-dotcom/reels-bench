"""Supabase Storage `frames` 버킷에 frame jpg 업로드 헬퍼.

pipeline.run() 분석 도중 호출 → Vercel 배포본에서도 프레임 이미지 표시.
"""
from __future__ import annotations

import os
import logging
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor

import requests
from dotenv import load_dotenv

logger = logging.getLogger(__name__)

ENV_PATH = Path(__file__).parent.parent.parent / ".env"
load_dotenv(ENV_PATH)

SUPA = os.getenv("SUPABASE_URL")
KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_ANON_KEY")
BUCKET = "frames"


def _to_webp(jpg_bytes: bytes, quality: int = 82) -> bytes:
    import io
    from PIL import Image
    img = Image.open(io.BytesIO(jpg_bytes)).convert("RGB")
    buf = io.BytesIO()
    img.save(buf, format="WEBP", quality=quality, method=6)
    return buf.getvalue()


def _upload_one(sc: str, n: int, jpg_bytes: bytes) -> bool:
    if not SUPA or not KEY:
        return False
    try:
        webp_bytes = _to_webp(jpg_bytes)
        r = requests.post(
            f"{SUPA}/storage/v1/object/{BUCKET}/{sc}/{n}.webp",
            headers={
                "Authorization": f"Bearer {KEY}",
                "apikey": KEY,
                "Content-Type": "image/webp",
                "x-upsert": "true",
                "Cache-Control": "max-age=31536000, immutable",
            },
            data=webp_bytes,
            timeout=15,
        )
        return r.status_code in (200, 201)
    except Exception as e:
        logger.warning("frame upload error %s/%s: %s", sc, n, e)
        return False


def upload_dir(shortcode: str, frames_dir: Path, workers: int = 8) -> int:
    """frames_dir/<n>.jpg → WebP 변환 후 Storage에 일괄 업로드. 성공 개수 반환."""
    if not SUPA or not KEY:
        return 0
    files = sorted(frames_dir.glob("*.jpg"))
    if not files:
        return 0

    def _task(fp: Path) -> bool:
        try:
            n = int(fp.stem)
        except ValueError:
            return False
        return _upload_one(shortcode, n, fp.read_bytes())

    with ThreadPoolExecutor(max_workers=workers) as ex:
        results = list(ex.map(_task, files))
    ok = sum(1 for r in results if r)
    logger.info("frames uploaded %s: %d/%d", shortcode, ok, len(files))
    return ok
