"""최근 N개 reels의 썸네일 백필 — HikerAPI로 fresh URL 받고 → Storage 업로드 + DB url 갱신.

사용:
  python backfill_recent_thumbs.py --limit 200
  python backfill_recent_thumbs.py --limit 500 --workers 4
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
from api.services import thumb  # noqa: E402

SUPA = os.getenv("SUPABASE_URL")
KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_ANON_KEY")
HIKER = os.getenv("HIKER_API_KEY")


def get_recent_reels(limit: int) -> list[str]:
    """reels 테이블에서 최근 수집된 shortcode (익스텐션이 모은 것 포함)."""
    r = requests.get(
        f"{SUPA}/rest/v1/reels?select=shortcode&order=collected_at.desc&limit={limit}",
        headers={"apikey": KEY, "Authorization": f"Bearer {KEY}"},
        timeout=30,
    )
    r.raise_for_status()
    return [row["shortcode"] for row in r.json()]


def hiker_fetch(shortcode: str) -> dict | None:
    try:
        r = requests.get(
            "https://api.hikerapi.com/v1/media/by/code",
            params={"code": shortcode},
            headers={"accept": "application/json", "x-access-key": HIKER},
            timeout=15,
        )
        if r.status_code != 200:
            return None
        return r.json()
    except Exception:
        return None


def upsert_metadata(shortcode: str, data: dict) -> bool:
    """reels_metadata에 stub row 만들거나 업데이트. shortcode + 핵심 필드."""
    payload = {
        "shortcode": shortcode,
        "thumbnail_url": data.get("thumbnail_url"),
        "video_url": data.get("video_url"),
        "play_count": data.get("play_count"),
        "like_count": data.get("like_count"),
        "comment_count": data.get("comment_count"),
        "video_duration": data.get("video_duration"),
        "caption_text": (data.get("caption") or {}).get("text") if isinstance(data.get("caption"), dict) else data.get("caption_text"),
        "author_username": (data.get("user") or {}).get("username") if isinstance(data.get("user"), dict) else data.get("author_username"),
        "music_title": ((data.get("clips_metadata") or {}).get("music_info") or {}).get("music_asset_info", {}).get("title") if isinstance(data.get("clips_metadata"), dict) else None,
        "fetched_at": data.get("taken_at_date"),
    }
    payload = {k: v for k, v in payload.items() if v is not None or k == "shortcode"}
    try:
        r = requests.post(
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
        return r.status_code in (200, 201, 204)
    except Exception:
        return False


def process(shortcode: str) -> tuple[str, str]:
    # 이미 storage에 있으면 DB url만 정리
    if thumb.exists_in_storage(shortcode):
        thumb._update_db_url(shortcode)
        return shortcode, "already_in_storage"

    # HikerAPI로 metadata + fresh thumbnail_url 받기
    data = hiker_fetch(shortcode)
    if not data:
        return shortcode, "hiker_fail"
    fresh = data.get("thumbnail_url")
    if not fresh:
        return shortcode, "no_thumb"

    # reels_metadata에 upsert (server.py proxy가 thumbnail_url 읽으려면 필요)
    upsert_metadata(shortcode, data)

    # Storage 업로드 + DB url 영구화
    ok = thumb.download(shortcode, fresh)
    return shortcode, "uploaded" if ok else "download_failed"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=200)
    ap.add_argument("--workers", type=int, default=4)
    args = ap.parse_args()

    if not HIKER:
        sys.exit("HIKER_API_KEY 없음")
    if not SUPA or not KEY:
        sys.exit("SUPABASE creds 없음")

    print(f"reels 테이블에서 최근 {args.limit}개 shortcode 조회...")
    targets = get_recent_reels(args.limit)
    print(f"대상: {len(targets)}개")
    if not targets:
        print("모두 이미 백필됨")
        return

    counts: dict[str, int] = {}
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futures = {ex.submit(process, sc): sc for sc in targets}
        for i, f in enumerate(as_completed(futures), 1):
            sc, status = f.result()
            counts[status] = counts.get(status, 0) + 1
            if i % 20 == 0 or i == len(targets):
                print(f"  진행 {i}/{len(targets)}  {counts}")

    print(f"\n결과: {counts}")


if __name__ == "__main__":
    main()
