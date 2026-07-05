"""직원 담당 채널(staff_channels) 지표 동기화 — gramsnap으로 영상별 조회수·좋아요·
댓글수를 긁어 채널 행에 aggregate(sync_stats)로 저장.

reels/reels_metadata(경쟁사 벤치·분석 파이프라인)는 건드리지 않는다 — 직원 자기
채널을 벤치에 섞거나 비싼 opus 분석을 돌리지 않기 위함. API(_channel_with_metrics)가
bench 수집데이터가 없을 때 이 sync_stats를 대신 쓴다.

현재 IG만 (gramsnap). YT/틱톡은 별도 소스 필요.

사용:
  python sync_staff_channels.py                 # 전체 IG staff 채널
  python sync_staff_channels.py --handle X       # 특정 handle만
"""
import os, sys, argparse
from datetime import datetime, timezone
import requests

try:
    from pathlib import Path
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).parent / ".env")
except ImportError:
    pass

SUPA = os.getenv("SUPABASE_URL")
KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_ANON_KEY")
if not SUPA or not KEY:
    print("SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY 필요"); sys.exit(1)
H = {"apikey": KEY, "Authorization": f"Bearer {KEY}", "Content-Type": "application/json"}


def sb_get(table, query=""):
    r = requests.get(f"{SUPA}/rest/v1/{table}?{query}", headers=H, timeout=30)
    return r.json() if r.status_code == 200 else []


def sb_patch(table, query, data):
    h = {**H, "Prefer": "return=minimal"}
    r = requests.patch(f"{SUPA}/rest/v1/{table}?{query}", headers=h, json=data, timeout=30)
    return r.status_code in (200, 204)


def _stat(arr, n):
    return {"total": sum(arr), "avg": round(sum(arr) / n)} if n else {"total": 0, "avg": 0}


def sync_handle(handle: str) -> dict | None:
    """gramsnap으로 handle의 릴스 지표 집계 → sync_stats dict."""
    import gramsnap_util
    try:
        reels = gramsnap_util.fetch_reels(handle)
    except Exception as e:
        print(f"  [{handle}] gramsnap 에러: {str(e)[:100]}", flush=True)
        return None
    if not reels:
        print(f"  [{handle}] 릴스 없음", flush=True)
        return {"collected_posts": 0}
    views = [int(getattr(r, "video_views", 0) or 0) for r in reels]
    likes = [int(getattr(r, "likes", 0) or 0) for r in reels]
    comments = [int(getattr(r, "comments", 0) or 0) for r in reels]
    n = len(reels)
    return {
        "collected_posts": n,
        "views": _stat(views, n),
        "likes": _stat(likes, n),
        "comments": _stat(comments, n),
        "avg_views": round(sum(views) / n) if n else 0,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--handle", help="특정 handle만")
    args = ap.parse_args()

    rows = sb_get("staff_channels", "select=handle&platform=eq.instagram")
    handles = sorted({r["handle"] for r in rows if r.get("handle")})
    if args.handle:
        handles = [args.handle.lstrip("@").lower()]
    if not handles:
        print("동기화할 IG staff 채널 없음"); return
    print(f"IG staff 채널 {len(handles)}개 동기화 시작", flush=True)

    now = datetime.now(timezone.utc).isoformat()
    ok = 0
    for h in handles:
        print(f"[동기화] @{h}", flush=True)
        stats = sync_handle(h)
        if stats is None:
            continue
        # 같은 handle의 모든 행(여러 직원이 등록했을 수 있음) 갱신
        patched = sb_patch(
            "staff_channels", f"platform=eq.instagram&handle=eq.{h}",
            {"sync_stats": stats, "posts": stats.get("collected_posts"), "last_synced_at": now},
        )
        if patched:
            ok += 1
            print(f"  → 영상 {stats.get('collected_posts')} · 평균조회 {stats.get('avg_views')}", flush=True)
    print(f"\n동기화 완료: {ok}/{len(handles)}개", flush=True)


if __name__ == "__main__":
    main()
