"""Mockup sequence 검증 — make_scene_sequence + composite_video 종단 호출.

- 작은 PNG 3장 (각각 빨/초/파)을 만들어
- transition 종류별로 (fade / slide-left / cut) 시퀀스 합성
- 결과 mp4 → frame 0/mid/end PNG 추출 → _pw_screens/_mockup_seq_* 저장
- 마지막에 device frame 합성까지 한 번 더 (composite_video) 돌려서
  최종 산출물이 정상 mp4인지 + 길이가 예상과 맞는지 확인

이건 라이브/Render 배포 검증이 아니라 합성 로직 로컬 검증.
"""
from __future__ import annotations

import io
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).parent
sys.path.insert(0, str(ROOT))

import imageio_ffmpeg  # noqa: E402
from api.services import mockup as mk  # noqa: E402

FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()
OUT_DIR = ROOT / "_pw_screens"
OUT_DIR.mkdir(exist_ok=True)
WORK = ROOT / "_pw_mockup_seq_work"
WORK.mkdir(exist_ok=True)


def make_color_png(path: Path, color: tuple[int, int, int], label: str) -> None:
    img = Image.new("RGB", (800, 1600), color)
    d = ImageDraw.Draw(img)
    try:
        f = ImageFont.truetype("malgun.ttf", 120)
    except Exception:
        f = ImageFont.load_default()
    d.text((400, 800), label, fill=(255, 255, 255), font=f, anchor="mm")
    img.save(path, format="PNG")


def probe_duration(mp4: Path) -> float:
    # ffmpeg 만 써서 길이 알아내기 — ffprobe 없음
    proc = subprocess.run(
        [FFMPEG, "-i", str(mp4), "-f", "null", "-"],
        capture_output=True, timeout=30,
    )
    err = proc.stderr.decode("utf-8", "replace")
    # "time=00:00:08.42" 마지막 매치
    import re
    m = list(re.finditer(r"time=(\d+):(\d+):(\d+(?:\.\d+)?)", err))
    if not m:
        return 0.0
    h, mn, s = m[-1].groups()
    return int(h) * 3600 + int(mn) * 60 + float(s)


def extract_frame(mp4: Path, t_sec: float, out_png: Path) -> None:
    subprocess.run([
        FFMPEG, "-y", "-hide_banner", "-loglevel", "error",
        "-ss", f"{t_sec:.3f}", "-i", str(mp4),
        "-frames:v", "1", str(out_png),
    ], check=True, timeout=20)


def main() -> int:
    # 1) 3장 컬러 화면 만들기
    red = WORK / "red.png";   make_color_png(red,   (200, 60, 60),  "1번 화면")
    grn = WORK / "green.png"; make_color_png(grn,   (60, 180, 90),  "2번 화면")
    blu = WORK / "blue.png";  make_color_png(blu,   (60, 100, 220), "3번 화면")

    # 2) 시퀀스 만들기 — 각 화면 2.0초, transition 다양
    scenes = [
        mk.SceneSpec(file_path=red, is_video=False, duration_sec=2.0,
                     transition="cut",        transition_ms=0),
        mk.SceneSpec(file_path=grn, is_video=False, duration_sec=2.0,
                     transition="fade",       transition_ms=500),
        mk.SceneSpec(file_path=blu, is_video=False, duration_sec=2.0,
                     transition="slide-left", transition_ms=400),
    ]
    seq_mp4 = WORK / "sequence.mp4"
    total = mk.make_scene_sequence(scenes, 800, 1600, seq_mp4)
    print(f"[seq] computed total = {total:.3f}s; file size = {seq_mp4.stat().st_size:,} bytes")
    probed = probe_duration(seq_mp4)
    print(f"[seq] ffmpeg-probed duration = {probed:.3f}s")
    # 예상: 첫 화면 transition 무시. scene[1]=fade 500ms, scene[2]=slide-left 400ms
    # 2.0 + (2.0 - 0.5) + (2.0 - 0.4) = 5.1
    expect = 2.0 + (2.0 - 0.5) + (2.0 - 0.4)
    assert abs(total - expect) < 0.01, f"length math wrong: {total} vs {expect}"
    assert abs(probed - expect) < 0.3, f"ffmpeg duration off: {probed} vs {expect}"

    # 3) 프레임 추출 (시작 / fade 중간 / slide 중간 / 끝)
    extract_frame(seq_mp4, 0.10, OUT_DIR / "_mockup_seq_01_start.png")
    extract_frame(seq_mp4, 2.10, OUT_DIR / "_mockup_seq_02_fade.png")
    extract_frame(seq_mp4, 4.00, OUT_DIR / "_mockup_seq_03_slide.png")
    extract_frame(seq_mp4, expect - 0.20, OUT_DIR / "_mockup_seq_04_end.png")

    # 4) device frame 합성까지 한 번 더 (최종 산출물 형태 확인)
    final_mp4 = WORK / "final.mp4"
    mk.composite_video(seq_mp4, "iphone-16-pro", "9:16",
                       bg_color="#1a1a2e", bg_image=None,
                       device_scale=0.85, out_path=final_mp4)
    extract_frame(final_mp4, 2.10, OUT_DIR / "_mockup_seq_05_composited.png")
    print(f"[final] {final_mp4.stat().st_size:,} bytes  duration ≈ {probe_duration(final_mp4):.3f}s")

    print("\nOK — _pw_screens/_mockup_seq_*.png 5장 확인")
    return 0


if __name__ == "__main__":
    sys.exit(main())
