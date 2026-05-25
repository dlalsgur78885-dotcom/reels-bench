"""shots.so 벤치 추가분 검증 — shadow / style / hide_mockup / radius_override.

각 항목별로 iPhone 16 Pro frame PNG (또는 composite) 1샘플씩 _pw_screens/_mockup_shots_*.png.
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
WORK = ROOT / "_pw_mockup_shots_work"
WORK.mkdir(exist_ok=True)


def make_sample_png(path: Path, label: str) -> None:
    img = Image.new("RGB", (800, 1600), (50, 80, 130))
    d = ImageDraw.Draw(img)
    try:
        f = ImageFont.truetype("malgun.ttf", 100)
    except Exception:
        f = ImageFont.load_default()
    d.text((400, 800), label, fill=(255, 255, 255), font=f, anchor="mm")
    img.save(path, format="PNG")


def main() -> int:
    failures: list[str] = []
    src = WORK / "src.png"
    make_sample_png(src, "TEST")

    # ── 그림자 5종 — frame PNG 단독으로 비교 ─────────────────────────
    print("[SHADOW 5종]")
    base_png = mk.render_device_frame("iphone-16-pro")
    for sid in mk.DEVICE_SHADOWS.keys():
        try:
            shadowed = mk.add_device_shadow(base_png, sid, opacity=1.0)
            assert shadowed[:8] == b"\x89PNG\r\n\x1a\n"
            print(f"  ✓ shadow={sid:8s}  {len(shadowed):,}B")
            # 대표 1샘플 보존
            (OUT_DIR / f"_mockup_shots_shadow_{sid}.png").write_bytes(shadowed)
        except Exception as e:
            failures.append(f"shadow {sid}: {e}")

    # 'none' 은 byte-identical 확인
    none_out = mk.add_device_shadow(base_png, "none")
    if none_out == base_png:
        print(f"  ✓ none = byte-identical")
    else:
        failures.append("shadow none should be byte-identical")

    # ── 스타일 3종 ──────────────────────────────────────────────────
    print("\n[STYLE 3종]")
    for st in ("default", "outline", "glass"):
        try:
            png = mk.render_device_frame("iphone-16-pro", style=st)
            assert png[:8] == b"\x89PNG\r\n\x1a\n"
            print(f"  ✓ style={st:8s}  {len(png):,}B")
            (OUT_DIR / f"_mockup_shots_style_{st}.png").write_bytes(png)
        except Exception as e:
            failures.append(f"style {st}: {e}")

    # ── radius override ────────────────────────────────────────────
    print("\n[RADIUS OVERRIDE]")
    for r in (0, 60, 240):
        try:
            png = mk.render_device_frame("iphone-16-pro", radius_override=r)
            print(f"  ✓ radius={r:4d}  {len(png):,}B")
            (OUT_DIR / f"_mockup_shots_radius_{r}.png").write_bytes(png)
        except Exception as e:
            failures.append(f"radius {r}: {e}")

    # ── hide_mockup 합성 비교 ──────────────────────────────────────
    print("\n[HIDE MOCKUP]")
    for hide, name in [(False, "with_frame"), (True, "no_frame")]:
        out = WORK / f"hide_{name}.mp4"
        try:
            mk.composite_video(src, "iphone-16-pro", "9:16", "#1a1a2e", None,
                               0.85, out, hide_mockup=hide)
            print(f"  ✓ hide_mockup={hide}: {out.stat().st_size:,}B")
            # 첫 프레임 PNG 추출
            subprocess.run([
                FFMPEG, "-y", "-hide_banner", "-loglevel", "error",
                "-i", str(out), "-frames:v", "1",
                str(OUT_DIR / f"_mockup_shots_{name}.png"),
            ], check=True, timeout=20)
        except Exception as e:
            failures.append(f"hide_mockup={hide}: {e}")

    # ── 통합 합성 1샘플 — shadow=soft + style=glass ─────────────────
    print("\n[통합 1샘플 — soft shadow + glass style]")
    out = WORK / "combo.mp4"
    try:
        mk.composite_video(src, "iphone-16-pro", "9:16", "#1a1a2e", None,
                           0.85, out,
                           bg_preset="cosmic",
                           device_shadow="soft", device_shadow_opacity=0.8,
                           device_style="glass",
                           radius_override=100)
        print(f"  ✓ combo: {out.stat().st_size:,}B")
        subprocess.run([
            FFMPEG, "-y", "-hide_banner", "-loglevel", "error",
            "-i", str(out), "-frames:v", "1",
            str(OUT_DIR / "_mockup_shots_combo.png"),
        ], check=True, timeout=20)
    except Exception as e:
        failures.append(f"combo: {e}")

    print()
    if failures:
        print("FAIL:")
        for f in failures: print(f"  • {f}")
        return 1
    print("OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
