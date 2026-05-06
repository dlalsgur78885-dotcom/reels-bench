"""
GramSnap 유틸리티
username 기반으로 릴스/피드 데이터를 가져오고, shortcode로 개별 조회도 지원.
HikerAPI 대체용.
"""

import asyncio
from datetime import datetime
from gramsnap import GramSnap, MediaType


def _run_async(coro):
    """동기 코드에서 async 함수 실행"""
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None

    if loop and loop.is_running():
        # 이미 이벤트 루프가 돌고 있으면 새 스레드에서 실행
        import concurrent.futures
        with concurrent.futures.ThreadPoolExecutor() as pool:
            return pool.submit(asyncio.run, coro).result()
    else:
        return asyncio.run(coro)


async def _fetch_posts(username):
    """GramSnap으로 계정의 전체 게시물 가져오기"""
    async with GramSnap() as gs:
        return await gs.posts(username)


def fetch_all_posts(username):
    """계정의 전체 게시물 (동기 래퍼)"""
    return _run_async(_fetch_posts(username))


def fetch_reels(username):
    """계정의 릴스만 가져오기 (product_type=clips 또는 비디오+video_url)"""
    posts = fetch_all_posts(username)
    reels = []
    for p in posts:
        if p.product_type == "clips":
            reels.append(p)
        elif p.product_type is None and p.is_video and p.video_url:
            # V2 API는 product_type이 없으므로 비디오이면서 video_url이 있으면 릴스로 간주
            reels.append(p)
    return reels


def find_by_shortcode(username, shortcode):
    """특정 shortcode의 게시물 찾기"""
    posts = fetch_all_posts(username)
    for p in posts:
        if p.shortcode == shortcode:
            return p
    return None


def post_to_metadata(post):
    """GramSnap Output → reels_metadata 형식 dict로 변환"""
    taken_at = None
    if post.timestamp:
        taken_at = datetime.utcfromtimestamp(post.timestamp).isoformat()

    return {
        "shortcode": post.shortcode,
        "play_count": post.video_views,
        "like_count": post.likes,
        "comment_count": post.comments,
        "video_url": post.video_url,
        "video_duration": None,  # GramSnap에서 제공 안 함
        "thumbnail_url": post.display_url,
        "caption_text": post.caption,
        "author_username": None,  # username은 호출 시 알고 있음
        "author_full_name": None,
        "music_artist": None,  # GramSnap에서 제공 안 함
        "music_title": None,
        "taken_at": taken_at,
    }


def refresh_video_urls(username):
    """계정의 모든 릴스 video_url을 한번에 갱신하여 {shortcode: video_url} 반환"""
    reels = fetch_reels(username)
    return {r.shortcode: r.video_url for r in reels if r.video_url}


def refresh_all_urls(username):
    """계정의 모든 릴스 video_url + thumbnail_url 갱신하여 {shortcode: {video_url, thumbnail_url}} 반환"""
    reels = fetch_reels(username)
    return {
        r.shortcode: {"video_url": r.video_url, "thumbnail_url": r.display_url}
        for r in reels if r.video_url or r.display_url
    }
