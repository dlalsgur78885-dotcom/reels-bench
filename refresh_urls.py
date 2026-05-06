"""
릴스 URL 자동 갱신 상주 프로그램
만료된 video_url / thumbnail_url을 주기적으로 체크하고 GramSnap으로 갱신 → DB 업데이트

사용법:
  python refresh_urls.py                  # 1시간 간격으로 계속 실행
  python refresh_urls.py --interval 30    # 30분 간격
  python refresh_urls.py --once           # 1회만 실행
  python refresh_urls.py --dry-run        # 미리보기 (1회)
"""

import os
import sys
import time
import argparse
from pathlib import Path
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor

import requests
from dotenv import load_dotenv

# 인코딩
if sys.stdout.encoding != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

# .env
load_dotenv(Path(__file__).parent / ".env")

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_ANON_KEY = os.getenv("SUPABASE_ANON_KEY")

SUPABASE_HEADERS = {
    "apikey": SUPABASE_ANON_KEY,
    "Authorization": f"Bearer {SUPABASE_ANON_KEY}",
    "Content-Type": "application/json",
}

import gramsnap_util

HIKER_API_KEY = os.getenv("HIKER_API_KEY")


def hiker_get_urls(shortcode):
    """HikerAPI로 shortcode 직접 조회 → video_url, thumbnail_url"""
    if not HIKER_API_KEY:
        return None
    try:
        r = requests.get(
            "https://api.hikerapi.com/v1/media/by/code",
            params={"code": shortcode},
            headers={"accept": "application/json", "x-access-key": HIKER_API_KEY},
            timeout=30,
        )
        if r.status_code == 200:
            data = r.json()
            video = data.get("video_url")
            thumb = data.get("thumbnail_url")
            if video or thumb:
                return {"video_url": video, "thumbnail_url": thumb}
    except Exception:
        pass
    return None


def sb_get(table, query=""):
    r = requests.get(
        f"{SUPABASE_URL}/rest/v1/{table}?{query}",
        headers=SUPABASE_HEADERS,
        timeout=30,
    )
    return r.json() if r.status_code == 200 else []


def sb_update_urls(shortcode, video_url=None, thumbnail_url=None):
    """reels_metadata 테이블의 video_url, thumbnail_url 업데이트"""
    payload = {"fetched_at": datetime.now(tz=None).astimezone().isoformat()}
    if video_url:
        payload["video_url"] = video_url
    if thumbnail_url:
        payload["thumbnail_url"] = thumbnail_url
    r = requests.patch(
        f"{SUPABASE_URL}/rest/v1/reels_metadata?shortcode=eq.{shortcode}",
        headers={**SUPABASE_HEADERS, "Prefer": "return=minimal"},
        json=payload,
        timeout=30,
    )
    return r.status_code in [200, 204]


def is_url_expired(url):
    """HEAD 요청으로 URL 만료 여부 체크 (403/404 = 만료)"""
    if not url:
        return True
    try:
        r = requests.head(url, timeout=5, allow_redirects=True)
        return r.status_code in [403, 404, 410]
    except Exception:
        return True


