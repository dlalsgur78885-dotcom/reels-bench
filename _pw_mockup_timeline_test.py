"""Animation timeline 검증 — build_image_timeline.

3 keyframe 타임라인:
  0~3s zoom-in
  3~5s pan-tl-br
  5~8s zoom-out
→ 8초 mp4 + 1/4/7초 프레임 추출 + 시작/끝 차이 검증.

빈 keyframes = 어떻게 처리되는지 (fallback 'none' 1 segment) 도 확인.
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
WORK = ROOT / "_pw_mockup_timeline_work"
WORK.mkdir(exist_ok=True)


def make_grid(path: Path) -> None:
    img = Image.new("RGB", (800, 1600), (240, 240, 245))
    d = ImageDraw.Draw(img)
    for x in range(0, 801, 100):
        d.line([(x, 0), (x, 1600)], fill=(180, 180, 200), width=4)
    for y in range(0, 1601, 100):
        d.line([(0, y), (800, y)], fill=(180, 180, 200), width=4)
    try:
        f = ImageFont.truetype("malgun.ttf", 50)
    except Exception:
        f = ImageFont.load_default()
    d.text((50, 50),    "TL", fill=(220, 60, 60), font=f)
    d.text((650, 50),   "TR", fill=(200, 140, 0), font=f)
    d.text((50, 1500),  "BL", fill=(60, 180, 90), font=f)
    d.text((650, 1500), "BR", fill=(60, 60, 220), font=f)
    d.text((400, 800),  "CTR", fill=(0, 0, 0), font=f, anchor="mm")
    img.save(path, format="PNG")


def probe_duration(mp4: Path) -> float:
    proc = subprocess.run(
        [FFMPEG, "-i", str(mp4), "-f", "null", "-"],
        capture_output=True, timeout=30,
    )
    import re
    err = proc.stderr.decode("utf-8", "replace")
    m = list(re.finditer(r"time=(\d+):(\d+):(\d+(?:\.\d+)?)", err))
    if not m: return 0.0
    h, mn, s = m[-1].groups()
    return int(h) * 3600 + int(mn) * 60 + float(s)


def extract_frame(mp4: Path, t_sec: float, out_png: Path) -> None:
    subprocess.run([
        FFMPEG, "-y", "-hide_banner", "-loglevel", "error",
        "-i", str(mp4), "-ss", f"{t_sec:.3f}",
        "-frames:v", "1", str(out_png),
    ], check=True, timeout=20)


def mean_diff(a: Path, b: Path) -> float:
    ia = Image.open(a).convert("RGB").resize((128, 128))
    ib = Image.open(b).convert("RGB").resize((128, 128))
    pa, pb = list(ia.getdata()), list(ib.getdata())
    total = 0.0
    for (ra,ga,ba), (rb,gb,bb) in zip(pa, pb):
        total += abs(ra-rb)+abs(ga-gb)+abs(ba-bb)
    return total / (128*128*3)


def main() -> int:
    src = WORK / "grid.png"
    make_grid(src)
    failures: list[str] = []

    # ── 1. 3 keyframe 타임라인 ─────────────────────────────────────
    keyframes = [
        mk.AnimKeyframe(0.0, 3.0, "zoom-in"),
        mk.AnimKeyframe(3.0, 5.0, "pan-tl-br"),
        mk.AnimKeyframe(5.0, 8.0, "zoom-out"),
    ]
    out = WORK / "timeline.mp4"
    print("[3-segment timeline]")
    mk.build_image_timeline(src, keyframes, 8.0, 800, 1600, out)
    dur = probe_duration(out)
    print(f"  duration probed: {dur:.2f}s (expected ~8.0)  size: {out.stat().st_size:,}B")
    if abs(dur - 8.0) > 0.5:
        failures.append(f"timeline duration off: {dur}")

    # 1초/4초/7초 프레임 추출 — 각 segment 중간
    for t in (1.0, 4.0, 7.0):
        extract_frame(out, t, OUT_DIR / f"_mockup_timeline_t{int(t)}.png")

    # 각 시점이 서로 달라야 (다른 motion 적용 중)
    d_01_04 = mean_diff(OUT_DIR / "_mockup_timeline_t1.png",
                        OUT_DIR / "_mockup_timeline_t4.png")
    d_04_07 = mean_diff(OUT_DIR / "_mockup_timeline_t4.png",
                        OUT_DIR / "_mockup_timeline_t7.png")
    d_01_07 = mean_diff(OUT_DIR / "_mockup_timeline_t1.png",
                        OUT_DIR / "_mockup_timeline_t7.png")
    print(f"  diff t=1↔t=4: {d_01_04:.2f}")
    print(f"  diff t=4↔t=7: {d_04_07:.2f}")
    print(f"  diff t=1↔t=7: {d_01_07:.2f} (note: zoom-in 1/3 ≈ zoom-out 2/3 → "
          f"same zoom factor 1.06 → can be coincidentally similar)")
    # 인접 segment 차이만 검증 — t=1↔t=7 은 zoom-in/zoom-out 진행도가 우연히
    # 같은 zoom factor 일 수 있어 제외.
    if d_01_04 < 2.0 or d_04_07 < 2.0:
        failures.append("adjacent segments not visually distinct")

    # ── 2. 빈 keyframes — fallback 'none' 1 segment ─────────────
    print("\n[empty keyframes fallback]")
    out_empty = WORK / "empty.mp4"
    mk.build_image_timeline(src, [], 4.0, 800, 1600, out_empty)
    dur_e = probe_duration(out_empty)
    print(f"  duration: {dur_e:.2f}s (expected ~4.0)")
    if abs(dur_e - 4.0) > 0.5:
        failures.append(f"empty keyframes duration off: {dur_e}")

    # ── 3. 겹치는 keyframes — 정리되는지 ─────────────────────────
    print("\n[overlapping keyframes]")
    overlapping = [
        mk.AnimKeyframe(0.0, 4.0, "zoom-in"),
        mk.AnimKeyframe(2.0, 6.0, "zoom-out"),  # 0~4 의 [2,4] 와 겹침
    ]
    fixed = mk._fill_timeline_gaps(overlapping, 6.0)
    print(f"  resolved {len(fixed)} segments:")
    for s in fixed:
        print(f"    [{s.start_sec:.1f}, {s.end_sec:.1f}] {s.motion}")
    # 예상: [0,2 zoom-in] [2,6 zoom-out]
    if not (len(fixed) == 2
            and fixed[0].end_sec == 2.0
            and fixed[1].start_sec == 2.0):
        failures.append(f"overlap resolution wrong: {fixed}")

    print()
    if failures:
        print("FAIL:")
        for f in failures: print(f"  • {f}")
        return 1
    print("OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
