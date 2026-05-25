"""shots.so 후순위 격차 4종 통합 검증.

- Templates 8종: TEMPLATES dict 존재 + 각 항목 필드 sanity
- STYLE 8종 (default/outline/border/glass/glass-light/glass-dark/liquid-glass/inset-light/inset-dark): frame PNG 생성
- Tilt: 0/0 byte-identical + 15/0, 0/15 변형
- Scene Shapes 6종: 배경 PNG 생성 비교

각 항목 1샘플씩 _pw_screens/_mockup_phase2_*.png.
"""
from __future__ import annotations

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
WORK = ROOT / "_pw_mockup_phase2_work"
WORK.mkdir(exist_ok=True)


def make_sample(path: Path) -> None:
    img = Image.new("RGB", (800, 1600), (40, 80, 130))
    d = ImageDraw.Draw(img)
    try:
        f = ImageFont.truetype("malgun.ttf", 100)
    except Exception:
        f = ImageFont.load_default()
    d.text((400, 800), "PHASE 2", fill=(255, 255, 255), font=f, anchor="mm")
    img.save(path, format="PNG")


def extract_frame(mp4: Path, t_sec: float, out_png: Path) -> None:
    subprocess.run([
        FFMPEG, "-y", "-hide_banner", "-loglevel", "error",
        "-i", str(mp4), "-ss", f"{t_sec:.3f}",
        "-frames:v", "1", str(out_png),
    ], check=True, timeout=20)
    if not out_png.exists() or out_png.stat().st_size == 0:
        subprocess.run([
            FFMPEG, "-y", "-hide_banner", "-loglevel", "error",
            "-i", str(mp4), "-frames:v", "1", str(out_png),
        ], check=True, timeout=20)


def main() -> int:
    failures: list[str] = []
    src = WORK / "src.png"
    make_sample(src)

    # ── Templates ────────────────────────────────────────────────────
    print("[Templates]")
    required_fields = {"label", "device_id", "aspect", "bg_preset",
                       "device_style", "device_shadow", "overlay_effect", "motion"}
    print(f"  total: {len(mk.TEMPLATES)}")
    for tid, spec in mk.TEMPLATES.items():
        missing = required_fields - set(spec.keys())
        if missing:
            failures.append(f"template {tid} missing {missing}")
            continue
        # device/bg/style 실존 검증
        if spec["device_id"] not in mk.DEVICES:
            failures.append(f"template {tid} bad device: {spec['device_id']}")
        if spec["bg_preset"] not in mk.BG_PRESETS:
            failures.append(f"template {tid} bad bg_preset: {spec['bg_preset']}")
        if spec["device_style"] not in mk.DEVICE_STYLES:
            failures.append(f"template {tid} bad style: {spec['device_style']}")
        if spec["aspect"] not in mk.ASPECTS:
            failures.append(f"template {tid} bad aspect: {spec['aspect']}")
        print(f"  ✓ {tid:18s} {spec['label']}")

    # ── STYLE 8종 ────────────────────────────────────────────────────
    print(f"\n[STYLE {len(mk.DEVICE_STYLES)}종]")
    for sid in mk.DEVICE_STYLES.keys():
        try:
            png = mk.render_device_frame("iphone-16-pro", style=sid)
            assert png[:8] == b"\x89PNG\r\n\x1a\n"
            (OUT_DIR / f"_mockup_phase2_style_{sid}.png").write_bytes(png)
            print(f"  ✓ {sid:14s} {len(png):,}B")
        except Exception as e:
            failures.append(f"style {sid}: {e}")

    # ── Tilt: 0/0 byte-identical + 15/0 + 0/15 ─────────────────────
    print("\n[Tilt]")
    # 0/0 ⇒ '' (byte-identical 가드)
    if mk.tilt_perspective(0, 0) != "":
        failures.append("tilt 0/0 should return empty string")
    else:
        print(f"  ✓ tilt(0,0) = byte-identical")
    # 15/0 (w/h 필수 — pixel coord 직접 계산)
    s1 = mk.tilt_perspective(15, 0, 1080, 1920)
    if "perspective=" in s1:
        print(f"  ✓ tilt(15,0): {s1[:60]}...")
    else:
        failures.append(f"tilt(15,0) malformed: {s1}")
    s2 = mk.tilt_perspective(0, 15, 1080, 1920)
    if "perspective=" in s2:
        print(f"  ✓ tilt(0,15): {s2[:60]}...")
    else:
        failures.append(f"tilt(0,15) malformed: {s2}")
    # w/h 미지정 — '' 반환 (signature safety)
    if mk.tilt_perspective(15, 0) != "":
        failures.append("tilt(15,0) without w/h should return ''")
    # 실제 합성에 적용
    for (tx, ty, name) in [(15, 0, "tx15"), (0, 15, "ty15"), (10, 10, "tx10_ty10")]:
        out = WORK / f"tilt_{name}.mp4"
        try:
            mk.composite_video(src, "iphone-16-pro", "9:16", "#1a1a2e", None,
                               0.85, out, tilt_x=tx, tilt_y=ty)
            extract_frame(out, 0.05, OUT_DIR / f"_mockup_phase2_tilt_{name}.png")
            print(f"  ✓ composite tilt={name}: {out.stat().st_size:,}B")
        except Exception as e:
            failures.append(f"composite tilt {name}: {e}")

    # ── Scene Shapes 6종 ───────────────────────────────────────────
    print(f"\n[Scene Shapes {len(mk.SCENE_SHAPES)}종]")
    for sid in mk.SCENE_SHAPES.keys():
        try:
            img = Image.new("RGB", (600, 800), (40, 60, 90))
            out_img = mk._apply_scene_shapes(img, sid)
            buf = io.BytesIO()
            out_img.save(buf, format="PNG")
            print(f"  ✓ {sid:12s} {len(buf.getvalue()):,}B")
            (OUT_DIR / f"_mockup_phase2_shape_{sid}.png").write_bytes(buf.getvalue())
        except Exception as e:
            failures.append(f"shape {sid}: {e}")

    # ── 통합 1샘플 (Template 'saas-cosmic' 시뮬레이션 + shapes + tilt) ──
    print("\n[통합 1샘플]")
    t = mk.TEMPLATES["saas-cosmic"]
    out = WORK / "combo.mp4"
    try:
        mk.composite_video(src, t["device_id"], t["aspect"],
                           "#1a1a2e", None, 0.85, out,
                           bg_preset=t["bg_preset"],
                           device_style=t["device_style"],
                           device_shadow=t["device_shadow"],
                           device_shadow_opacity=t["device_shadow_opacity"],
                           tilt_x=8, tilt_y=4,
                           scene_shapes="circles")
        extract_frame(out, 0.05, OUT_DIR / "_mockup_phase2_combo.png")
        print(f"  ✓ combo: {out.stat().st_size:,}B")
    except Exception as e:
        failures.append(f"combo: {e}")

    print()
    if failures:
        print("FAIL:")
        for f in failures: print(f"  • {f}")
        return 1
    print("OK")
    return 0


import io  # main 안에서 사용

if __name__ == "__main__":
    sys.exit(main())
