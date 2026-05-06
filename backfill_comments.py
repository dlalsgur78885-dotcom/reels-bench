"""분석된 reels 중 댓글이 없는 것들을 일괄 수집.

usage:
  python backfill_comments.py            # reels_pro_audio에 있는 + reels_comments에 없는 모든 것
  python backfill_comments.py --limit 30
  python backfill_comments.py --workers 3
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
sys.path.insert(0, str(ROOT))

from api.services import comments  # noqa: E402

SUPA = os.getenv("SUPABASE_URL")
KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_ANON_KEY")
H = {"apikey": KEY, "Authorization": f"Bearer {KEY}"}


def find_missing(limit: int) -> list[str]:
    analyzed = requests.get(
        f"{SUPA}/rest/v1/reels_pro_audio?select=shortcode&order=analyzed_at.desc&limit=10000",
        headers=H, timeout=30,
    ).json()
    have = requests.get(
        f"{SUPA}/rest/v1/reels_comments?select=shortcode&limit=50000",
        headers=H, timeout=30,
    ).json()
    have_set = {r["shortcode"] for r in have}
    missing = [r["shortcode"] for r in analyzed if r["shortcode"] not in have_set]
    return missing[:limit] if limit else missing


def process(sc: str) -> tuple[str, int]:
    cmts = comments.fetch_playwright(sc)
    if not cmts:
        return sc, 0
    requests.post(
        f"{SUPA}/rest/v1/reels_comments",
        headers={**H, "Content-Type": "application/json",
                 "Prefer": "resolution=merge-duplicates,return=minimal"},
        json=cmts, timeout=20,
    )
    return sc, len(cmts)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--workers", type=int, default=2)
    args = ap.parse_args()

    targets = find_missing(args.limit)
    print(f"댓글 없음: {len(targets)}개")
    if not targets:
        return

    counts = {"ok": 0, "empty": 0}
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futs = {ex.submit(process, sc): sc for sc in targets}
        for i, f in enumerate(as_completed(futs), 1):
            sc, n = f.result()
            counts["ok" if n > 0 else "empty"] += 1
            print(f"  [{i}/{len(targets)}] {sc}: {n} comments", flush=True)

    print(f"\n결과: {counts}")


if __name__ == "__main__":
    main()
