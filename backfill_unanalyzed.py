"""미분석 reels (reels_pro_audio에 없음)를 병렬로 풀 분석.

usage:
  python backfill_unanalyzed.py             # 4 workers
  python backfill_unanalyzed.py --workers 6
"""
from __future__ import annotations

import argparse
import os
import sys
import time
import traceback
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import requests
from dotenv import load_dotenv

ROOT = Path(__file__).parent
load_dotenv(ROOT / ".env")
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "api"))

from api.services import pipeline  # noqa: E402
from auto_analyze import ensure_metadata  # noqa: E402

SUPA = os.getenv("SUPABASE_URL").strip()
KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY").strip()
H = {"apikey": KEY, "Authorization": f"Bearer {KEY}"}


def find_missing() -> list[str]:
    all_scs = {r["shortcode"] for r in requests.get(
        f"{SUPA}/rest/v1/reels?select=shortcode", headers=H, timeout=30).json()}
    pa_scs = {r["shortcode"] for r in requests.get(
        f"{SUPA}/rest/v1/reels_pro_audio?select=shortcode", headers=H, timeout=30).json()}
    return sorted(all_scs - pa_scs)


def analyze_one(sc: str) -> tuple[str, str, float]:
    t0 = time.time()
    try:
        if not ensure_metadata(sc):
            return sc, "metadata_fail", time.time() - t0
        pipeline.run(sc, skip_pro_audio=False)
        st = pipeline.analysis_status.get(sc, {}).get("status", "?")
        return sc, st, time.time() - t0
    except Exception as e:
        return sc, f"exception:{type(e).__name__}", time.time() - t0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--workers", type=int, default=4)
    args = ap.parse_args()

    targets = find_missing()
    print(f"미분석: {len(targets)}개")
    if not targets:
        return

    counts: dict[str, int] = {}
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futs = {ex.submit(analyze_one, sc): sc for sc in targets}
        for i, f in enumerate(as_completed(futs), 1):
            sc, st, dt = f.result()
            counts[st] = counts.get(st, 0) + 1
            print(f"  [{i}/{len(targets)}] {sc} {st} ({dt:.0f}s)", flush=True)

    print(f"\n결과: {counts}")


if __name__ == "__main__":
    main()
