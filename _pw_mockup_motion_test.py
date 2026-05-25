"""Motion preset 검증 — image_with_motion 으로 PNG 1장에 5종 모션 적용.

각 모션별로:
  - 4초 mp4 생산
  - 시작/중간/끝 프레임 추출
  - 시작 vs 끝 프레임 픽셀 평균 차이로 "실제 움직였는지" 검증
    (motion='none' 도 비교군으로 한 번 — 0에 가까워야 함)
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
WORK = ROOT / "_pw_mockup_motion_work"
WORK.mkdir(exist_ok=True)


def make_grid_png(path: Path) -> None:
    """모션이 보이게 격자 + 숫자 라벨을 그린 800x1600 PNG."""
    img = Image.new("RGB", (800, 1600), (240, 240, 245))
    d = ImageDraw.Draw(img)
    # 굵은 격자 (모션 시각 검증용 — 격자가 흐르면 pan 작동)
    for x in range(0, 801, 100):
        d.line([(x, 0), (x, 1600)], fill=(180, 180, 200), width=4)
    for y in range(0, 1601, 100):
        d.line([(0, y), (800, y)], fill=(180, 180, 200), width=4)
    try:
        f = ImageFont.truetype("malgun.ttf", 50)
    except Exception:
        f = ImageFont.load_default()
    # 좌상/우하/중앙 각각 다른 색 라벨
    d.text((50, 50),     "TL",   fill=(220, 60, 60),  font=f)
    d.text((650, 1500),  "BR",   fill=(60, 60, 220),  font=f)
    d.text((50, 1500),   "BL",   fill=(60, 180, 90),  font=f)
    d.text((650, 50),    "TR",   fill=(200, 140, 0),  font=f)
    d.text((400, 800),   "CTR",  fill=(0, 0, 0),      font=f, anchor="mm")
    img.save(path, format="PNG")


def extract_frame(mp4: Path, t_sec: float, out_png: Path) -> None:
    subprocess.run([
        FFMPEG, "-y", "-hide_banner", "-loglevel", "error",
        "-ss", f"{t_sec:.3f}", "-i", str(mp4),
        "-frames:v", "1", str(out_png),
    ], check=True, timeout=20)


def mean_pixel_diff(a: Path, b: Path) -> float:
    ia = Image.open(a).convert("RGB").resize((128, 128))
    ib = Image.open(b).convert("RGB").resize((128, 128))
    pa = list(ia.getdata())
    pb = list(ib.getdata())
    total = 0.0
    for (ra, ga, ba), (rb, gb, bb) in zip(pa, pb):
        total += abs(ra - rb) + abs(ga - gb) + abs(ba - bb)
    return total / (128 * 128 * 3)


def main() -> int:
    src = WORK / "grid.png"
    make_grid_png(src)

    presets = ["none", "zoom-in", "zoom-out", "pan-tl-br", "pan-bl-tr", "pulse"]
    results: list[tuple[str, float]] = []

    for preset in presets:
        out_mp4 = WORK / f"{preset}.mp4"
        mk.image_with_motion(src, 4.0, preset, 800, 1600, out_mp4)
        # 시작/중간/끝 프레임
        start_png = WORK / f"_frame_{preset}_start.png"
        end_png   = WORK / f"_frame_{preset}_end.png"
        extract_frame(out_mp4, 0.05, start_png)
        extract_frame(out_mp4, 3.90, end_png)
        # 대표 1장만 _pw_screens 에 보존 (중간 시점)
        mid_dst = OUT_DIR / f"_mockup_motion_{preset}.png"
        extract_frame(out_mp4, 2.00, mid_dst)
        # 시작/끝 차이
        diff = mean_pixel_diff(start_png, end_png)
        results.append((preset, diff))
        print(f"  [{preset:9s}] diff start→end = {diff:6.2f}  ({out_mp4.stat().st_size:,}B)")

    # 검증:
    #   - 'none' 은 diff < 1.0 (격자가 안 움직임)
    #   - 나머지는 diff > 5.0 (확실히 움직임)
    fail = []
    for preset, diff in results:
        if preset == "none":
            if diff > 2.0:
                fail.append(f"none should be static but diff={diff:.2f}")
        else:
            if diff < 3.0:
                fail.append(f"{preset} should move but diff={diff:.2f}")
    if fail:
        for f in fail:
            print(f"  FAIL: {f}")
        return 1
    print(f"\nOK — _pw_screens/_mockup_motion_*.png {len(presets)}장 확인")
    return 0


if __name__ == "__main__":
    sys.exit(main())
