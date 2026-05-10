"""section_chunks의 hook chunk에 archetype 메타데이터 일괄 backfill.

기존에 분석된 ref들은 archetype 필드 없음 (분석 시점에 classifier 없었음).
이 스크립트로 일괄 분류 → DB 저장 → Writer가 archetype-aware 룰 적용 가능.

usage:
  python _backfill_hook_archetype.py                  # archetype 없는 모든 ref
  python _backfill_hook_archetype.py --limit 20       # 20개만
  python _backfill_hook_archetype.py --shortcode SC   # 특정 shortcode
  python _backfill_hook_archetype.py --workers 4      # 동시 4개 (기본 2)
  python _backfill_hook_archetype.py --dry-run        # 대상만 출력
  python _backfill_hook_archetype.py --force          # 이미 archetype 있어도 재분류
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
sys.path.insert(0, str(ROOT))
load_dotenv(ROOT / ".env")

SUPA = os.getenv("SUPABASE_URL")
KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
if not SUPA or not KEY:
    sys.exit("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 누락")
H = {"apikey": KEY, "Authorization": f"Bearer {KEY}"}

# api/services 임포트 가능하게
sys.path.insert(0, str(ROOT / "api"))
from services import script_gen as sg  # noqa: E402


def list_targets(specific: str | None, force: bool, limit: int | None) -> list[dict]:
    """script_structure에 section_chunks 있는데 hook chunk에 archetype 없는 ref."""
    if specific:
        ss = requests.get(
            f"{SUPA}/rest/v1/reels_script_structure?shortcode=eq.{specific}&select=shortcode,overall&limit=1",
            headers=H, timeout=15,
        ).json()
        if not ss:
            return []
        return [{"shortcode": specific, "overall": ss[0].get("overall") or {}}]

    out: list[dict] = []
    page = 1000
    offset = 0
    while True:
        r = requests.get(
            f"{SUPA}/rest/v1/reels_script_structure?select=shortcode,overall&limit={page}&offset={offset}",
            headers=H, timeout=30,
        )
        rows = r.json() if r.ok else []
        if not rows:
            break
        for row in rows:
            sc = row.get("shortcode")
            overall = row.get("overall") or {}
            chunks = overall.get("section_chunks") or []
            hook_chunk = next((c for c in chunks if (c.get("section") or "").lower() == "hook"), None)
            if not hook_chunk:
                continue
            # 이미 archetype 있고 force 아니면 skip
            if not force and hook_chunk.get("archetype"):
                continue
            out.append({"shortcode": sc, "overall": overall})
        if len(rows) < page:
            break
        offset += page
        if limit and len(out) >= limit:
            break
    if limit:
        out = out[:limit]
    return out


def process_one(target: dict) -> tuple[str, bool, str]:
    sc = target["shortcode"]
    overall = target["overall"] or {}
    chunks = list(overall.get("section_chunks") or [])
    hook_idx = next((i for i, c in enumerate(chunks) if (c.get("section") or "").lower() == "hook"), -1)
    if hook_idx < 0:
        return (sc, False, "no hook chunk")
    hook_chunk = chunks[hook_idx]
    hook_text = " ".join((s.get("text") or "").strip() for s in hook_chunk.get("sentences") or [])
    if not hook_text:
        return (sc, False, "empty hook text")
    body_chunks = [c for c in chunks if (c.get("section") or "").lower().startswith("body")]
    body_summary = " / ".join(
        c.get("summary") or c.get("topic") or "" for c in body_chunks
        if c.get("summary") or c.get("topic")
    )
    try:
        archetype = sg.classify_hook_archetype(hook_text, body_summary)
    except Exception as e:
        return (sc, False, f"classify failed: {e}")

    # 새 chunks list 만들어 hook chunk에 archetype attach
    chunks[hook_idx] = {**hook_chunk, "archetype": archetype}
    new_overall = {**overall, "section_chunks": chunks}

    # DB upsert
    try:
        r = requests.post(
            f"{SUPA}/rest/v1/reels_script_structure?on_conflict=shortcode",
            headers={**H, "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates,return=minimal"},
            json={"shortcode": sc, "overall": new_overall}, timeout=30,
        )
        if not r.ok:
            return (sc, False, f"upsert {r.status_code}: {r.text[:200]}")
    except Exception as e:
        return (sc, False, f"upsert failed: {e}")

    return (sc, True, f"{archetype.get('archetype', '?')} (core={archetype.get('core_word', '')})")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--shortcode")
    ap.add_argument("--limit", type=int)
    ap.add_argument("--workers", type=int, default=2)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--force", action="store_true", help="이미 archetype 있어도 재분류")
    args = ap.parse_args()

    targets = list_targets(args.shortcode, args.force, args.limit)
    print(f"[backfill] targets: {len(targets)}")
    if args.dry_run:
        for t in targets[:50]:
            print(f"  - {t['shortcode']}")
        return

    if not targets:
        print("[backfill] nothing to do")
        return

    t0 = time.time()
    ok, fail = 0, 0
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futures = {ex.submit(process_one, t): t["shortcode"] for t in targets}
        for f in as_completed(futures):
            sc = futures[f]
            try:
                sc2, success, msg = f.result()
                if success:
                    ok += 1
                    print(f"  ✅ {sc2}: {msg}")
                else:
                    fail += 1
                    print(f"  ❌ {sc2}: {msg}")
            except Exception as e:
                fail += 1
                print(f"  ❌ {sc}: exception {e}")
                traceback.print_exc()

    print(f"\n[backfill] done: {ok} ok / {fail} fail / {time.time() - t0:.1f}s")


if __name__ == "__main__":
    main()
