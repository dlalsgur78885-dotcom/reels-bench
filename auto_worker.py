"""상시 분석 워커 — 미분석 reels를 polling 방식으로 즉시 처리.

5분 cron 대신 PC가 켜져 있는 동안 계속 돌면서 10초마다 미분석 체크.
새 reel 감지 시 곧바로 분석 시작 → 거의 실시간.

사용:
  python auto_worker.py                    # 기본 polling 10초
  python auto_worker.py --interval 30      # 30초 간격
"""
from __future__ import annotations

import argparse
import sys
import time
import traceback
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "api"))

from auto_analyze import get_unanalyzed, ensure_metadata  # noqa: E402
from api.services import pipeline  # noqa: E402


def now() -> str:
    return datetime.now().strftime("%H:%M:%S")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--interval", type=int, default=10,
                    help="미분석 없을 때 대기 시간(초)")
    args = ap.parse_args()

    print(f"[{now()}] auto_worker started (polling every {args.interval}s)", flush=True)

    fail_count: dict[str, int] = {}
    blocklist: set[str] = set()
    MAX_FAILS = 3

    while True:
        try:
            pending = [sc for sc in get_unanalyzed(5) if sc not in blocklist and not sc.startswith("fb_")]
            if not pending:
                time.sleep(args.interval)
                continue
            sc = pending[0]
            print(f"\n[{now()}] processing {sc}", flush=True)

            if not ensure_metadata(sc):
                fail_count[sc] = fail_count.get(sc, 0) + 1
                if fail_count[sc] >= MAX_FAILS:
                    blocklist.add(sc)
                    print(f"[{now()}] [SKIP] {sc} blocklisted after {MAX_FAILS} fails", flush=True)
                else:
                    print(f"[{now()}] [FAIL] metadata fetch ({fail_count[sc]}/{MAX_FAILS})", flush=True)
                time.sleep(args.interval)
                continue

            t0 = time.time()
            pipeline.run(sc, skip_pro_audio=False)
            elapsed = time.time() - t0
            status = pipeline.analysis_status.get(sc, {}).get("status", "?")
            print(f"[{now()}] [{status}] {sc} in {elapsed:.0f}s", flush=True)
        except KeyboardInterrupt:
            print(f"\n[{now()}] auto_worker stopped (Ctrl+C)", flush=True)
            return
        except Exception as e:
            print(f"[{now()}] [ERR] {e}", flush=True)
            traceback.print_exc()
            time.sleep(args.interval)


if __name__ == "__main__":
    main()
