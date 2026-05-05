"""페북 광고주 fb_advertisers polling worker.

10초마다 fb_advertisers에서 last_scraped_at IS NULL or 24시간 경과한 광고주 찾아서
AdLibraryScraper로 광고 수집 → reels + reels_metadata에 fb_{ad_id} 형식으로 삽입.

사용:
  python fb_ads_worker.py                       # polling 10s
  python fb_ads_worker.py --interval 30         # 30s
  python fb_ads_worker.py --once                # 1회만
"""
from __future__ import annotations

import argparse
import asyncio
import os
import sys
import time
import traceback
from datetime import datetime, timezone, timedelta
from pathlib import Path

import requests
from dotenv import load_dotenv

ROOT = Path(__file__).parent
load_dotenv(ROOT / ".env")
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "api"))

from api.services.fb_ads_scraper import AdLibraryScraper  # noqa: E402

SUPA = os.getenv("SUPABASE_URL")
KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_ANON_KEY")
H = {"apikey": KEY, "Authorization": f"Bearer {KEY}"}
PROXY = os.getenv("FB_ADS_PROXY", "")  # optional
RESCRAPE_HOURS = 24


def now() -> str:
    return datetime.now().strftime("%H:%M:%S")


def get_pending_advertisers(limit: int = 5) -> list[dict]:
    """스크래핑 대상 광고주 — last_scraped_at IS NULL or 24h 경과."""
    threshold = (datetime.now(timezone.utc) - timedelta(hours=RESCRAPE_HOURS)).isoformat()
    # NULL 우선
    null_rows = requests.get(
        f"{SUPA}/rest/v1/fb_advertisers?last_scraped_at=is.null&is_active=eq.true&select=*&limit={limit}",
        headers=H, timeout=15,
    ).json() or []
    if len(null_rows) >= limit:
        return null_rows[:limit]
    remaining = limit - len(null_rows)
    old_rows = requests.get(
        f"{SUPA}/rest/v1/fb_advertisers?last_scraped_at=lt.{threshold}&is_active=eq.true&select=*&order=last_scraped_at.asc&limit={remaining}",
        headers=H, timeout=15,
    ).json() or []
    return null_rows + old_rows


def update_advertiser(adv_id: int, ad_count: int, status: str = "ok"):
    requests.patch(
        f"{SUPA}/rest/v1/fb_advertisers?id=eq.{adv_id}",
        headers={**H, "Content-Type": "application/json", "Prefer": "return=minimal"},
        json={
            "last_scraped_at": datetime.now(timezone.utc).isoformat(),
            "scrape_status": status,
            "ad_count": ad_count,
        },
        timeout=15,
    )


def insert_ad_to_reels(ad: dict, page_name: str) -> bool:
    """수집된 광고 dict → reels + reels_metadata 삽입 (shortcode='fb_{id}')."""
    ad_id = ad.get("id") or ""
    if not ad_id:
        return False
    shortcode = f"fb_{ad_id}"

    # reels 테이블 (source = fb_ad)
    reel_payload = {
        "shortcode": shortcode,
        "url": ad.get("snapshot_url") or "",
        "source": "fb_ad",
        "collected_at": ad.get("start_date") or datetime.now(timezone.utc).isoformat(),
    }
    requests.post(
        f"{SUPA}/rest/v1/reels?on_conflict=shortcode",
        headers={**H, "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates,return=minimal"},
        json=reel_payload, timeout=15,
    )

    # reels_metadata
    meta_payload = {
        "shortcode": shortcode,
        "video_url": ad.get("video_url") or "",
        "thumbnail_url": ad.get("video_thumbnail") or ad.get("banner_url") or "",
        "caption_text": ad.get("caption") or "",
        "author_username": page_name,
    }
    if ad.get("start_date"):
        meta_payload["fetched_at"] = ad["start_date"]
    meta_payload = {k: v for k, v in meta_payload.items() if v not in (None, "") or k == "shortcode"}
    requests.post(
        f"{SUPA}/rest/v1/reels_metadata?on_conflict=shortcode",
        headers={**H, "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates,return=minimal"},
        json=meta_payload, timeout=15,
    )
    return True


async def scrape_one(adv: dict) -> int:
    """광고주 1명에 대해 스크래핑 → DB 삽입. 수집된 광고 수 반환."""
    page_name = adv.get("page_name") or ""
    if not page_name:
        return 0
    print(f"[{now()}] scraping '{page_name}'...", flush=True)
    scraper = AdLibraryScraper(headless=True, output_dir="./fb_ads_output", proxy=PROXY)
    try:
        ads = await scraper.scrape(keyword=page_name, country="KR", max_ads=50)
    except Exception as e:
        print(f"[{now()}] scrape error: {e}", flush=True)
        return 0
    if not ads:
        print(f"[{now()}] no ads found for '{page_name}'", flush=True)
        return 0
    inserted = 0
    for ad in ads:
        # 광고주 이름이 일치하는 광고만 (다른 페이지 결과 제외)
        ad_page_name = (ad.get("page_name") or "").strip()
        if ad_page_name and ad_page_name != page_name and page_name not in ad_page_name:
            continue
        if insert_ad_to_reels(ad, page_name):
            inserted += 1
    print(f"[{now()}] {page_name}: {inserted} ads inserted (out of {len(ads)} scraped)", flush=True)
    return inserted


async def loop_once(interval: int):
    while True:
        try:
            pending = get_pending_advertisers(limit=1)
            if not pending:
                await asyncio.sleep(interval)
                continue
            adv = pending[0]
            adv_id = adv["id"]
            try:
                cnt = await scrape_one(adv)
                update_advertiser(adv_id, ad_count=cnt, status="ok" if cnt > 0 else "empty")
            except Exception as e:
                print(f"[{now()}] [ERR] {adv.get('page_name')}: {e}", flush=True)
                traceback.print_exc()
                update_advertiser(adv_id, ad_count=0, status=f"error: {str(e)[:200]}")
        except KeyboardInterrupt:
            print(f"[{now()}] worker stopped", flush=True)
            return
        except Exception as e:
            print(f"[{now()}] [ERR] loop: {e}", flush=True)
            traceback.print_exc()
            await asyncio.sleep(interval)


async def main_async():
    ap = argparse.ArgumentParser()
    ap.add_argument("--interval", type=int, default=10)
    ap.add_argument("--once", action="store_true", help="1회만 실행")
    args = ap.parse_args()
    print(f"[{now()}] fb_ads_worker started (interval={args.interval}s, proxy={'YES' if PROXY else 'NO'})", flush=True)
    if args.once:
        pending = get_pending_advertisers(limit=10)
        print(f"pending: {len(pending)}", flush=True)
        for adv in pending:
            try:
                cnt = await scrape_one(adv)
                update_advertiser(adv["id"], ad_count=cnt, status="ok" if cnt > 0 else "empty")
            except Exception as e:
                update_advertiser(adv["id"], ad_count=0, status=f"error: {str(e)[:200]}")
        return
    await loop_once(args.interval)


if __name__ == "__main__":
    asyncio.run(main_async())
