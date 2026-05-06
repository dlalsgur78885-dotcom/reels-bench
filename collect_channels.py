"""
채널 자동 수집 스크립트 (GitHub Actions용)
monitored_channels 테이블에서 활성 채널을 읽고, GramSnap으로 릴스를 수집하여 Supabase에 저장합니다.

사용법:
  python collect_channels.py                # 전체 활성 채널 수집
  python collect_channels.py --username X   # 특정 채널만
"""

import os
import sys
import argparse
from datetime import datetime, timezone, timedelta

import requests

# 환경변수 (GitHub Actions에서는 secrets, 로컬에서는 .env)
try:
    from pathlib import Path
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).parent / ".env")
except ImportError:
    pass

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_ANON_KEY = os.getenv("SUPABASE_ANON_KEY")

if not SUPABASE_URL or not SUPABASE_ANON_KEY:
    print("SUPABASE_URL, SUPABASE_ANON_KEY 환경변수가 필요합니다.")
    sys.exit(1)

HEADERS = {
    "apikey": SUPABASE_ANON_KEY,
    "Authorization": f"Bearer {SUPABASE_ANON_KEY}",
    "Content-Type": "application/json",
}


def sb_get(table, query=""):
    r = requests.get(f"{SUPABASE_URL}/rest/v1/{table}?{query}", headers=HEADERS, timeout=30)
    return r.json() if r.status_code == 200 else []


def sb_post(table, data):
    h = {**HEADERS, "Prefer": "resolution=merge-duplicates"}
    r = requests.post(f"{SUPABASE_URL}/rest/v1/{table}", headers=h, json=data, timeout=30)
    return r.status_code in [200, 201]


def sb_patch(table, query, data):
    h = {**HEADERS, "Prefer": "return=minimal"}
    r = requests.patch(f"{SUPABASE_URL}/rest/v1/{table}?{query}", headers=h, json=data, timeout=30)
    return r.status_code in [200, 204]


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def collect_channel(username, min_views=0, days=0):
    """한 채널의 릴스를 GramSnap으로 수집

    Args:
        min_views: 최소 조회수 필터 (0이면 전체)
        days: 최근 N일 이내만 (0이면 전체)
    """
    import gramsnap_util

    print(f"\n[수집] @{username}")

    try:
        reels = gramsnap_util.fetch_reels(username)
    except Exception as e:
        print(f"  GramSnap 에러: {e}")
        return 0

    if not reels:
        print(f"  릴스 없음")
        return 0

    if days > 0:
        cutoff = int((datetime.now(timezone.utc) - timedelta(days=days)).timestamp())
        reels = [r for r in reels if r.timestamp >= cutoff]

    if min_views > 0:
        reels = [r for r in reels if (r.video_views or 0) >= min_views]

    if not reels:
        print(f"  조건에 맞는 릴스 없음")
        return 0

    print(f"  대상: {len(reels)}개", flush=True)

    collected = 0
    for r in reels:
        # reels 테이블
        sb_post("reels", {
            "shortcode": r.shortcode,
            "url": f"https://www.instagram.com/reel/{r.shortcode}/",
            "source": "gramsnap",
            "collected_at": now_iso(),
        })

        # reels_metadata 테이블
        meta = gramsnap_util.post_to_metadata(r)
        meta["author_username"] = username
        sb_post("reels_metadata", meta)
        collected += 1

    # 채널 정보 업데이트
    sb_patch("monitored_channels", f"username=eq.{username}", {
        "last_collected_at": now_iso(),
        "reel_count": collected,
    })

    # 썸네일 다운로드
    try:
        from api.services.thumb import download
        for r in reels:
            if r.display_url:
                download(r.shortcode, r.display_url)
    except Exception as e:
        print(f"  썸네일 다운로드 실패: {e}")

    print(f"  {collected}개 릴스 수집 완료")
    return collected


