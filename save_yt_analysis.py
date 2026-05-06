"""YT 쇼츠 분석 결과를 youtube_shorts_* 테이블에 저장.

usage: python save_yt_analysis.py <video_id>
  - _<video_id>.mp4 / analysis_<video_id>.json / gemini3_reel_<video_id>.json 가 있다고 가정
  - yt-dlp로 메타데이터 (제목/채널/조회수) 가져와서 youtube_shorts_metadata에도 저장
"""
import os
import sys
import json
import subprocess
from pathlib import Path
from datetime import datetime, timezone
import requests
from dotenv import load_dotenv

ROOT = Path(__file__).parent
load_dotenv(ROOT / ".env")

SUPA = os.getenv("SUPABASE_URL")
KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
H = {
    "apikey": KEY,
    "Authorization": f"Bearer {KEY}",
    "Content-Type": "application/json",
    "Prefer": "resolution=merge-duplicates,return=minimal",
}

if len(sys.argv) < 2:
    sys.exit("usage: python save_yt_analysis.py <video_id>")
VID = sys.argv[1]


def fetch_yt_meta(video_id: str) -> dict:
    """yt-dlp로 메타데이터 추출."""
    r = subprocess.run(
        [sys.executable, "-m", "yt_dlp", "-J", "--no-warnings",
         f"https://www.youtube.com/shorts/{video_id}"],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    if r.returncode != 0:
        print(f"[yt-dlp] failed: {r.stderr[:200]}")
        return {}
    try:
        return json.loads(r.stdout)
    except Exception as e:
        print(f"[yt-dlp] json parse failed: {e}")
        return {}


def upsert(table: str, payload: dict):
    r = requests.post(
        f"{SUPA}/rest/v1/{table}?on_conflict=shortcode",
        headers=H, json=payload, timeout=15,
    )
    if r.status_code not in (200, 201, 204):
        print(f"[{table}] {r.status_code} {r.text[:200]}")
    else:
        print(f"[{table}] OK")


def main():
    print(f"=== save YT analysis: {VID} ===")
    # 메타 fetch
    meta = fetch_yt_meta(VID)
    title = meta.get("title") or ""
    channel = meta.get("channel") or meta.get("uploader") or ""
    handle = meta.get("uploader_id") or meta.get("channel_id") or ""
    description = meta.get("description") or ""
    duration = meta.get("duration") or 0
    view_count = meta.get("view_count") or 0
    like_count = meta.get("like_count") or 0
    comment_count = meta.get("comment_count") or 0
    thumbnail = meta.get("thumbnail") or f"https://i.ytimg.com/vi/{VID}/hqdefault.jpg"
    upload_date = meta.get("upload_date")  # YYYYMMDD
    taken_at = None
    if upload_date and len(upload_date) == 8:
        taken_at = f"{upload_date[:4]}-{upload_date[4:6]}-{upload_date[6:8]}T00:00:00+00:00"

    # 1. youtube_shorts (core)
    upsert("youtube_shorts", {
        "shortcode": VID,
        "url": f"https://www.youtube.com/shorts/{VID}",
        "source": "youtube_short",
        "collected_at": datetime.now(timezone.utc).isoformat(),
    })

    # 2. youtube_shorts_metadata
    caption = (title + "\n\n" + description).strip() if title or description else ""
    upsert("youtube_shorts_metadata", {
        "shortcode": VID,
        "view_count": view_count,
        "like_count": like_count,
        "comment_count": comment_count,
        "video_duration": duration,
        "thumbnail_url": thumbnail,
        "caption_text": caption,
        "author_username": handle,
        "author_full_name": channel,
        "taken_at": taken_at,
    })

    # 3. analysis 파일에서 audio/video 분석 가져와 youtube_shorts_pro_audio 저장
    analysis_file = ROOT / f"analysis_{VID}.json"
    if analysis_file.exists():
        ad = json.loads(analysis_file.read_text(encoding="utf-8"))
        a = ad.get("analysis") or {}
        # tts_script: analysis.tts_script 또는 tts_<vid>.json 파일에서
        tts_script = a.get("tts_script") or []
        if not tts_script:
            tts_path = ROOT / f"tts_{VID}.json"
            if tts_path.exists():
                tts_script = json.loads(tts_path.read_text(encoding="utf-8")).get("tts_script") or []
        upsert("youtube_shorts_pro_audio", {
            "shortcode": VID,
            "audio_emotions": a.get("emotion_timeline") or [],
            "pro_audio": {
                "sound_effects": a.get("sound_effects") or [],
                "bgm": a.get("bgm") or [],
                "duration_sec": a.get("duration_sec"),
                "tts_script": tts_script,
                "hook": a.get("hook"),
                "narration": a.get("narration"),
                "visual_cuts": a.get("visual_cuts") or [],
                "viral_factors": a.get("viral_factors") or [],
                "audio_events": a.get("audio_events") or [],
            },
            "bgm_changes": a.get("bgm") or [],
        })
    else:
        print(f"[skip] analysis file not found: {analysis_file.name}")

    print("\nDONE.")


if __name__ == "__main__":
    main()
