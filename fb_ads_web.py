"""FB Ads scraper Web Service — Render free tier 배포.
외부 cron이 /trigger 호출 → pending 광고주 스크래핑.
"""
from __future__ import annotations
import asyncio
import os
import sys
import traceback
from datetime import datetime, timezone
from pathlib import Path

import requests
from dotenv import load_dotenv
from fastapi import FastAPI, BackgroundTasks, HTTPException, Header

ROOT = Path(__file__).parent
load_dotenv(ROOT / ".env")
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "api"))

from api.services.fb_ads_scraper import AdLibraryScraper  # noqa: E402
from api.services import thumb as thumb_svc  # noqa: E402

SUPA = os.getenv("SUPABASE_URL")
KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_ANON_KEY")
H = {"apikey": KEY, "Authorization": f"Bearer {KEY}"}
PROXY = os.getenv("FB_ADS_PROXY", "")
TRIGGER_SECRET = os.getenv("TRIGGER_SECRET", "")

app = FastAPI(title="fb-ads-worker-web")

# 동시 실행 방지
_running = {"flag": False}


def now() -> str:
    return datetime.now().strftime("%H:%M:%S")


def get_pending(limit: int = 5) -> list[dict]:
    r = requests.get(
        f"{SUPA}/rest/v1/fb_advertisers?last_scraped_at=is.null&is_active=eq.true&select=*&limit={limit}",
        headers=H, timeout=15,
    )
    return r.json() if r.status_code == 200 else []


def update_advertiser(adv_id: int, ad_count: int, status: str = "ok"):
    requests.patch(
        f"{SUPA}/rest/v1/fb_advertisers?id=eq.{adv_id}",
        headers={**H, "Content-Type": "application/json", "Prefer": "return=minimal"},
        json={
            "last_scraped_at": datetime.now(timezone.utc).isoformat(),
            "scrape_status": status,
            "ad_count": ad_count,
        }, timeout=15,
    )


def insert_ad_to_reels(ad: dict, page_name: str) -> bool:
    ad_id = ad.get("id") or ""
    if not ad_id:
        print(f"[insert] empty ad_id, skip", flush=True)
        return False
    shortcode = f"fb_{ad_id}"
    # 추출된 광고주명 우선 사용
    actual_author = (ad.get("page_name") or "").strip() or page_name
    r1 = requests.post(
        f"{SUPA}/rest/v1/reels?on_conflict=shortcode",
        headers={**H, "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates,return=minimal"},
        json={
            "shortcode": shortcode,
            "url": ad.get("snapshot_url") or f"https://www.facebook.com/ads/library/?id={ad_id}",
            "source": "fb_ad",
            "collected_at": datetime.now(timezone.utc).isoformat(),
        },
        timeout=15,
    )
    if r1.status_code not in (200, 201, 204):
        print(f"[insert] reels POST failed sc={r1.status_code} {r1.text[:150]}", flush=True)
        return False
    fb_thumb_url = ad.get("video_thumbnail") or ad.get("banner_url") or ""
    meta = {
        "shortcode": shortcode,
        "video_url": ad.get("video_url") or "",
        "thumbnail_url": fb_thumb_url,
        "caption_text": ad.get("caption") or "",
        "author_username": actual_author,
    }
    meta = {k: v for k, v in meta.items() if v not in (None, "") or k == "shortcode"}
    r2 = requests.post(
        f"{SUPA}/rest/v1/reels_metadata?on_conflict=shortcode",
        headers={**H, "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates,return=minimal"},
        json=meta, timeout=15,
    )
    if r2.status_code not in (200, 201, 204):
        print(f"[insert] meta POST failed sc={r2.status_code} {r2.text[:150]}", flush=True)
        return False
    # 썸네일 영구 저장 (FB CDN은 만료/차단 위험)
    if fb_thumb_url:
        try:
            thumb_svc.download(shortcode, fb_thumb_url)
        except Exception as e:
            print(f"[insert] thumb persist failed {shortcode}: {e}", flush=True)
    return True


async def scrape_one(adv: dict) -> int:
    page_name = (adv.get("page_name") or "").strip()
    keyword = page_name.replace("[검색] ", "").strip()
    if not keyword:
        return 0
    print(f"[{now()}] scraping '{keyword}'...", flush=True)
    scraper = AdLibraryScraper(headless=True, output_dir="/tmp/fb_ads_output", proxy=PROXY)
    try:
        ads = await scraper.scrape(keyword=keyword, country="KR", max_ads=100)
    except Exception as e:
        print(f"[{now()}] scrape error: {e}", flush=True)
        return 0
    inserted = 0
    for ad in ads:
        if insert_ad_to_reels(ad, page_name):
            inserted += 1
    print(f"[{now()}] {keyword}: {inserted}/{len(ads)} ads inserted", flush=True)
    return inserted


async def process_pending(limit: int = 3):
    if _running["flag"]:
        print(f"[{now()}] already running, skip", flush=True)
        return
    _running["flag"] = True
    try:
        pending = get_pending(limit)
        print(f"[{now()}] {len(pending)} pending", flush=True)
        for adv in pending:
            try:
                cnt = await scrape_one(adv)
                update_advertiser(adv["id"], ad_count=cnt, status="ok" if cnt > 0 else "empty")
            except Exception as e:
                traceback.print_exc()
                update_advertiser(adv["id"], ad_count=0, status=f"error: {str(e)[:200]}")
    finally:
        _running["flag"] = False


@app.get("/")
def health():
    return {"ok": True, "service": "fb-ads-worker-web", "running": _running["flag"]}


@app.get("/status")
def status():
    pending = get_pending(50)
    return {
        "ok": True,
        "running": _running["flag"],
        "pending_count": len(pending),
        "pending": [{"id": p["id"], "page_name": p["page_name"]} for p in pending[:10]],
    }


@app.api_route("/trigger", methods=["GET", "POST"])
async def trigger(key: str = "", limit: int = 3, x_trigger_key: str | None = Header(None)):
    if TRIGGER_SECRET:
        provided = key or x_trigger_key
        if provided != TRIGGER_SECRET:
            raise HTTPException(401, "invalid trigger key")
    # asyncio.create_task로 백그라운드 실행 (이벤트 루프 안에서 OK)
    # limit: 1회 trigger로 처리할 광고주 수. Render free tier sequential처리 ~10초/광고주.
    bounded = max(1, min(int(limit or 3), 100))
    asyncio.create_task(process_pending(bounded))
    return {"ok": True, "queued": True, "limit": bounded, "ts": now()}


if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", "8000"))
    uvicorn.run(app, host="0.0.0.0", port=port)