def auto_analyze():
    """분석 안 된 릴스를 자동으로 분석"""
    from api.services import pipeline

    # 메타데이터가 있는 릴스만 (video_url 필요)
    all_meta = sb_get("reels_metadata", "select=shortcode&video_url=not.is.null&limit=50000")
    all_scs = {m["shortcode"] for m in all_meta}

    # 이미 분석된 shortcode
    analyzed = sb_get("opus_analyses", "select=shortcode&limit=50000")
    analyzed_scs = {a["shortcode"] for a in analyzed}

    # 미분석 목록
    pending = sorted(all_scs - analyzed_scs)
    if not pending:
        print("\n[분석] 미분석 릴스 없음. 모두 분석 완료.", flush=True)
        return

    print(f"\n{'='*40}", flush=True)
    print(f"[자동 분석] 미분석 {len(pending)}개 시작", flush=True)
    print(f"{'='*40}", flush=True)

    ok = fail = 0
    for i, sc in enumerate(pending, 1):
        print(f"\n[{i}/{len(pending)}] {sc} 분석 중...", flush=True)
        try:
            pipeline.run(sc)
            status = pipeline.analysis_status.get(sc, {})
            if status.get("status") == "done":
                print(f"  완료", flush=True)
                ok += 1
            else:
                print(f"  실패: {status.get('message', 'unknown')}", flush=True)
                fail += 1
        except Exception as e:
            print(f"  에러: {e}", flush=True)
            fail += 1

    print(f"\n{'='*40}", flush=True)
    print(f"[분석 결과] 성공: {ok}개 | 실패: {fail}개", flush=True)
    print(f"{'='*40}", flush=True)


def auto_collect_comments():
    """댓글 미수집 릴스의 댓글을 자동 수집"""
    from api.services import comments
    import requests as _req

    all_reels = sb_get("reels", "select=shortcode&limit=50000")
    all_scs = {r["shortcode"] for r in all_reels}
    existing = sb_get("reels_comments", "select=shortcode&limit=50000")
    existing_scs = {c["shortcode"] for c in existing}
    pending = sorted(all_scs - existing_scs)

    if not pending:
        print("\n[댓글] 미수집 릴스 없음.", flush=True)
        return

    print(f"\n{'='*40}", flush=True)
    print(f"[댓글 수집] {len(pending)}개 시작", flush=True)
    print(f"{'='*40}", flush=True)

    total_comments = 0
    for i, sc in enumerate(pending, 1):
        print(f"[{i}/{len(pending)}] {sc} ...", end=" ", flush=True)
        try:
            cmts = comments.fetch_playwright(sc)
            if cmts:
                from api.services.supabase import SUPABASE_URL, SUPABASE_HEADERS
                h = {**SUPABASE_HEADERS, "Prefer": "resolution=merge-duplicates"}
                _req.post(f"{SUPABASE_URL}/rest/v1/reels_comments", headers=h, json=cmts, timeout=10)
                print(f"{len(cmts)}개", flush=True)
                total_comments += len(cmts)
            else:
                print("없음", flush=True)
        except Exception as e:
            print(f"에러: {e}", flush=True)

    print(f"[댓글 결과] {total_comments}개 수집", flush=True)


def main():
    parser = argparse.ArgumentParser(description="채널 자동 수집 + 분석")
    parser.add_argument("--username", nargs="+", help="특정 채널만 수집")
    parser.add_argument("--analyze-only", action="store_true", help="수집 없이 미분석 릴스만 분석")
    parser.add_argument("--hot", action="store_true", help="10만+ 조회수, 최근 30일만 수집+분석")
    parser.add_argument("--min-views", type=int, default=0, help="최소 조회수 (--hot 시 기본 100000)")
    parser.add_argument("--days", type=int, default=0, help="최근 N일 (--hot 시 기본 30)")
    args = parser.parse_args()

    if args.analyze_only:
        auto_analyze()
        return

    min_views = args.min_views
    days = args.days
    if args.hot:
        min_views = min_views or 100000
        days = days or 30

    if args.username:
        usernames = args.username
    else:
        channels = sb_get("monitored_channels", "select=username&is_active=eq.true")
        usernames = [c["username"] for c in channels if c.get("username")]

    if not usernames:
        print("수집할 채널이 없습니다.")
        return

    if args.hot:
        print(f"[HOT] 최근 {days}일, {min_views:,}회 이상")
    print(f"대상 채널 {len(usernames)}개: {', '.join(f'@{u}' for u in usernames)}")

    total = 0
    for username in usernames:
        total += collect_channel(username, min_views=min_views, days=days)

    print(f"\n{'='*40}")
    print(f"전체 수집 완료: {total}개 릴스 ({len(usernames)}개 채널)")
    print(f"{'='*40}")

    # 자동 분석: 아직 분석 안 된 릴스 전부 분석
    if total > 0:
        auto_analyze()
        auto_collect_comments()


if __name__ == "__main__":
    main()
