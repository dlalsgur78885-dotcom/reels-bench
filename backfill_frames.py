"""로컬 frames/<sc>/*.jpg → Supabase Storage `frames` 버킷 일괄 업로드.

전제: SUPABASE_SERVICE_ROLE_KEY (.env), `frames` 버킷 public 존재.
사용:
  python backfill_frames.py                  # 전체 frames/ 디렉토리 sync
  python backfill_frames.py --shortcode SC   # 특정 1개만
  python backfill_frames.py --workers 8 --skip-existing
"""
from __future__ import annotations

import argparse
import os
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import requests
from dotenv import load_dotenv

ROOT = Path(__file__).parent
load_dotenv(ROOT / ".env")

SUPA = os.getenv("SUPABASE_URL")
KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_ANON_KEY")
BUCKET = "frames"
FRAMES_DIR = ROOT / "frames"


def storage_url(sc: str, n: int) -> str:
    return f"{SUPA}/storage/v1/object/public/{BUCKET}/{sc}/{n}.jpg"


def exists_in_storage(sc: str, n: int, timeout: float = 3.0) -> bool:
    try:
        r = requests.head(storage_url(sc, n), timeout=timeout)
        return r.status_code == 200
    except Exception:
        return False


def upload(sc: str, n: int, jpg_bytes: bytes) -> bool:
    url = f"{SUPA}/storage/v1/object/{BUCKET}/{sc}/{n}.jpg"
    try:
        r = requests.post(
            url,
            headers={
                "Authorization": f"Bearer {KEY}",
                "apikey": KEY,
                "Content-Type": "image/jpeg",
                "x-upsert": "true",
            },
            data=jpg_bytes,
            timeout=30,
        )
        return r.status_code in (200, 201)
    except Exception:
        return False


def process_shortcode(sc_dir: Path, skip_existing: bool) -> tuple[str, int, int]:
    sc = sc_dir.name
    files = sorted(sc_dir.glob("*.jpg"), key=lambda p: int(p.stem) if p.stem.isdigit() else 0)
    uploaded, skipped = 0, 0
    for f in files:
        try:
            n = int(f.stem)
        except ValueError:
            continue
        if skip_existing and exists_in_storage(sc, n):
            skipped += 1
            continue
        if upload(sc, n, f.read_bytes()):
            uploaded += 1
    return sc, uploaded, skipped


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--shortcode", help="단일 shortcode만 처리")
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--skip-existing", action="store_true",
                    help="Storage에 이미 있는 프레임은 HEAD 체크 후 skip (느려짐)")
    args = ap.parse_args()

    if not SUPA or not KEY:
        sys.exit("SUPABASE creds 없음")
    if not FRAMES_DIR.exists():
        sys.exit(f"frames/ 디렉토리 없음: {FRAMES_DIR}")

    if args.shortcode:
        sc_dirs = [FRAMES_DIR / args.shortcode]
        if not sc_dirs[0].exists():
            sys.exit(f"frames/{args.shortcode} 없음")
    else:
        sc_dirs = sorted([d for d in FRAMES_DIR.iterdir() if d.is_dir()])

    print(f"대상 shortcode: {len(sc_dirs)}개")
    total_files = sum(len(list(d.glob('*.jpg'))) for d in sc_dirs)
    print(f"총 jpg 파일: {total_files:,}")

    if not sc_dirs:
        return

    total_up, total_skip, fail_sc = 0, 0, []
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futures = {ex.submit(process_shortcode, d, args.skip_existing): d for d in sc_dirs}
        for i, f in enumerate(as_completed(futures), 1):
            sc, up, sk = f.result()
            total_up += up
            total_skip += sk
            if up == 0 and sk == 0:
                fail_sc.append(sc)
            if i % 5 == 0 or i == len(sc_dirs):
                print(f"  진행 {i}/{len(sc_dirs)}  업로드={total_up}  skip={total_skip}")

    print(f"\n결과: 업로드 {total_up}장, skip {total_skip}장, 실패 shortcode {len(fail_sc)}개")
    if fail_sc:
        print(f"  실패 예시: {fail_sc[:5]}")


if __name__ == "__main__":
    main()
