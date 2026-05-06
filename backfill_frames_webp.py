"""기존 frames/*.jpg → WebP 변환 후 다시 업로드 + 장기 캐시 헤더.

usage:
  python backfill_frames_webp.py            # 모든 reel
  python backfill_frames_webp.py --limit 30
  python backfill_frames_webp.py --workers 8 --keep-jpg
"""
from __future__ import annotations

import argparse
import io
import os
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import requests
from dotenv import load_dotenv
from PIL import Image

ROOT = Path(__file__).parent
load_dotenv(ROOT / ".env")
sys.path.insert(0, str(ROOT))

SUPA = os.getenv("SUPABASE_URL")
KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_ANON_KEY")
H = {"apikey": KEY, "Authorization": f"Bearer {KEY}"}
BUCKET = "frames"


def list_subdirs() -> list[str]:
    r = requests.post(
        f"{SUPA}/storage/v1/object/list/{BUCKET}",
        headers={**H, "Content-Type": "application/json"},
        json={"limit": 10000, "offset": 0, "prefix": ""},
        timeout=30,
    )
    rows = r.json() if r.status_code == 200 else []
    return [row["name"] for row in rows if row.get("name") and not row["name"].startswith(".")]


def list_jpgs(shortcode: str) -> list[str]:
    r = requests.post(
        f"{SUPA}/storage/v1/object/list/{BUCKET}",
        headers={**H, "Content-Type": "application/json"},
        json={"limit": 1000, "offset": 0, "prefix": shortcode},
        timeout=30,
    )
    rows = r.json() if r.status_code == 200 else []
    return [row["name"] for row in rows if row.get("name", "").lower().endswith(".jpg")]


def _retry(fn, *args, attempts=3, **kwargs):
    last = None
    import time as _t
    for i in range(attempts):
        try:
            return fn(*args, **kwargs)
        except Exception as e:
            last = e
            _t.sleep(1.5 * (i + 1))
    raise last


def convert_one(sc: str, fname: str, keep_jpg: bool) -> str:
    """fname: '1.jpg' → upload '1.webp'"""
    stem = fname.rsplit(".", 1)[0]
    try:
        r = _retry(requests.get,
            f"{SUPA}/storage/v1/object/public/{BUCKET}/{sc}/{fname}",
            timeout=20)
        if r.status_code != 200:
            return "fetch_fail"
        img = Image.open(io.BytesIO(r.content)).convert("RGB")
        buf = io.BytesIO()
        img.save(buf, format="WEBP", quality=82, method=6)
        webp_bytes = buf.getvalue()
        up = _retry(requests.post,
            f"{SUPA}/storage/v1/object/{BUCKET}/{sc}/{stem}.webp",
            headers={
                **H,
                "Content-Type": "image/webp",
                "x-upsert": "true",
                "Cache-Control": "max-age=31536000, immutable",
            },
            data=webp_bytes,
            timeout=30)
        if up.status_code not in (200, 201):
            return f"upload_fail_{up.status_code}"
        if not keep_jpg:
            try:
                _retry(requests.delete,
                    f"{SUPA}/storage/v1/object/{BUCKET}/{sc}/{fname}",
                    headers=H, timeout=15)
            except Exception:
                pass  # delete 실패는 무시
        return "ok"
    except Exception as e:
        return f"err_{type(e).__name__}"


def process_reel(sc: str, keep_jpg: bool) -> tuple[str, dict]:
    files = list_jpgs(sc)
    if not files:
        return sc, {"skip": 1}
    counts = {}
    for f in files:
        s = convert_one(sc, f, keep_jpg)
        counts[s] = counts.get(s, 0) + 1
    return sc, counts


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--keep-jpg", action="store_true", help="JPG 원본 보존 (기본은 삭제)")
    args = ap.parse_args()

    targets = list_subdirs()
    if args.limit:
        targets = targets[:args.limit]
    print(f"대상 reel: {len(targets)}개 (keep_jpg={args.keep_jpg})")

    total = {"ok": 0, "skip": 0, "fetch_fail": 0}
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futs = {ex.submit(process_reel, sc, args.keep_jpg): sc for sc in targets}
        for i, f in enumerate(as_completed(futs), 1):
            sc, counts = f.result()
            for k, v in counts.items():
                total[k] = total.get(k, 0) + v
            print(f"  [{i}/{len(targets)}] {sc}: {counts}", flush=True)

    print(f"\n결과: {total}")


if __name__ == "__main__":
    main()
