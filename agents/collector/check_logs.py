"""Chrome 익스텐션 원격 로그 조회 헬퍼.

사용 예:
  python agents/collector/check_logs.py                  # 최근 30개
  python agents/collector/check_logs.py --errors         # 에러만
  python agents/collector/check_logs.py --event extract_zero  # 특정 이벤트
  python agents/collector/check_logs.py --session abc123 # 특정 세션
  python agents/collector/check_logs.py --since 30m      # 최근 30분
  python agents/collector/check_logs.py --tail            # 최근 로그 + DOM 샘플 풀로 보기
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests
from dotenv import load_dotenv

ROOT = Path(__file__).parent.parent.parent
load_dotenv(ROOT / ".env")

SUPA = os.getenv("SUPABASE_URL")
KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_ANON_KEY")
HEADERS = {"apikey": KEY, "Authorization": f"Bearer {KEY}"}

LEVEL_COLOR = {
    "error": "\033[31m", "warn": "\033[33m", "info": "\033[36m",
}
RESET = "\033[0m"


def parse_since(s: str) -> str:
    m = re.match(r"^(\d+)\s*(s|m|h|d)?$", s.strip().lower())
    if not m:
        raise SystemExit(f"--since 형식 오류: {s} (예: 30m, 2h, 1d)")
    num, unit = int(m.group(1)), (m.group(2) or "m")
    delta = {"s": "seconds", "m": "minutes", "h": "hours", "d": "days"}[unit]
    cutoff = datetime.now(timezone.utc) - timedelta(**{delta: num})
    return cutoff.isoformat()


def fetch(filters: dict, limit: int) -> list[dict]:
    parts = ["select=*", f"limit={limit}", "order=ts.desc"]
    for k, v in filters.items():
        parts.append(f"{k}={v}")
    url = f"{SUPA}/rest/v1/extension_logs?" + "&".join(parts)
    r = requests.get(url, headers=HEADERS, timeout=15)
    r.raise_for_status()
    return r.json()


def fmt_row(row: dict, tail: bool) -> str:
    ts = row["ts"][:19].replace("T", " ")
    color = LEVEL_COLOR.get(row["level"], "")
    head = f"{color}{ts}  [{row['level']:>5}]  {row['event']:<24}{RESET}"
    sid = (row.get("session_id") or "")[:8]
    ver = row.get("version") or "?"
    msg = row.get("message") or ""
    page = (row.get("page_url") or "").replace("https://www.instagram.com", "")
    parts = [head, f"  sid={sid} v{ver} page={page}"]
    if msg:
        parts.append(f"  msg: {msg}")
    ctx = row.get("context") or {}
    if ctx:
        compact = {k: v for k, v in ctx.items() if k != "dom_sample"}
        if compact:
            parts.append(f"  ctx: {json.dumps(compact, ensure_ascii=False)[:300]}")
        if tail and ctx.get("dom_sample"):
            parts.append(f"  dom_sample (first 1.5KB):\n{ctx['dom_sample'][:1500]}")
    return "\n".join(parts)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--errors", action="store_true", help="에러만 보기")
    ap.add_argument("--warnings", action="store_true", help="warn 이상만")
    ap.add_argument("--event", help="특정 event 필터")
    ap.add_argument("--session", help="특정 session_id (앞부분 8자리도 OK)")
    ap.add_argument("--since", help="기간 (예: 30m, 2h, 1d)")
    ap.add_argument("--limit", type=int, default=30)
    ap.add_argument("--tail", action="store_true", help="DOM 샘플까지 풀 출력")
    args = ap.parse_args()

    if not SUPA or not KEY:
        sys.exit("SUPABASE_URL / KEY 환경변수가 필요합니다.")

    filters: dict[str, str] = {}
    if args.errors:
        filters["level"] = "eq.error"
    elif args.warnings:
        filters["level"] = "in.(error,warn)"
    if args.event:
        filters["event"] = f"eq.{args.event}"
    if args.session:
        # session_id 앞부분 매칭은 like
        filters["session_id"] = f"like.{args.session}*"
    if args.since:
        filters["ts"] = f"gte.{parse_since(args.since)}"

    rows = fetch(filters, args.limit)
    if not rows:
        print("(로그 없음)")
        return

    print(f"=== {len(rows)}건 ===\n")
    for r in rows:
        print(fmt_row(r, args.tail))
        print()


if __name__ == "__main__":
    main()