def check_and_refresh(dry_run=False):
    """만료된 URL만 찾아서 자동 갱신. 갱신 수 반환."""
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"\n{'='*50}")
    print(f"[{now}] URL 갱신 사이클 시작")
    print(f"{'='*50}")

    meta_rows = sb_get("reels_metadata", "select=shortcode,author_username,video_url,thumbnail_url&limit=50000")
    if not meta_rows:
        print("[갱신] 메타데이터 없음")
        return 0

    print(f"[만료 체크] {len(meta_rows)}개 릴스 URL 병렬 확인 중...")

    # 병렬로 만료 체크
    def _check_one(m):
        sc = m.get("shortcode", "")
        video_expired = is_url_expired(m.get("video_url"))
        thumb_expired = is_url_expired(m.get("thumbnail_url"))
        if video_expired or thumb_expired:
            return {"shortcode": sc, "username": m.get("author_username", ""),
                    "video_expired": video_expired, "thumb_expired": thumb_expired}
        return None

    expired = []
    with ThreadPoolExecutor(max_workers=10) as ex:
        for result in ex.map(_check_one, meta_rows):
            if result:
                expired.append(result)

    print(f"  {len(meta_rows)}개 체크 완료 (만료: {len(expired)}개)")

    if not expired:
        print(f"[결과] 만료된 URL 없음. 모두 정상.")
        return 0

    print(f"\n[갱신] 만료 {len(expired)}개 발견 → 갱신 시작")

    # username별로 그룹핑
    by_user = {}
    for e in expired:
        by_user.setdefault(e["username"], []).append(e)

    total_updated = 0
    total_failed = 0

    for username, items in by_user.items():
        if not username:
            print(f"  [스킵] username 없는 릴스 {len(items)}개")
            total_failed += len(items)
            continue

        print(f"\n  @{username} ({len(items)}개 만료)")

        try:
            fresh_urls = gramsnap_util.refresh_all_urls(username)
        except Exception as e:
            print(f"    GramSnap 에러: {e} → HikerAPI로 개별 시도")
            fresh_urls = {}

        for item in items:
            sc = item["shortcode"]
            if sc in fresh_urls:
                urls = fresh_urls[sc]
                if dry_run:
                    print(f"    [미리보기] {sc}")
                else:
                    if sb_update_urls(sc, video_url=urls.get("video_url"), thumbnail_url=urls.get("thumbnail_url")):
                        print(f"    [갱신] {sc}")
                        total_updated += 1
                    else:
                        print(f"    [실패] {sc}")
                        total_failed += 1
            else:
                # HikerAPI fallback (shortcode 직접 조회)
                hiker = hiker_get_urls(sc)
                if hiker:
                    if dry_run:
                        print(f"    [미리보기/Hiker] {sc}")
                    elif sb_update_urls(sc, video_url=hiker.get("video_url"), thumbnail_url=hiker.get("thumbnail_url")):
                        print(f"    [갱신/Hiker] {sc}")
                        total_updated += 1
                    else:
                        print(f"    [실패] {sc}")
                        total_failed += 1
                else:
                    print(f"    [못찾음] {sc} (삭제된 릴스)")
                    total_failed += 1

    print(f"\n[갱신 결과] 성공: {total_updated}개 | 실패: {total_failed}개")

    # 썸네일 로컬 다운로드
    if not dry_run and total_updated > 0:
        try:
            from api.services.thumb import download_batch, count
            meta = sb_get("reels_metadata", "select=shortcode,thumbnail_url&limit=50000")
            items = [(m["shortcode"], m.get("thumbnail_url", "")) for m in meta]
            ok = download_batch(items)
            print(f"[썸네일] {ok}개 새로 다운로드 (총 {count()}개 저장됨)")
        except Exception as e:
            print(f"[썸네일] 다운로드 실패: {e}")

    return total_updated


def run_loop(interval_min=60, dry_run=False):
    """주기적으로 계속 실행"""
    print(f"{'='*50}")
    print(f"  URL 자동 갱신 프로그램 시작")
    print(f"  주기: {interval_min}분 | Ctrl+C로 종료")
    print(f"{'='*50}")

    while True:
        try:
            check_and_refresh(dry_run=dry_run)
        except Exception as e:
            print(f"\n[에러] {e}")

        next_time = datetime.now().strftime("%H:%M:%S")
        print(f"\n[대기] 다음 체크까지 {interval_min}분... (시작: {next_time})")
        try:
            time.sleep(interval_min * 60)
        except KeyboardInterrupt:
            print("\n[종료] Ctrl+C")
            break


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="릴스 URL 자동 갱신 상주 프로그램")
    parser.add_argument("--interval", type=int, default=60, help="체크 주기 (분, 기본 60)")
    parser.add_argument("--once", action="store_true", help="1회만 실행 후 종료")
    parser.add_argument("--dry-run", action="store_true", help="실제 업데이트 없이 미리보기 (1회)")
    args = parser.parse_args()

    if args.dry_run or args.once:
        check_and_refresh(dry_run=args.dry_run)
    else:
        run_loop(interval_min=args.interval)
