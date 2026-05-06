"""로컬 thumbs/*.jpg → WebP 변환 → Supabase Storage `thumbs` 버킷 일괄 업로드.

전제: .env에 SUPABASE_SERVICE_ROLE_KEY 추가됨.
실행: python backfill_thumbs.py [--limit 100]
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed
from dotenv import load_dotenv

ROOT = Path(__file__).parent
load_dotenv(ROOT / ".env")

sys.path.insert(0, str(ROOT))
from api.services import thumb  # noqa: E402


def upload_one(jpg_path: Path) -> tuple[str, str]:
    """jpg → webp → storage. 반환: (shortcode, status)"""
    shortcode = jpg_path.stem
    if thumb.exists_in_storage(shortcode):
        return shortcode, "skip_existing"
    try:
        jpg_bytes = jpg_path.read_bytes()
        webp = thumb._to_webp(jpg_bytes)
        ok = thumb._upload_to_storage(shortcode, webp)
        if ok:
            # 로컬도 webp로 업그레이드
            (jpg_path.parent / f"{shortcode}.webp").write_bytes(webp)
            return shortcode, "uploaded"
        return shortcode, "upload_failed"
    except Exception as e:
        return shortcode, f"error: {e}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0, help="최대 처리 개수 (0=무제한)")
    ap.add_argument("--workers", type=int, default=8)
    args = ap.parse_args()

    thumb_dir = ROOT / "thumbs"
    if not thumb_dir.exists():
        sys.exit(f"thumbs 폴더 없음: {thumb_dir}")

    jpgs = sorted(thumb_dir.glob("*.jpg"))
    if args.limit > 0:
        jpgs = jpgs[:args.limit]

    if not jpgs:
        print("처리할 .jpg 파일 없음")
        return

    print(f"총 {len(jpgs)}개 jpg → WebP 변환 + Storage 업로드 시작")
    counts = {"uploaded": 0, "skip_existing": 0, "upload_failed": 0, "error": 0}

    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futures = [ex.submit(upload_one, p) for p in jpgs]
        for i, f in enumerate(as_completed(futures), 1):
            sc, status = f.result()
            key = "error" if status.startswith("error") else status
            counts[key] = counts.get(key, 0) + 1
            if i % 50 == 0 or i == len(jpgs):
                print(f"  진행 {i}/{len(jpgs)}  {counts}")

    print(f"\n결과: {counts}")


if __name__ == "__main__":
    main()
