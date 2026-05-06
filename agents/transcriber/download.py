"""Video download + URL resolution"""

import os
import requests
from dotenv import load_dotenv
from pathlib import Path

ENV_PATH = Path(__file__).parent.parent.parent / ".env"
load_dotenv(ENV_PATH)

HIKER_API_KEY = os.getenv("HIKER_API_KEY")


def get_video_url(shortcode, username=None):
    """shortcode → video URL (GramSnap → HikerAPI fallback)"""
    try:
        import sys
        sys.path.insert(0, str(Path(__file__).parent.parent.parent))
        import gramsnap_util
        if username:
            post = gramsnap_util.find_by_shortcode(username, shortcode)
            if post and post.video_url:
                return post.video_url, gramsnap_util.post_to_metadata(post)
    except Exception:
        pass

    if HIKER_API_KEY:
        r = requests.get(
            "https://api.hikerapi.com/v1/media/by/code",
            params={"code": shortcode},
            headers={"accept": "application/json", "x-access-key": HIKER_API_KEY},
            timeout=30,
        )
        if r.status_code == 200:
            data = r.json()
            return data.get("video_url"), data
    return None, None


def download_video(video_url, output_path):
    """Download video file"""
    resp = requests.get(video_url, stream=True, timeout=60)
    resp.raise_for_status()
    with open(output_path, "wb") as f:
        for chunk in resp.iter_content(8192):
            f.write(chunk)
    return output_path
