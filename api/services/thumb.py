"""Instagram thumbnail — WebP 변환 + Supabase Storage 영구 저장 + 로컬 fallback."""

import io
import os
import logging
import requests
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor

logger = logging.getLogger("uvicorn.error")

THUMB_DIR = Path(__file__).parent.parent.parent / "thumbs"
try:
    THUMB_DIR.mkdir(exist_ok=True)
except OSError:
    THUMB_DIR = Path("/tmp/thumbs")
    THUMB_DIR.mkdir(exist_ok=True)

_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
_WEBP_QUALITY = 80
_BUCKET = "thumbs"

# Supabase Storage 설정 (지연 로딩)
_SUPABASE_URL = None
_SERVICE_KEY = None


def _supabase_creds():
    global _SUPABASE_URL, _SERVICE_KEY
    if _SUPABASE_URL is None:
        from dotenv import load_dotenv
        load_dotenv(Path(__file__).parent.parent.parent / ".env")
        _SUPABASE_URL = os.getenv("SUPABASE_URL", "")
        _SERVICE_KEY = (
            os.getenv("SUPABASE_SERVICE_ROLE_KEY")
            or os.getenv("SUPABASE_ANON_KEY", "")
        )
    return _SUPABASE_URL, _SERVICE_KEY


def _webp_path(shortcode: str) -> Path:
    return THUMB_DIR / f"{shortcode}.webp"


def _legacy_jpg_path(shortcode: str) -> Path:
    return THUMB_DIR / f"{shortcode}.jpg"


def storage_url(shortcode: str) -> str:
    base, _ = _supabase_creds()
    return f"{base}/storage/v1/object/public/{_BUCKET}/{shortcode}.webp"


def _to_webp(jpg_bytes: bytes, quality: int = _WEBP_QUALITY) -> bytes:
    """JPEG 바이트 → WebP 바이트 (RGB 변환 + 손실 압축)."""
    from PIL import Image
    img = Image.open(io.BytesIO(jpg_bytes)).convert("RGB")
    buf = io.BytesIO()
    img.save(buf, format="WEBP", quality=quality, method=6)
    return buf.getvalue()


def _upload_to_storage(shortcode: str, webp_bytes: bytes) -> bool:
    """Supabase Storage `thumbs` 버킷에 PUT (upsert). 성공 시 True."""
    base, key = _supabase_creds()
    if not base or not key:
        return False
    url = f"{base}/storage/v1/object/{_BUCKET}/{shortcode}.webp"
    try:
        r = requests.post(
            url,
            headers={
                "Authorization": f"Bearer {key}",
                "apikey": key,
                "Content-Type": "image/webp",
                "x-upsert": "true",
            },
            data=webp_bytes,
            timeout=15,
        )
        if r.status_code in (200, 201):
            return True
        logger.warning(f"[Thumb] storage upload failed {r.status_code}: {r.text[:200]}")
        return False
    except Exception as e:
        logger.warning(f"[Thumb] storage upload error: {e}")
        return False


def _update_db_url(shortcode: str) -> bool:
    """DB의 reels_metadata.thumbnail_url을 영구 Storage URL로 update."""
    base, key = _supabase_creds()
    if not base or not key:
        return False
    new_url = storage_url(shortcode)
    try:
        r = requests.patch(
            f"{base}/rest/v1/reels_metadata?shortcode=eq.{shortcode}",
            headers={
                "apikey": key,
                "Authorization": f"Bearer {key}",
                "Content-Type": "application/json",
                "Prefer": "return=minimal",
            },
            json={"thumbnail_url": new_url},
            timeout=10,
        )
        return r.status_code in (200, 204)
    except Exception as e:
        logger.warning(f"[Thumb] db update error {shortcode}: {e}")
        return False


def exists_in_storage(shortcode: str, timeout: float = 3.0) -> bool:
    """Storage에 webp가 있는지 HEAD."""
    try:
        r = requests.head(storage_url(shortcode), timeout=timeout)
        return r.status_code == 200
    except Exception:
        return False


def exists(shortcode: str) -> bool:
    """로컬에 있는지 (.webp 우선, .jpg 레거시)."""
    return _webp_path(shortcode).is_file() or _legacy_jpg_path(shortcode).is_file()


def get_bytes(shortcode: str) -> tuple[bytes, str] | None:
    """로컬 파일 읽기. (bytes, content_type) 반환. 없으면 None."""
    wp = _webp_path(shortcode)
    if wp.is_file() and wp.stat().st_size > 200:
        return wp.read_bytes(), "image/webp"
    jp = _legacy_jpg_path(shortcode)
    if jp.is_file() and jp.stat().st_size > 500:
        return jp.read_bytes(), "image/jpeg"
    return None


def download(shortcode: str, url: str) -> bool:
    """인스타 CDN URL → 다운로드 → WebP 변환 → Storage 업로드 + DB url 영구화."""
    if not url:
        return False
    # Storage에 이미 있으면 DB만 업데이트 (혹시 누락됐을 수 있음)
    if exists_in_storage(shortcode):
        _update_db_url(shortcode)
        return True
    # 이미 storage URL이면 그것도 skip
    if "/storage/v1/object/public/thumbs/" in url:
        return True
    try:
        r = requests.get(url, timeout=10, headers={"User-Agent": _UA})
        if r.status_code != 200 or len(r.content) <= 500:
            return False
        webp = _to_webp(r.content)
        ok = _upload_to_storage(shortcode, webp)
        # 로컬 백업
        try:
            _webp_path(shortcode).write_bytes(webp)
        except Exception:
            pass
        # DB의 thumbnail_url을 storage URL로 영구화 → Vercel proxy가 알아서 가져옴
        if ok:
            _update_db_url(shortcode)
        return ok
    except Exception as e:
        logger.warning(f"[Thumb] download error {shortcode}: {e}")
        return False


def download_batch(items: list[tuple[str, str]], workers: int = 10) -> int:
    """여러 썸네일 다운로드 + 변환 + 업로드. items=[(shortcode, url), ...]"""
    missing = [
        (sc, url) for sc, url in items
        if url and not exists_in_storage(sc)
    ]
    if not missing:
        return 0
    logger.info(f"[Thumb] downloading {len(missing)} missing thumbnails...")
    with ThreadPoolExecutor(max_workers=workers) as ex:
        results = list(ex.map(lambda x: download(x[0], x[1]), missing))
    ok = sum(results)
    logger.info(f"[Thumb] downloaded {ok}/{len(missing)}")
    return ok


def count() -> int:
    """로컬 webp + jpg 파일 합계."""
    try:
        return sum(
            1 for f in THUMB_DIR.iterdir()
            if f.suffix in (".webp", ".jpg")
        )
    except Exception:
        return 0
