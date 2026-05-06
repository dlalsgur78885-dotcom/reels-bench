"""FFmpeg frame and audio extraction"""

import os
import subprocess
from pathlib import Path

try:
    import imageio_ffmpeg
    FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()
except ImportError:
    FFMPEG = "ffmpeg"


def extract_frames(video_path, output_dir, interval=1):
    """Extract frames at given interval (seconds)"""
    os.makedirs(output_dir, exist_ok=True)
    fps = 1 / interval
    cmd = [FFMPEG, "-i", video_path, "-vf", f"fps={fps}", "-q:v", "2",
           os.path.join(output_dir, "frame_%04d.jpg"), "-y"]
    subprocess.run(cmd, capture_output=True, text=True)
    frames = sorted(Path(output_dir).glob("frame_*.jpg"))
    return [str(f) for f in frames]


def extract_audio(video_path, output_path):
    """Extract audio as MP3"""
    cmd = [FFMPEG, "-i", video_path, "-vn", "-acodec", "libmp3lame",
           "-q:a", "2", output_path, "-y"]
    subprocess.run(cmd, capture_output=True, text=True)
    return output_path if os.path.exists(output_path) else None
