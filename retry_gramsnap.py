"""HikerAPI로 못 찾은 shortcode를 GramSnap으로 재시도 → metadata insert + 분석."""
import os
import sys
import time
from pathlib import Path
import requests
from dotenv import load_dotenv

ROOT = Path(__file__).parent
load_dotenv(ROOT / ".env")
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "api"))

from api.services import supabase, pipeline  # noqa: E402
import gramsnap_util  # noqa: E402

SUPA = os.getenv("SUPABASE_URL")
KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_ANON_KEY")
H = {"apikey": KEY, "Authorization": f"Bearer {KEY}",
     "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates,return=minimal"}

# 실패 목록 (가짜 샘플 제외)
TARGETS = [
    "DWqG0JYkRXg", "DWsuYMulHcc", "DWsY-QSjz-s",
    "DWtaShaibaB", "DWtYwSiEzFO", "DWV3AAqmbH3",
]


def get_author(shortcode: str) -> str | None:
    """reels 테이블에서 author 조회."""
    r = requests.get(
        f"{SUPA}/rest/v1/reels?shortcode=eq.{shortcode}&select=author&limit=1",
        headers={"apikey": KEY, "Authorization": f"Bearer {KEY}"},
        timeout=10,
    )
    rows = r.json()
    return rows[0].get("author") if rows else None


def gramsnap_metadata(shortcode: str, username: str) -> dict | None:
    """GramSnap으로 username의 모든 posts fetch → shortcode 매칭."""
    try:
        post = gramsnap_util.find_by_shortcode(username, shortcode)
        if post:
            return gramsnap_util.post_to_metadata(post)
    except Exception as e:
        print(f"  gramsnap error: {e}")
    return None


def upsert_metadata(payload: dict) -> bool:
    payload = {k: v for k, v in payload.items() if v is not None or k == "shortcode"}
    r = requests.post(
        f"{SUPA}/rest/v1/reels_metadata?on_conflict=shortcode",
        headers=H, json=payload, timeout=15,
    )
    return r.status_code in (200, 201, 204)


def main():
    print(f"GramSnap retry - 대상 {len(TARGETS)}개")
    counts = {"analyzed": 0, "metadata_only": 0, "no_author": 0,
              "gramsnap_miss": 0, "analyze_fail": 0}

    # author별로 그룹화 (같은 user는 한 번만 GramSnap fetch)
    sc_to_author = {}
    author_to_scs: dict[str, list[str]] = {}
    for sc in TARGETS:
        author = get_author(sc)
        sc_to_author[sc] = author
        if author:
            author_to_scs.setdefault(author, []).append(sc)

    print(f"\nauthor 그룹: {dict((a, len(scs)) for a, scs in author_to_scs.items())}")

    for author, scs in author_to_scs.items():
        if not author:
            continue
        print(f"\n=== @{author} ({len(scs)}개) ===")
        try:
            posts = gramsnap_util.fetch_all_posts(author)
            print(f"  GramSnap fetched: {len(posts)} posts")
        except Exception as e:
            print(f"  fetch fail: {e}")
            for sc in scs:
                counts["gramsnap_miss"] += 1
            continue

        # shortcode → post 매핑
        post_map = {p.shortcode: p for p in posts}
        for sc in scs:
            print(f"\n[{sc}]")
            post = post_map.get(sc)
            if not post:
                print(f"  GramSnap에도 없음")
                counts["gramsnap_miss"] += 1
                continue
            md = gramsnap_util.post_to_metadata(post)
            md["author_username"] = author
            ok = upsert_metadata(md)
            if not ok:
                print(f"  metadata upsert fail")
                counts["metadata_only"] += 1
                continue
            print(f"  metadata OK, analyzing...")
            t0 = time.time()
            try:
                pipeline.run(sc, skip_pro_audio=True)
                elapsed = time.time() - t0
                status = pipeline.analysis_status.get(sc, {}).get("status", "?")
                if status == "done":
                    print(f"  [OK] {elapsed:.0f}s")
                    counts["analyzed"] += 1
                else:
                    msg = pipeline.analysis_status.get(sc, {}).get("message", "?")
                    print(f"  [WARN] status={status} msg={msg}")
                    counts["analyze_fail"] += 1
            except Exception as e:
                print(f"  [ERR] {e}")
                counts["analyze_fail"] += 1

    # author 없는 것
    no_author_scs = [sc for sc, a in sc_to_author.items() if not a]
    counts["no_author"] = len(no_author_scs)

    print(f"\n결과: {counts}")
    if no_author_scs:
        print(f"author 없는 shortcode: {no_author_scs}")


if __name__ == "__main__":
    main()
