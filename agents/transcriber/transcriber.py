"""
Transcriber Agent — Main Pipeline
Downloads reel, extracts frames/audio, runs Whisper + Gemini analysis.

Usage:
  python transcriber.py --shortcode "ABC123"
  python transcriber.py --batch
"""

import os
import sys
import json
import tempfile
import argparse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from . import download, extract, whisper_stt, frame_analysis


def process_reel(shortcode=None, video_url=None):
    """Full single-reel analysis pipeline"""
    print(f"[start] {shortcode or video_url[:50]}")

    metadata = None

    # 1. Get video URL
    if not video_url and shortcode:
        video_url, metadata = download.get_video_url(shortcode)
    if not video_url:
        print("[error] Cannot get video URL")
        return None

    with tempfile.TemporaryDirectory() as tmpdir:
        video_path = os.path.join(tmpdir, "reel.mp4")
        frames_dir = os.path.join(tmpdir, "frames")
        audio_path = os.path.join(tmpdir, "audio.mp3")

        # 2. Download
        download.download_video(video_url, video_path)

        # 3. Extract frames + audio
        frame_paths = extract.extract_frames(video_path, frames_dir)
        audio_file = extract.extract_audio(video_path, audio_path)

        # 4. Whisper STT
        transcript_data = None
        if audio_file:
            transcript_data = whisper_stt.transcribe(audio_file)
            if transcript_data:
                print(f"[transcript] {len(transcript_data['transcript'])} chars")

        # 5. Frame analysis
        frame_text = ""
        if frame_paths:
            frame_text = frame_analysis.analyze_batch(frame_paths)
            print(f"[frames] {len(frame_text)} chars")

        return {
            "shortcode": shortcode,
            "transcript": transcript_data,
            "frame_analysis": frame_text,
            "metadata": metadata,
        }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Reels Transcriber Agent")
    parser.add_argument("--shortcode", help="Reel shortcode")
    parser.add_argument("--url", help="Video URL")
    args = parser.parse_args()

    if args.shortcode:
        result = process_reel(shortcode=args.shortcode)
    elif args.url:
        result = process_reel(video_url=args.url)
    else:
        parser.print_help()
        sys.exit(0)

    if result:
        print(json.dumps({k: v for k, v in result.items() if k != "frame_analysis"}, ensure_ascii=False, indent=2)[:500])
