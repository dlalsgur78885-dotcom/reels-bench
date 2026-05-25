"""shots.so 벤치 통합 검증 — 4 phase 일괄.

(⑤) 추가 비율 — 4:5 / 3:4 / 16:10 / 4:3 모두 mp4 정상 출력
(③) 추가 디바이스 5종 — frame PNG 정상 (alpha + dimensions)
(②) 배경 카탈로그 — 11종 모두 thumbnail 생성, mp4 합성 1샘플
(④) 마감 효과 5종 — mp4 합성, 크기/존재 sanity check

_pw_screens/_mockup_bench_*.png 에 대표 산출물 저장.
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
WORK = ROOT / "_pw_mockup_bench_work"
WORK.mkdir(exist_ok=True)


def make_sample_png(path: Path, label: str) -> None:
    img = Image.new("RGB", (800, 1600), (40, 60, 90))
    d = ImageDraw.Draw(img)
    try:
        f = ImageFont.truetype("malgun.ttf", 100)
    except Exception:
        f = ImageFont.load_default()
    d.text((400, 800), label, fill=(255, 255, 255), font=f, anchor="mm")
    img.save(path, format="PNG")


def extract_frame(mp4: Path, t_sec: float, out_png: Path) -> None:
    # 1프레임짜리 image-source mp4 도 안전하게 — -ss 를 input 뒤로 두면
    # 짧은 mp4 에서도 첫 프레임을 깎지 않음.
    subprocess.run([
        FFMPEG, "-y", "-hide_banner", "-loglevel", "error",
        "-i", str(mp4),
        "-ss", f"{t_sec:.3f}",
        "-frames:v", "1", str(out_png),
    ], check=True, timeout=20)
    # 그래도 비어 있으면 t_sec=0 fallback
    if not out_png.exists() or out_png.stat().st_size == 0:
        subprocess.run([
            FFMPEG, "-y", "-hide_banner", "-loglevel", "error",
            "-i", str(mp4), "-frames:v", "1", str(out_png),
        ], check=True, timeout=20)


def main() -> int:
    failures: list[str] = []

    # ── ⑤ 새 비율 ────────────────────────────────────────────────────
    new_aspects = ["4:5", "3:4", "16:10", "4:3"]
    print("[⑤ aspects]")
    src = WORK / "src.png"
    make_sample_png(src, "ASPECT")
    for asp in new_aspects:
        out = WORK / f"aspect_{asp.replace(':', 'x')}.mp4"
        try:
            mk.composite_video(src, "iphone-16-pro", asp, "#1a1a2e", None, 0.85, out)
            w, h = mk.ASPECTS[asp]
            print(f"  ✓ {asp}: {w}x{h}  {out.stat().st_size:,}B")
            # 대표 1샘플만 보존
            if asp == "4:5":
                extract_frame(out, 0.05, OUT_DIR / "_mockup_bench_aspect_4-5.png")
        except Exception as e:
            failures.append(f"aspect {asp}: {e}")

    # ── ③ 새 디바이스 ───────────────────────────────────────────────
    new_devices = ["iphone-16", "iphone-16-pro-max", "galaxy-s25", "galaxy-s25-ultra", "pixel-9"]
    print("\n[③ devices]")
    for did in new_devices:
        try:
            png = mk.render_device_frame(did)
            assert png[:8] == b"\x89PNG\r\n\x1a\n", "not a PNG"
            spec = mk.DEVICES[did]
            # frame PNG 차원 확인
            im = Image.open(io.BytesIO(png))
            assert im.size == (spec["body_w"], spec["body_h"]), \
                f"size mismatch: {im.size} vs {spec['body_w']}x{spec['body_h']}"
            # 알파 채널 cutout (screen 영역)이 투명한지 — 중앙 픽셀 alpha == 0
            cx, cy = spec["body_w"] // 2, spec["body_h"] // 2
            a = im.getpixel((cx, cy))[3]
            assert a == 0, f"{did} screen center alpha = {a}, expected 0"
            print(f"  ✓ {did}: {spec['body_w']}x{spec['body_h']}  {len(png):,}B  α(중앙)=0")
            # 대표 1샘플만 보존
            if did == "galaxy-s25-ultra":
                (OUT_DIR / "_mockup_bench_device_galaxy-s25-ultra.png").write_bytes(png)
        except Exception as e:
            failures.append(f"device {did}: {e}")

    # ── ② 배경 카탈로그 ─────────────────────────────────────────────
    print("\n[② bg presets]")
    for pid in mk.BG_PRESETS.keys():
        try:
            thumb = mk.render_bg_preset_thumbnail(pid)
            assert thumb[:8] == b"\x89PNG\r\n\x1a\n", "not a PNG"
            print(f"  ✓ {pid:10s}: thumb {len(thumb):,}B")
            # 대표 3종만 _pw_screens 에 — cosmic / mesh-warm / glass
            if pid in ("cosmic", "mesh-warm", "glass"):
                (OUT_DIR / f"_mockup_bench_bg_{pid}.png").write_bytes(thumb)
        except Exception as e:
            failures.append(f"bg {pid}: {e}")

    # bg preset 으로 실제 합성 1샘플
    try:
        out = WORK / "bg_cosmic_full.mp4"
        mk.composite_video(src, "iphone-16-pro", "9:16", "#000000", None,
                           0.85, out, bg_preset="cosmic")
        extract_frame(out, 0.05, OUT_DIR / "_mockup_bench_bg_cosmic_composited.png")
        print(f"  ✓ bg_preset=cosmic composite: {out.stat().st_size:,}B")
    except Exception as e:
        failures.append(f"bg composite: {e}")

    # ── ④ 마감 효과 ─────────────────────────────────────────────────
    print("\n[④ overlay effects]")
    effects = ["vhs", "glitch", "grain", "scanlines", "vintage"]
    for eid in effects:
        try:
            out = WORK / f"effect_{eid}.mp4"
            mk.composite_video(src, "iphone-16-pro", "9:16", "#1a1a2e", None,
                               0.85, out, overlay_effect=eid)
            print(f"  ✓ {eid:10s}: {out.stat().st_size:,}B")
            # 대표 2종 보존 — vhs / glitch
            if eid in ("vhs", "glitch"):
                extract_frame(out, 0.05, OUT_DIR / f"_mockup_bench_effect_{eid}.png")
        except Exception as e:
            failures.append(f"effect {eid}: {e}")

    # ── 결과 ───────────────────────────────────────────────────────
    print()
    if failures:
        print("FAIL:")
        for f in failures:
            print(f"  • {f}")
        return 1
    print("OK — _pw_screens/_mockup_bench_*.png 8장 대표 저장")
    return 0


if __name__ == "__main__":
    sys.exit(main())
