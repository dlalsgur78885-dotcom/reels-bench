"""자동 분석 워커 — 미분석 reels를 일괄 처리 (B 단계: Flash까지만, Pro 제외).

사용:
  python auto_analyze.py                 # 기본 10개 처리
  python auto_analyze.py --limit 20      # 20개
  python auto_analyze.py --dry-run       # 대상만 출력
"""
from __future__ import annotations

import argparse
import os
import sys
import time
from pathlib import Path
from dotenv import load_dotenv

ROOT = Path(__file__).parent
load_dotenv(ROOT / ".env")
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "api"))

from api.services import supabase, pipeline  # noqa: E402

import requests  # noqa: E402

SUPA = os.getenv("SUPABASE_URL")
KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_ANON_KEY")
HIKER = os.getenv("HIKER_API_KEY")


def get_unanalyzed(limit: int) -> list[str]:
    """Return recent reels without opus analysis, scanning past already-analyzed rows."""
    candidates = []
    page_size = max(100, min(1000, limit * 20))
    offset = 0
    while len(candidates) < limit * 10:
        r = requests.get(
            f"{SUPA}/rest/v1/reels?select=shortcode&order=collected_at.desc&limit={page_size}&offset={offset}",
            headers={"apikey": KEY, "Authorization": f"Bearer {KEY}"},
            timeout=30,
        )
        rows = r.json() if r.status_code == 200 else []
        if not rows:
            break
        candidates.extend(row["shortcode"] for row in rows if row.get("shortcode"))
        if len(rows) < page_size:
            break
        offset += page_size

    sc_list = ",".join(f'"{s}"' for s in candidates)
    if not sc_list:
        return []
    # opus_analyses + transcripts 둘 다 있어야 "분석됨"으로 인정
    r2 = requests.get(
        f"{SUPA}/rest/v1/opus_analyses?select=shortcode&shortcode=in.({sc_list})",
        headers={"apikey": KEY, "Authorization": f"Bearer {KEY}"},
        timeout=30,
    )
    has_opus = {row["shortcode"] for row in r2.json()}
    r3 = requests.get(
        f"{SUPA}/rest/v1/reels_transcripts?select=shortcode&shortcode=in.({sc_list})",
        headers={"apikey": KEY, "Authorization": f"Bearer {KEY}"},
        timeout=30,
    )
    has_trans = {row["shortcode"] for row in r3.json()}
    analyzed = has_opus & has_trans  # 둘 다 있을 때만 분석됨
    return [sc for sc in candidates if sc not in analyzed][:limit]

def get_unanalyzed_legacy(limit: int) -> list[str]:
    """reels에 있지만 reels_metadata 또는 opus_analyses 없는 shortcode."""
    # reels 테이블에서 최근 수집된 것
    r = requests.get(
        f"{SUPA}/rest/v1/reels?select=shortcode&order=collected_at.desc&limit={limit * 5}",
        headers={"apikey": KEY, "Authorization": f"Bearer {KEY}"},
        timeout=30,
    )
    candidates = [row["shortcode"] for row in r.json()]

    # 이미 분석된 것 제외 (opus_analyses에 있으면 skip)
    sc_list = ",".join(f'"{s}"' for s in candidates)
    r2 = requests.get(
        f"{SUPA}/rest/v1/opus_analyses?select=shortcode&shortcode=in.({sc_list})",
        headers={"apikey": KEY, "Authorization": f"Bearer {KEY}"},
        timeout=30,
    )
    analyzed = {row["shortcode"] for row in r2.json()}

    pending = [sc for sc in candidates if sc not in analyzed][:limit]
    return pending


def ensure_metadata(shortcode: str) -> bool:
    """reels_metadata에 row 없으면 HikerAPI로 채움 (Stage A)."""
    r = requests.get(
        f"{SUPA}/rest/v1/reels_metadata?shortcode=eq.{shortcode}&select=video_url&limit=1",
        headers={"apikey": KEY, "Authorization": f"Bearer {KEY}"},
        timeout=15,
    )
    rows = r.json() if r.status_code == 200 else []
    if rows and rows[0].get("video_url"):
        return True

    # HikerAPI 호출
    if not HIKER:
        return False
    try:
        h = requests.get(
            "https://api.hikerapi.com/v1/media/by/code",
            params={"code": shortcode},
            headers={"accept": "application/json", "x-access-key": HIKER},
            timeout=20,
        )
        if h.status_code != 200:
            return False
        d = h.json()
    except Exception:
        return False

    payload = {
        "shortcode": shortcode,
        "thumbnail_url": d.get("thumbnail_url"),
        "video_url": d.get("video_url"),
        "play_count": d.get("play_count"),
        "like_count": d.get("like_count"),
        "comment_count": d.get("comment_count"),
        "video_duration": d.get("video_duration"),
        "caption_text": (
            d.get("caption", {}).get("text") if isinstance(d.get("caption"), dict)
            else d.get("caption_text")
        ),
        "author_username": (
            d.get("user", {}).get("username") if isinstance(d.get("user"), dict)
            else d.get("author_username")
        ),
        "music_title": (
            ((d.get("clips_metadata") or {}).get("music_info") or {})
            .get("music_asset_info", {}).get("title")
            if isinstance(d.get("clips_metadata"), dict) else None
        ),
        "fetched_at": d.get("taken_at_date"),
    }
    if not payload.get("video_url"):
        return False
    payload = {k: v for k, v in payload.items() if v is not None or k == "shortcode"}
    upsert = requests.post(
        f"{SUPA}/rest/v1/reels_metadata?on_conflict=shortcode",
        headers={
            "apikey": KEY,
            "Authorization": f"Bearer {KEY}",
            "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates,return=minimal",
        },
        json=payload,
        timeout=15,
    )
    return upsert.status_code in (200, 201, 204)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=10)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    print(f"[auto_analyze] 미분석 reels 조회 (limit={args.limit})...")
    targets = get_unanalyzed(args.limit)
    print(f"  대상: {len(targets)}개")
    for sc in targets:
        print(f"    {sc}")

    if args.dry_run or not targets:
        return

    counts = {"analyzed": 0, "metadata_only": 0, "failed": 0}
    for i, sc in enumerate(targets, 1):
        print(f"\n[{i}/{len(targets)}] {sc}")
        try:
            # Stage A: metadata 확보
            if not ensure_metadata(sc):
                print(f"  [FAIL] metadata fetch failed")
                counts["failed"] += 1
                continue

            # Stage B + Pro audio (감정·BGM·효과음 타임스탬프)
            t0 = time.time()
            pipeline.run(sc, skip_pro_audio=False)
            elapsed = time.time() - t0

            status = pipeline.analysis_status.get(sc, {}).get("status", "?")
            if status == "done":
                print(f"  [OK] analyzed in {elapsed:.0f}s")
                counts["analyzed"] += 1
            else:
                msg = pipeline.analysis_status.get(sc, {}).get("message", "?")
                print(f"  [WARN] status={status} msg={msg}")
                counts["failed"] += 1
        except Exception as e:
            print(f"  [ERR] exception: {e}")
            counts["failed"] += 1

    print(f"\n[result] {counts}")


if __name__ == "__main__":
    main()
