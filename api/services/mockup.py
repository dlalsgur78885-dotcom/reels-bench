"""App mockup generator — record URL via Playwright + composite into device frame.

Pipeline:
  source  (Playwright record OR user-uploaded mp4/png)
  background  (solid color OR uploaded image)
  device frame  (procedurally generated PNG, no licensing issues)
  → ffmpeg overlay → final mp4/png
"""

from __future__ import annotations

import io
import json
import os
import shutil
import subprocess
import tempfile
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal, Optional

import imageio_ffmpeg
import math
import random
from PIL import Image, ImageChops, ImageDraw, ImageFilter

FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()

# ── Device specs ──────────────────────────────────────────────────────────
# Procedurally rendered — license-clean. Dimensions chosen to roughly match
# real devices' aspect ratios, not exact mm-perfect.
DEVICES: dict[str, dict] = {
    "iphone-16-pro": {
        "name": "iPhone 16 Pro",
        "body_w": 1320, "body_h": 2670,
        "corner_radius": 180,
        "bezel": 50,          # uniform bezel around screen
        "screen_radius": 140,
        "notch": True,        # Dynamic Island
        "color": "#0a0a0a",
    },
    "iphone-16-pro-white": {
        "name": "iPhone 16 Pro (Silver)",
        "body_w": 1320, "body_h": 2670,
        "corner_radius": 180,
        "bezel": 50,
        "screen_radius": 140,
        "notch": True,
        "color": "#e8e8ea",
    },
    "pixel-9-pro": {
        "name": "Pixel 9 Pro",
        "body_w": 1280, "body_h": 2730,
        "corner_radius": 100,
        "bezel": 40,
        "screen_radius": 70,
        "notch": False,       # punch-hole
        "color": "#1f1f22",
    },
    "iphone-16": {
        "name": "iPhone 16",
        "body_w": 1300, "body_h": 2640,
        "corner_radius": 160,
        "bezel": 55,           # 일반형이 Pro보다 베젤 약간 두꺼움
        "screen_radius": 120,
        "notch": True,         # Dynamic Island
        "color": "#1a1a1c",
    },
    "iphone-16-pro-max": {
        "name": "iPhone 16 Pro Max",
        "body_w": 1440, "body_h": 2920,
        "corner_radius": 195,
        "bezel": 50,
        "screen_radius": 150,
        "notch": True,
        "color": "#0a0a0a",
    },
    "galaxy-s25": {
        "name": "Galaxy S25",
        "body_w": 1260, "body_h": 2680,
        "corner_radius": 90,
        "bezel": 38,
        "screen_radius": 60,
        "notch": False,        # 중앙 punch-hole
        "color": "#181a1c",
    },
    "galaxy-s25-ultra": {
        "name": "Galaxy S25 Ultra",
        "body_w": 1420, "body_h": 2980,
        "corner_radius": 70,   # 각진 corner
        "bezel": 40,
        "screen_radius": 50,
        "notch": False,
        "color": "#1c1c20",
    },
    "pixel-9": {
        "name": "Pixel 9",
        "body_w": 1230, "body_h": 2670,
        "corner_radius": 110,
        "bezel": 42,
        "screen_radius": 78,
        "notch": False,
        "color": "#2a2a2c",
    },
}

ASPECTS = {
    "9:16": (1080, 1920),   # 릴스 / 쇼츠 / 틱톡 세로
    "1:1":  (1080, 1080),   # 인스타 피드 정사각
    "4:5":  (1080, 1350),   # 인스타 피드 세로 (작은 안전영역)
    "3:4":  (1080, 1440),   # 좁은 세로
    "16:9": (1920, 1080),   # 유튜브 와이드
    "16:10": (1920, 1200),  # 데스크톱/랩탑 와이드
    "4:3":  (1440, 1080),   # 클래식 4:3
}

# ── Device frame rendering ────────────────────────────────────────────────

def device_aperture(device_id: str) -> tuple[int, int, int, int]:
    """screen 영역 (x, y, w, h) — frame PNG 내부 좌표."""
    s = DEVICES[device_id]
    bz = s["bezel"]
    return (bz, bz, s["body_w"] - 2 * bz, s["body_h"] - 2 * bz)


DEVICE_STYLES: dict[str, dict] = {
    # 8종 — shots.so audit STYLE 매칭
    "default":      {"label": "기본",        "body_alpha": 255, "ring": False,
                     "inner": None,   "highlight": None,  "tint": None},
    "outline":      {"label": "아웃라인",    "body_alpha": 0,   "ring": True,
                     "inner": None,   "highlight": None,  "tint": None,
                     "ring_width": 14},
    "border":       {"label": "보더",        "body_alpha": 70,  "ring": True,
                     "inner": None,   "highlight": None,  "tint": None,
                     "ring_width": 22},
    "glass":        {"label": "글래스",      "body_alpha": 90,  "ring": False,
                     "inner": None,   "highlight": None,  "tint": None},
    "glass-light":  {"label": "글래스 라이트", "body_alpha": 70, "ring": False,
                     "inner": None,   "highlight": ("top",   (255, 255, 255, 80)),
                     "tint": (255, 255, 255, 25)},
    "glass-dark":   {"label": "글래스 다크",   "body_alpha": 140, "ring": False,
                     "inner": None,   "highlight": ("bottom",(20, 20, 30, 100)),
                     "tint": (0, 0, 0, 40)},
    "liquid-glass": {"label": "리퀴드 글래스", "body_alpha": 110, "ring": False,
                     "inner": None,   "highlight": ("rim",   (255, 255, 255, 140)),
                     "tint": (200, 220, 255, 35)},
    "inset-light":  {"label": "인셋 라이트",   "body_alpha": 255, "ring": False,
                     "inner": ("light", 70, 14),  "highlight": None, "tint": None},
    "inset-dark":   {"label": "인셋 다크",     "body_alpha": 255, "ring": False,
                     "inner": ("dark",  90, 14),  "highlight": None, "tint": None},
}


def _apply_inner_stroke(img: Image.Image, corner_r: int, W: int, H: int,
                        kind: str, alpha: int, width: int) -> None:
    """body 안쪽 stroke — 깊이감 (Inset Light/Dark)."""
    color = (255, 255, 255, alpha) if kind == "light" else (0, 0, 0, alpha)
    d = ImageDraw.Draw(img)
    inset = 4
    d.rounded_rectangle((inset, inset, W - 1 - inset, H - 1 - inset),
                        radius=max(0, corner_r - inset),
                        outline=color, width=width)


def _apply_highlight(img: Image.Image, corner_r: int, W: int, H: int,
                     position: str, color: tuple[int, int, int, int]) -> None:
    """Glass Light / Dark / Liquid Glass 의 highlight 띠/링."""
    overlay = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(overlay)
    if position == "top":
        # 위 1/3 에 그라데이션 백색
        for y in range(int(H * 0.35)):
            t = 1.0 - y / max(1, int(H * 0.35))
            a = int(color[3] * t)
            d.line([(0, y), (W, y)], fill=(color[0], color[1], color[2], a))
    elif position == "bottom":
        # 아래 1/3 에 어두운 띠
        start = int(H * 0.65)
        for y in range(start, H):
            t = (y - start) / max(1, H - start)
            a = int(color[3] * t)
            d.line([(0, y), (W, y)], fill=(color[0], color[1], color[2], a))
    elif position == "rim":
        # 외곽선 1.5px — Liquid Glass 가장자리 반사
        d.rounded_rectangle((2, 2, W - 3, H - 3), radius=max(0, corner_r - 2),
                            outline=color, width=6)
    overlay = overlay.filter(ImageFilter.GaussianBlur(radius=2))
    # body 모양으로 mask — 외곽 둥근 영역만 적용
    mask = Image.new("L", (W, H), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, W - 1, H - 1),
                                           radius=corner_r, fill=255)
    img_rgba = img.convert("RGBA")
    masked = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    masked.paste(overlay, mask=mask)
    img.alpha_composite(masked)


def render_device_frame(device_id: str, *, style: str | None = None,
                        radius_override: int | None = None) -> bytes:
    """디바이스 프레임 PNG bytes. screen 영역은 알파 투명.

    style: DEVICE_STYLES 의 8종 중 하나.
    radius_override: corner_radius 사용자 override.
    """
    s = DEVICES[device_id]
    W, H = s["body_w"], s["body_h"]
    bz = s["bezel"]
    sx, sy = bz, bz
    sw, sh = W - 2 * bz, H - 2 * bz

    style_spec = DEVICE_STYLES.get(style or "default", DEVICE_STYLES["default"])
    body_alpha = int(style_spec["body_alpha"])
    use_ring = bool(style_spec["ring"])
    inner_spec = style_spec.get("inner")
    highlight_spec = style_spec.get("highlight")
    tint_spec = style_spec.get("tint")

    body_rgb = _hex_to_rgba(s["color"])[:3]
    # tint 가 있으면 body 색에 살짝 섞기
    if tint_spec:
        tr, tg, tb, ta = tint_spec
        mix = ta / 255.0
        body_rgb = (
            int(body_rgb[0] * (1 - mix) + tr * mix),
            int(body_rgb[1] * (1 - mix) + tg * mix),
            int(body_rgb[2] * (1 - mix) + tb * mix),
        )
    body_color = (body_rgb[0], body_rgb[1], body_rgb[2], body_alpha)
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    corner_r = int(radius_override) if radius_override is not None else s["corner_radius"]
    corner_r = max(0, min(corner_r, min(W, H) // 2))

    # Body (rounded rect)
    if body_alpha > 0:
        draw.rounded_rectangle((0, 0, W - 1, H - 1),
                               radius=corner_r, fill=body_color)

    # Ring (Outline / Border)
    if use_ring:
        ring_w = int(style_spec.get("ring_width", 14))
        ring_color = body_rgb + (255,)
        draw.rounded_rectangle((0, 0, W - 1, H - 1),
                               radius=corner_r,
                               outline=ring_color, width=ring_w)

    # Inner stroke (Inset Light/Dark)
    if inner_spec:
        kind, alpha, width = inner_spec
        _apply_inner_stroke(img, corner_r, W, H, kind, alpha, width)

    # Highlight (Glass Light/Dark/Liquid)
    if highlight_spec:
        position, color = highlight_spec
        _apply_highlight(img, corner_r, W, H, position, color)

    # Subtle inner highlight (thin lighter ring along bezel)
    # — default + inset 변종에만 적용 (glass/outline 류는 자체 highlight 가짐)
    if body_alpha >= 200 and not use_ring and not highlight_spec:
        inset = 6
        highlight = tuple(min(255, c + 30) for c in body_color[:3]) + (180,)
        draw.rounded_rectangle((inset, inset, W - 1 - inset, H - 1 - inset),
                               radius=max(0, corner_r - inset),
                               outline=highlight, width=3)

    # Side buttons (small accent)
    btn_color = tuple(max(0, c - 20) for c in body_color[:3]) + (255,)
    draw.rectangle((0, int(H * 0.18), 6, int(H * 0.22)), fill=btn_color)            # mute
    draw.rectangle((0, int(H * 0.25), 6, int(H * 0.33)), fill=btn_color)            # vol up
    draw.rectangle((0, int(H * 0.34), 6, int(H * 0.42)), fill=btn_color)            # vol down
    draw.rectangle((W - 6, int(H * 0.22), W - 1, int(H * 0.32)), fill=btn_color)    # power

    # Screen cutout: alpha = min(body_alpha, mask) where mask is 0 over screen.
    cutout = Image.new("L", (W, H), 255)
    ImageDraw.Draw(cutout).rounded_rectangle(
        (sx, sy, sx + sw - 1, sy + sh - 1),
        radius=s["screen_radius"], fill=0)
    r, g, b, a = img.split()
    a = ImageChops.darker(a, cutout)
    img = Image.merge("RGBA", (r, g, b, a))

    # Notch / island (drawn AFTER cutout so it overlays the screen area)
    if s.get("notch"):
        nw, nh = 380, 130
        nx = (W - nw) // 2
        ny = sy + 40
        nd = ImageDraw.Draw(img)
        nd.rounded_rectangle((nx, ny, nx + nw, ny + nh), radius=70,
                              fill=(0, 0, 0, 255))
    else:
        # Punch-hole camera (centered, small)
        ch_r = 30
        cx = W // 2
        cy = sy + 70
        nd = ImageDraw.Draw(img)
        nd.ellipse((cx - ch_r, cy - ch_r, cx + ch_r, cy + ch_r), fill=(0, 0, 0, 255))

    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


# ── Device drop-shadow (shots.so SCENE: Shadow 5종) ─────────────────────
# render_device_frame 결과(투명 cutout 포함 RGBA)에 PIL drop-shadow 합성.
# 결과는 frame PNG 와 같은 사이즈, 그림자가 보일 공간이 부족하면 외곽 패딩 추가.

DEVICE_SHADOWS: dict[str, dict] = {
    # v1: 그림자가 body PNG 사이즈 안에 들어오는 보수 값.
    # body 외곽 spill 은 frame PNG 패딩 확장이 필요 (v2 — _composite 좌표 보정 동반).
    "none":     {"label": "없음",     "blur": 0,  "offset": (0, 0),    "spread": 0,  "alpha": 0},
    "soft":     {"label": "소프트",   "blur": 30, "offset": (0, 20),   "spread": 5,  "alpha": 130},
    "hard":     {"label": "하드",     "blur": 8,  "offset": (8, 12),   "spread": 0,  "alpha": 180},
    "glow":     {"label": "글로우",   "blur": 40, "offset": (0, 0),    "spread": 10, "alpha": 160, "color": (255, 200, 120)},
    "diffused": {"label": "디퓨즈",   "blur": 60, "offset": (0, 30),   "spread": 0,  "alpha": 100},
}


def add_device_shadow(frame_png: bytes, shadow_id: str,
                      opacity: float = 1.0,
                      color: tuple[int, int, int] = (0, 0, 0),
                      angle_deg: float | None = None) -> bytes:
    """frame_png(RGBA, alpha cutout 포함) → drop-shadow 합성된 PNG bytes.

    shadow_id == 'none' / 미지값 / opacity<=0 이면 입력 그대로 반환 (byte-identical).
    그림자 마스크는 디바이스 *body* 알파(투명한 screen cutout 제외)로부터 생성한다
    — screen cutout 안쪽으로 그림자가 새지 않게.

    angle_deg: 광원 방향(°). None ⇒ spec default offset(x,y) 그대로. 지정 시
      preset 의 offset 거리(=hypot(ox,oy))를 유지한 채 방향만 회전. 0°=위, 90°=오른쪽,
      180°=아래, 270°=왼쪽 (CSS box-shadow 회전 컨벤션과 동일).
    """
    if not shadow_id or shadow_id == "none":
        return frame_png
    spec = DEVICE_SHADOWS.get(shadow_id)
    if not spec or spec["alpha"] <= 0 or opacity <= 0:
        return frame_png

    src = Image.open(io.BytesIO(frame_png)).convert("RGBA")
    W, H = src.size
    blur = int(spec["blur"])
    ox, oy = spec["offset"]
    # angle_deg 지정 시 distance 보존 + 방향 회전
    if angle_deg is not None and math.isfinite(angle_deg):
        dist = math.hypot(ox, oy)
        # 0° = down (south, +y); 90° = right; 180° = up; 270° = left
        # CSS box-shadow 와 같은 컨벤션 — 아래쪽이 기본
        rad = math.radians(angle_deg)
        ox = int(round(dist * math.sin(rad)))
        oy = int(round(dist * math.cos(rad)))
    spread = int(spec["spread"])
    alpha = int(max(0, min(255, spec["alpha"] * max(0.0, min(1.0, opacity)))))
    # preset 이 자체 color 를 들고 있으면 (glow 등) 우선
    color = spec.get("color", color)

    # 캔버스 확장 — 그림자가 잘리지 않도록 외곽 패딩
    pad = max(blur, abs(ox), abs(oy)) + spread + 20
    cw, ch = W + pad * 2, H + pad * 2
    canvas = Image.new("RGBA", (cw, ch), (0, 0, 0, 0))

    # 1) 디바이스 body 마스크 만들기 — frame PNG 알파에서 screen cutout 메우기
    #    body 알파는 "body 있는 영역", screen cutout 은 body 내부 투명 구멍.
    #    드롭 섀도우는 body 외형 기준이라야 자연 — cutout 안으로 빛 새면 어색.
    body_mask = src.split()[3]  # alpha channel
    # body 외곽선 추출 위해 alpha 를 살짝 dilate (PIL 기본은 erode/dilate 없으므로 MaxFilter)
    # MaxFilter 로 채워 cutout 메우기 — 적당한 크기. 데미컷 영역이 큰 frame 도 안전하게.
    filled = body_mask.copy()
    for _ in range(8):
        filled = filled.filter(ImageFilter.MaxFilter(7))

    # 2) spread: 마스크를 확장
    if spread > 0:
        for _ in range(max(1, spread // 4)):
            filled = filled.filter(ImageFilter.MaxFilter(7))

    # 3) shadow image 만들기 (단색, 알파 = mask * (alpha/255))
    shadow_rgba = Image.new("RGBA", (W, H), (color[0], color[1], color[2], 0))
    # alpha 채널을 mask 에 alpha 스케일 곱해 채움
    a = filled.point(lambda v: int(v * alpha / 255))
    shadow_rgba.putalpha(a)

    # 4) 패딩된 canvas 의 (pad+ox, pad+oy) 위치에 그림자, blur
    shadow_layer = Image.new("RGBA", (cw, ch), (0, 0, 0, 0))
    shadow_layer.paste(shadow_rgba, (pad + ox, pad + oy), shadow_rgba)
    shadow_layer = shadow_layer.filter(ImageFilter.GaussianBlur(radius=blur))

    # 5) 원본 frame 을 (pad, pad) 위치에 합성
    canvas.alpha_composite(shadow_layer)
    canvas.alpha_composite(src, dest=(pad, pad))

    # 결과는 패딩 포함 — 합성 시 _composite 가 canvas 영역에 알아서 scale & fit.
    # 다만 호출자가 device aperture 좌표를 기대하므로, 원래 사이즈로 crop 해
    # 그림자가 외곽으로 일부 나가게 두는 것보다, 같은 사이즈로 두는 게 ffmpeg
    # overlay 좌표 안 깨짐. → 다시 W x H 로 crop (그림자가 본체 인근만 보임).
    # NOTE: 본체 인근의 그림자는 충분히 보이지만, 멀리 퍼지는 부분은 일부 잘림.
    #       _composite 가 frame_png 사이즈를 device body_w/h 로 가정하기 때문에
    #       사이즈 변경 없이 가야 안전.
    out = canvas.crop((pad, pad, pad + W, pad + H))
    buf = io.BytesIO()
    out.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def _hex_to_rgba(hx: str) -> tuple[int, int, int, int]:
    hx = hx.lstrip("#")
    if len(hx) == 6:
        return (int(hx[0:2], 16), int(hx[2:4], 16), int(hx[4:6], 16), 255)
    if len(hx) == 8:
        return (int(hx[0:2], 16), int(hx[2:4], 16),
                int(hx[4:6], 16), int(hx[6:8], 16))
    raise ValueError(f"bad hex: {hx}")


# ── Playwright recording ──────────────────────────────────────────────────

def record_url(url: str, viewport_w: int, viewport_h: int,
               duration_sec: float, out_webm: Path) -> None:
    """URL을 mobile viewport로 열어 webm 영상 녹화."""
    from playwright.sync_api import sync_playwright

    out_webm.parent.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(
            viewport={"width": viewport_w, "height": viewport_h},
            device_scale_factor=2,
            user_agent=("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) "
                        "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 "
                        "Mobile/15E148 Safari/604.1"),
            record_video_dir=str(out_webm.parent),
            record_video_size={"width": viewport_w, "height": viewport_h},
        )
        page = ctx.new_page()
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=30000)
        except Exception:
            # 일부 사이트는 networkidle/domcontentloaded 안 떨어짐 — 그래도 진행
            pass
        page.wait_for_timeout(int(duration_sec * 1000))
        video = page.video
        ctx.close()  # finalize the webm
        browser.close()
        # Playwright는 자동 이름으로 저장 — out_webm으로 옮긴다
        if video:
            actual = Path(video.path())
            if actual != out_webm:
                if out_webm.exists():
                    out_webm.unlink()
                shutil.move(str(actual), str(out_webm))


# ── ffmpeg composite ──────────────────────────────────────────────────────

def _run_ffmpeg(args: list[str], timeout: int = 180) -> None:
    cmd = [FFMPEG, "-y", "-hide_banner", "-loglevel", "error", *args]
    proc = subprocess.run(cmd, capture_output=True, timeout=timeout)
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg failed: {proc.stderr.decode('utf-8', 'replace')[:500]}")


def composite_video(source: Path, device_id: str, aspect: str,
                    bg_color: str, bg_image: Optional[Path],
                    device_scale: float, out_path: Path,
                    bg_preset: Optional[str] = None,
                    overlay_effect: Optional[str] = None,
                    device_shadow: Optional[str] = None,
                    device_shadow_opacity: float = 1.0,
                    device_shadow_angle: Optional[float] = None,
                    device_style: Optional[str] = None,
                    hide_mockup: bool = False,
                    radius_override: Optional[int] = None,
                    tilt_x: float = 0.0,
                    tilt_y: float = 0.0,
                    scene_shapes: Optional[str] = None) -> None:
    """source(mp4/webm) + bg + device frame → out_path(mp4)."""
    _composite(source, device_id, aspect, bg_color, bg_image,
               device_scale, out_path, is_video=True,
               bg_preset=bg_preset, overlay_effect=overlay_effect,
               device_shadow=device_shadow,
               device_shadow_opacity=device_shadow_opacity,
               device_shadow_angle=device_shadow_angle,
               device_style=device_style, hide_mockup=hide_mockup,
               radius_override=radius_override,
               tilt_x=tilt_x, tilt_y=tilt_y,
               scene_shapes=scene_shapes)


def composite_image(source: Path, device_id: str, aspect: str,
                    bg_color: str, bg_image: Optional[Path],
                    device_scale: float, out_path: Path,
                    bg_preset: Optional[str] = None,
                    device_shadow: Optional[str] = None,
                    device_shadow_opacity: float = 1.0,
                    device_shadow_angle: Optional[float] = None,
                    device_style: Optional[str] = None,
                    hide_mockup: bool = False,
                    radius_override: Optional[int] = None,
                    tilt_x: float = 0.0,
                    tilt_y: float = 0.0,
                    scene_shapes: Optional[str] = None) -> None:
    """source(png/jpg) + bg + device frame → out_path(png).
    overlay_effect 는 영상 전용. tilt / scene_shapes 는 image 에도 적용."""
    _composite(source, device_id, aspect, bg_color, bg_image,
               device_scale, out_path, is_video=False,
               bg_preset=bg_preset, overlay_effect=None,
               device_shadow=device_shadow,
               device_shadow_opacity=device_shadow_opacity,
               device_shadow_angle=device_shadow_angle,
               device_style=device_style, hide_mockup=hide_mockup,
               radius_override=radius_override,
               tilt_x=tilt_x, tilt_y=tilt_y,
               scene_shapes=scene_shapes)


def _composite(source: Path, device_id: str, aspect: str,
               bg_color: str, bg_image: Optional[Path],
               device_scale: float, out_path: Path, is_video: bool,
               bg_preset: Optional[str] = None,
               overlay_effect: Optional[str] = None,
               device_shadow: Optional[str] = None,
               device_shadow_opacity: float = 1.0,
               device_shadow_angle: Optional[float] = None,
               device_style: Optional[str] = None,
               hide_mockup: bool = False,
               radius_override: Optional[int] = None,
               tilt_x: float = 0.0,
               tilt_y: float = 0.0,
               scene_shapes: Optional[str] = None) -> None:
    spec = DEVICES[device_id]
    body_w, body_h = spec["body_w"], spec["body_h"]
    sx, sy, sw, sh = device_aperture(device_id)
    canvas_w, canvas_h = ASPECTS[aspect]

    # 디바이스를 canvas에 맞게 scale (device_scale = 디바이스 높이 / canvas 높이)
    target_h = int(canvas_h * max(0.4, min(0.95, device_scale)))
    scale = target_h / body_h
    dev_w = int(body_w * scale)
    dev_h = int(body_h * scale)
    dev_x = (canvas_w - dev_w) // 2
    dev_y = (canvas_h - dev_h) // 2

    # screen 영역(canvas 좌표)
    scr_x = dev_x + int(sx * scale)
    scr_y = dev_y + int(sy * scale)
    scr_w = int(sw * scale)
    scr_h = int(sh * scale)

    # device frame PNG → temp 파일 (style + radius override + drop shadow 합성)
    tmp_frame = out_path.parent / f"_frame_{device_id}_{uuid.uuid4().hex[:6]}.png"
    frame_png = render_device_frame(device_id, style=device_style,
                                    radius_override=radius_override)
    if device_shadow and device_shadow != "none":
        frame_png = add_device_shadow(frame_png, device_shadow,
                                      opacity=device_shadow_opacity,
                                      angle_deg=device_shadow_angle)
    tmp_frame.write_bytes(frame_png)

    # bg PNG (preset, uploaded image, solid color 우선순위 — preset > image > color)
    tmp_bg = out_path.parent / f"_bg_{uuid.uuid4().hex[:8]}.png"
    _make_background(bg_color, bg_image, canvas_w, canvas_h, tmp_bg,
                     bg_preset=bg_preset, scene_shapes=scene_shapes)

    out_path.parent.mkdir(parents=True, exist_ok=True)

    if is_video:
        # filter_complex:
        #   [0]=bg PNG (looped)  [1]=source video  [2]=frame PNG (looped)
        effect_chain = effect_to_ffmpeg(overlay_effect or "none")
        tilt_chain = tilt_perspective(tilt_x, tilt_y, canvas_w, canvas_h)
        tail_parts = [c for c in (effect_chain, tilt_chain) if c]
        effect_tail = f",{','.join(tail_parts)}" if tail_parts else ""
        if hide_mockup:
            # device frame overlay 생략 — screen 콘텐츠만 (둥근 모서리 마스킹 X v1)
            fc = (
                f"[1:v]scale={scr_w}:{scr_h}:force_original_aspect_ratio=increase,"
                f"crop={scr_w}:{scr_h},setpts=PTS-STARTPTS[scr];"
                f"[0:v][scr]overlay={scr_x}:{scr_y}:shortest=1"
                f"{effect_tail},format=yuv420p"
            )
            ffmpeg_inputs = [
                "-loop", "1", "-i", str(tmp_bg),
                "-i", str(source),
            ]
        else:
            fc = (
                f"[1:v]scale={scr_w}:{scr_h}:force_original_aspect_ratio=increase,"
                f"crop={scr_w}:{scr_h},setpts=PTS-STARTPTS[scr];"
                f"[0:v][scr]overlay={scr_x}:{scr_y}:shortest=1[base];"
                f"[2:v]scale={dev_w}:{dev_h}[dev];"
                f"[base][dev]overlay={dev_x}:{dev_y}:shortest=1"
                f"{effect_tail},format=yuv420p"
            )
            ffmpeg_inputs = [
                "-loop", "1", "-i", str(tmp_bg),
                "-i", str(source),
                "-loop", "1", "-i", str(tmp_frame),
            ]
        _run_ffmpeg([
            *ffmpeg_inputs,
            "-filter_complex", fc,
            "-shortest", "-fflags", "+shortest",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast",
            "-crf", "20", "-movflags", "+faststart",
            str(out_path),
        ], timeout=240)
    else:
        tilt_chain = tilt_perspective(tilt_x, tilt_y, canvas_w, canvas_h)
        tilt_tail = f",{tilt_chain}" if tilt_chain else ""
        if hide_mockup:
            fc = (
                f"[1:v]scale={scr_w}:{scr_h}:force_original_aspect_ratio=increase,"
                f"crop={scr_w}:{scr_h}[scr];"
                f"[0:v][scr]overlay={scr_x}:{scr_y}{tilt_tail}"
            )
            ffmpeg_inputs = ["-i", str(tmp_bg), "-i", str(source)]
        else:
            fc = (
                f"[1:v]scale={scr_w}:{scr_h}:force_original_aspect_ratio=increase,"
                f"crop={scr_w}:{scr_h}[scr];"
                f"[0:v][scr]overlay={scr_x}:{scr_y}[base];"
                f"[2:v]scale={dev_w}:{dev_h}[dev];"
                f"[base][dev]overlay={dev_x}:{dev_y}{tilt_tail}"
            )
            ffmpeg_inputs = ["-i", str(tmp_bg), "-i", str(source), "-i", str(tmp_frame)]
        _run_ffmpeg([
            *ffmpeg_inputs,
            "-filter_complex", fc,
            "-frames:v", "1",
            str(out_path),
        ], timeout=60)

    # cleanup
    try: tmp_frame.unlink()
    except: pass
    try: tmp_bg.unlink()
    except: pass


# ── Background presets (shots.so 벤치 ②) ────────────────────────────────
# PIL 만으로 procedural 생성 — 외부 자산/라이선스 깨끗.
# 각 preset 의 핵심 컬러를 (top, bottom) 또는 (center, edge) 페어로 정의하고
# 작은 헬퍼들로 조립한다.

def _lerp_color(a: tuple[int, int, int], b: tuple[int, int, int],
                t: float) -> tuple[int, int, int]:
    t = max(0.0, min(1.0, t))
    return (
        int(a[0] + (b[0] - a[0]) * t),
        int(a[1] + (b[1] - a[1]) * t),
        int(a[2] + (b[2] - a[2]) * t),
    )


def _vertical_gradient(top: tuple[int, int, int], bottom: tuple[int, int, int],
                       w: int, h: int) -> Image.Image:
    """최적화: 1×H 그라데이션 만들고 W로 stretch — pixel loop H 번만 (W×H 가 아님).
    이전 구현 대비 220×440 사이즈에서 약 200× 빠름."""
    col = Image.new("RGB", (1, h))
    px = col.load()
    hm = max(1, h - 1)
    for y in range(h):
        px[0, y] = _lerp_color(top, bottom, y / hm)
    if w == 1:
        return col
    return col.resize((w, h), Image.NEAREST)


def _radial_gradient(center: tuple[int, int, int], edge: tuple[int, int, int],
                     w: int, h: int) -> Image.Image:
    img = Image.new("RGB", (w, h), edge)
    px = img.load()
    cx, cy = w / 2, h / 2
    maxr = math.hypot(cx, cy)
    for y in range(h):
        for x in range(w):
            r = math.hypot(x - cx, y - cy) / maxr
            px[x, y] = _lerp_color(center, edge, r)
    return img


def _add_noise(img: Image.Image, strength: int = 14) -> Image.Image:
    """rgb 각 픽셀에 ±strength 화이트 노이즈. seed 고정으로 결정론."""
    rnd = random.Random(8086)
    px = img.load()
    w, h = img.size
    for y in range(h):
        for x in range(w):
            r, g, b = px[x, y][:3]
            n = rnd.randint(-strength, strength)
            px[x, y] = (
                max(0, min(255, r + n)),
                max(0, min(255, g + n)),
                max(0, min(255, b + n)),
            )
    return img


def _add_blobs(img: Image.Image,
               blobs: list[tuple[tuple[int, int], int, tuple[int, int, int], int]]) -> Image.Image:
    """blobs = [((cx, cy), radius, color, alpha)…] — 큰 ellipse 들을 추가 후 strong blur."""
    w, h = img.size
    overlay = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(overlay)
    for (cx, cy), rr, color, alpha in blobs:
        d.ellipse((cx - rr, cy - rr, cx + rr, cy + rr),
                  fill=(color[0], color[1], color[2], alpha))
    overlay = overlay.filter(ImageFilter.GaussianBlur(radius=max(80, w // 12)))
    base = img.convert("RGBA")
    base.alpha_composite(overlay)
    return base.convert("RGB")


def _scatter_dots(img: Image.Image, n: int, color: tuple[int, int, int],
                  size_range: tuple[int, int] = (1, 3)) -> Image.Image:
    """별/그레인 스타일의 점 분포. seed 고정."""
    rnd = random.Random(2401)
    d = ImageDraw.Draw(img)
    w, h = img.size
    for _ in range(n):
        x = rnd.randint(0, w - 1)
        y = rnd.randint(0, h - 1)
        s = rnd.randint(*size_range)
        d.ellipse((x, y, x + s, y + s), fill=color)
    return img


# preset_id → callable(w, h) → RGB Image
def _bg_sunset(w: int, h: int) -> Image.Image:
    return _vertical_gradient((255, 165, 100), (220, 60, 130), w, h)


def _bg_ocean(w: int, h: int) -> Image.Image:
    return _vertical_gradient((40, 200, 220), (30, 70, 180), w, h)


def _bg_mint(w: int, h: int) -> Image.Image:
    return _vertical_gradient((180, 245, 220), (90, 200, 170), w, h)


def _bg_violet(w: int, h: int) -> Image.Image:
    return _vertical_gradient((180, 100, 240), (255, 120, 180), w, h)


def _bg_mesh_warm(w: int, h: int) -> Image.Image:
    base = Image.new("RGB", (w, h), (255, 200, 130))
    return _add_blobs(base, [
        ((int(w * 0.2), int(h * 0.25)), int(w * 0.45), (255, 100, 80),  200),
        ((int(w * 0.85), int(h * 0.3)), int(w * 0.4),  (255, 220, 80),  200),
        ((int(w * 0.5), int(h * 0.85)), int(w * 0.5),  (250, 100, 180), 200),
    ])


def _bg_mesh_cool(w: int, h: int) -> Image.Image:
    base = Image.new("RGB", (w, h), (60, 120, 200))
    return _add_blobs(base, [
        ((int(w * 0.15), int(h * 0.2)),  int(w * 0.45), (40, 220, 200), 200),
        ((int(w * 0.85), int(h * 0.4)),  int(w * 0.4),  (140, 80, 220), 200),
        ((int(w * 0.5),  int(h * 0.85)), int(w * 0.45), (40, 80, 180),  200),
    ])


def _bg_cosmic(w: int, h: int) -> Image.Image:
    base = _radial_gradient((50, 30, 90), (10, 5, 30), w, h)
    base = _add_blobs(base, [
        ((int(w * 0.7), int(h * 0.3)), int(w * 0.3), (160, 60, 200), 180),
        ((int(w * 0.2), int(h * 0.7)), int(w * 0.3), (40, 120, 200),  180),
    ])
    return _scatter_dots(base, n=max(200, w * h // 4000),
                         color=(255, 255, 255), size_range=(1, 3))


def _bg_radiant(w: int, h: int) -> Image.Image:
    base = _radial_gradient((255, 240, 200), (255, 130, 60), w, h)
    # 중앙 burst 라인을 살짝 — 얇은 색 라인을 회전 배치 후 흐릿하게
    overlay = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(overlay)
    cx, cy = w / 2, h / 2
    for i in range(24):
        a = (math.pi * 2) * i / 24
        x2 = cx + math.cos(a) * w
        y2 = cy + math.sin(a) * w
        d.line([(cx, cy), (x2, y2)], fill=(255, 255, 220, 35), width=8)
    overlay = overlay.filter(ImageFilter.GaussianBlur(radius=24))
    base_rgba = base.convert("RGBA")
    base_rgba.alpha_composite(overlay)
    return base_rgba.convert("RGB")


def _bg_paper(w: int, h: int) -> Image.Image:
    base = Image.new("RGB", (w, h), (242, 232, 215))
    return _add_noise(base, strength=10)


def _bg_glass(w: int, h: int) -> Image.Image:
    base = _vertical_gradient((220, 230, 250), (180, 200, 230), w, h)
    # 위에 흐릿한 blob 몇 개로 frosted glass 분위기
    base = _add_blobs(base, [
        ((int(w * 0.3), int(h * 0.3)), int(w * 0.35), (255, 255, 255), 80),
        ((int(w * 0.7), int(h * 0.6)), int(w * 0.4),  (200, 220, 255), 100),
    ])
    return _add_noise(base, strength=4)


def _bg_grain_bw(w: int, h: int) -> Image.Image:
    base = Image.new("RGB", (w, h), (30, 30, 32))
    return _add_noise(base, strength=20)


BG_PRESETS: dict[str, dict] = {
    "sunset":    {"label": "선셋",       "fn": _bg_sunset},
    "ocean":     {"label": "오션",       "fn": _bg_ocean},
    "mint":      {"label": "민트",       "fn": _bg_mint},
    "violet":    {"label": "바이올렛",   "fn": _bg_violet},
    "mesh-warm": {"label": "메시 웜",    "fn": _bg_mesh_warm},
    "mesh-cool": {"label": "메시 쿨",    "fn": _bg_mesh_cool},
    "cosmic":    {"label": "코스믹",     "fn": _bg_cosmic},
    "radiant":   {"label": "래디언트",   "fn": _bg_radiant},
    "paper":     {"label": "페이퍼",     "fn": _bg_paper},
    "glass":     {"label": "글래스",     "fn": _bg_glass},
    "grain-bw":  {"label": "그레인 블랙", "fn": _bg_grain_bw},
}


def magic_bg_from_image(src_path: Path, w: int, h: int) -> Image.Image:
    """업로드된 미디어에서 dominant color 두 개 추출 → vertical gradient.
    shots.so 의 'Magic' 배경 v1 — AI 호출 없이 PIL 만으로.

    영상이면 첫 프레임을 ffmpeg 로 추출 후 처리.
    """
    work_png = src_path
    ext = src_path.suffix.lower()
    cleanup: Optional[Path] = None
    if ext in (".mp4", ".webm", ".mov"):
        work_png = src_path.parent / f"_magic_first_{uuid.uuid4().hex[:6]}.png"
        cleanup = work_png
        _run_ffmpeg([
            "-i", str(src_path), "-frames:v", "1", "-q:v", "5",
            str(work_png),
        ], timeout=20)
    try:
        img = Image.open(work_png).convert("RGB")
        # 다운샘플 + 양자화 — 가장 빈도 높은 두 색
        small = img.resize((64, 64), Image.LANCZOS).quantize(colors=8)
        palette = small.getpalette()[:8 * 3]
        counts = small.getcolors() or []
        counts.sort(reverse=True)  # (count, color_index)
        if len(counts) < 2:
            return _vertical_gradient((40, 50, 80), (20, 25, 40), w, h)
        idx_top, idx_2nd = counts[0][1], counts[1][1]
        col_top = (palette[idx_top*3], palette[idx_top*3+1], palette[idx_top*3+2])
        col_bot = (palette[idx_2nd*3], palette[idx_2nd*3+1], palette[idx_2nd*3+2])
        return _vertical_gradient(col_top, col_bot, w, h)
    finally:
        if cleanup and cleanup.exists():
            try: cleanup.unlink()
            except: pass


def render_bg_preset(preset_id: str, w: int, h: int) -> Image.Image:
    if preset_id not in BG_PRESETS:
        raise ValueError(f"unknown bg preset: {preset_id}")
    return BG_PRESETS[preset_id]["fn"](w, h)


def render_bg_preset_thumbnail(preset_id: str) -> bytes:
    """카탈로그 UI 용 작은 PNG (240x320)."""
    img = render_bg_preset(preset_id, 240, 320)
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


import functools


@functools.lru_cache(maxsize=256)
def _cached_frame_preview(device_id: str, style: str | None, radius_override: int | None,
                          shadow: str | None, shadow_opacity_int: int,
                          shadow_angle_int: int | None,
                          dummy_bg_id: str) -> bytes:
    """frame_preview 결과를 (모든 변형 조합) memoize. shadow_opacity/angle 은
    cache 키로 float 못 쓰니 정수화 (×100 / round)."""
    return _render_frame_preview_uncached(
        device_id, style=style, radius_override=radius_override,
        shadow=shadow, shadow_opacity=shadow_opacity_int / 100.0,
        shadow_angle=float(shadow_angle_int) if shadow_angle_int is not None else None,
        dummy_bg_id=dummy_bg_id,
    )


@functools.lru_cache(maxsize=64)
def _cached_bg_small(preset_id: str, w: int, h: int) -> Image.Image:
    """bg gradient 도 (preset_id, w, h) 키로 memoize — 같은 카드 사이즈는 매번 같음."""
    return render_bg_preset(preset_id, w, h).convert("RGBA")


@functools.lru_cache(maxsize=64)
def _cached_frame_small_rgba(device_id: str, style: str | None,
                              radius_override: int | None,
                              w: int, h: int) -> Image.Image:
    """device frame 도 (device+style+radius+사이즈) 키로 memoize."""
    frame_png_bytes = render_device_frame(device_id, style=style,
                                           radius_override=radius_override)
    img = Image.open(io.BytesIO(frame_png_bytes)).convert("RGBA")
    return img.resize((w, h), Image.LANCZOS)


def _render_frame_preview_uncached(device_id: str, *, style: str | None = None,
                                   radius_override: int | None = None,
                                   shadow: str | None = None,
                                   shadow_opacity: float = 1.0,
                                   shadow_angle: float | None = None,
                                   dummy_bg_id: str = "sunset") -> bytes:
    """uncached 본체. 사이즈는 짧은 변 220px."""
    spec = DEVICES[device_id]
    Wfull, Hfull = spec["body_w"], spec["body_h"]
    target_short = 220
    scale = target_short / min(Wfull, Hfull)
    W = max(64, int(Wfull * scale))
    H = max(64, int(Hfull * scale))
    # shadow 가 있으면 매번 새로 (shadow_angle 변형 다양해서 cache 효율 낮음)
    if shadow and shadow in DEVICE_SHADOWS and shadow != "none":
        frame_png_bytes = render_device_frame(device_id, style=style,
                                              radius_override=radius_override)
        frame_png_bytes = add_device_shadow(frame_png_bytes, shadow,
                                             opacity=shadow_opacity,
                                             angle_deg=shadow_angle)
        frame_small = Image.open(io.BytesIO(frame_png_bytes)).convert("RGBA").resize((W, H), Image.LANCZOS)
    else:
        frame_small = _cached_frame_small_rgba(device_id, style, radius_override, W, H)
    bg = _cached_bg_small(dummy_bg_id, W, H)
    out = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    out.alpha_composite(bg)
    out.alpha_composite(frame_small)
    buf = io.BytesIO()
    out.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def render_frame_preview(device_id: str, *, style: str | None = None,
                         radius_override: int | None = None,
                         shadow: str | None = None,
                         shadow_opacity: float = 1.0,
                         shadow_angle: float | None = None,
                         dummy_bg_id: str = "sunset") -> bytes:
    """디바이스 frame + screen 영역에 procedural bg 합성된 PNG.
    lru_cache 로 같은 변형 조합은 즉시 반환."""
    # shadow 없는 변형은 cache 효과 만점 (frame + bg 둘 다 캐시)
    # shadow 있는 변형은 angle 다양해서 cache key 분리
    opacity_int = int(round(max(0.0, min(1.0, shadow_opacity)) * 100))
    angle_int = int(round(shadow_angle)) if shadow_angle is not None else None
    return _cached_frame_preview(
        device_id, style, radius_override,
        shadow, opacity_int, angle_int, dummy_bg_id,
    )


def render_scene_shape_thumbnail(shape_id: str) -> bytes:
    """SCENE 도형 1종을 어두운 배경 위에 미리보기 PNG (160x100)."""
    base = Image.new("RGB", (160, 100), (40, 50, 70))
    out = _apply_scene_shapes(base, shape_id) if shape_id and shape_id != "none" else base
    buf = io.BytesIO()
    out.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


# ── Scene Shapes (배경 도형 — shots.so SCENE: Shapes) ───────────────────
SCENE_SHAPES: dict[str, dict] = {
    "none":      {"label": "없음"},
    "circles":   {"label": "원형"},
    "blobs":     {"label": "블롭"},
    "triangles": {"label": "삼각형"},
    "grid-dots": {"label": "도트 격자"},
    "rings":     {"label": "링"},
}


def _apply_scene_shapes(img: Image.Image, shape_id: str) -> Image.Image:
    """배경 위에 floating shapes 레이어 합성 (seed 고정 결정론)."""
    if not shape_id or shape_id == "none":
        return img
    if shape_id not in SCENE_SHAPES:
        return img
    w, h = img.size
    overlay = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(overlay)
    rnd = random.Random(0xC0FFEE)
    palette = [
        (255, 255, 255, 60),
        (255, 220, 100, 80),
        (140, 200, 255, 80),
        (255, 140, 200, 80),
    ]
    if shape_id == "circles":
        for _ in range(18):
            r = rnd.randint(int(w * 0.04), int(w * 0.16))
            cx = rnd.randint(0, w)
            cy = rnd.randint(0, h)
            color = palette[rnd.randint(0, len(palette) - 1)]
            d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=color)
    elif shape_id == "blobs":
        for _ in range(8):
            r = rnd.randint(int(w * 0.15), int(w * 0.35))
            cx = rnd.randint(int(-w * 0.1), int(w * 1.1))
            cy = rnd.randint(int(-h * 0.1), int(h * 1.1))
            color = palette[rnd.randint(0, len(palette) - 1)]
            d.ellipse((cx - r, cy - r, cx + r, cy + r),
                      fill=(color[0], color[1], color[2], 110))
        overlay = overlay.filter(ImageFilter.GaussianBlur(radius=max(40, w // 16)))
    elif shape_id == "triangles":
        for _ in range(14):
            size = rnd.randint(int(w * 0.05), int(w * 0.18))
            cx = rnd.randint(0, w)
            cy = rnd.randint(0, h)
            color = palette[rnd.randint(0, len(palette) - 1)]
            angle = rnd.uniform(0, 2 * math.pi)
            pts = []
            for i in range(3):
                a = angle + (2 * math.pi * i / 3)
                pts.append((cx + math.cos(a) * size, cy + math.sin(a) * size))
            d.polygon(pts, fill=color)
    elif shape_id == "grid-dots":
        spacing = max(40, w // 18)
        dot_r = max(2, spacing // 8)
        for y in range(spacing, h, spacing):
            for x in range(spacing, w, spacing):
                d.ellipse((x - dot_r, y - dot_r, x + dot_r, y + dot_r),
                          fill=(255, 255, 255, 100))
    elif shape_id == "rings":
        for _ in range(8):
            r = rnd.randint(int(w * 0.08), int(w * 0.25))
            cx = rnd.randint(0, w)
            cy = rnd.randint(0, h)
            color = palette[rnd.randint(0, len(palette) - 1)]
            stroke = rnd.randint(4, 10)
            d.ellipse((cx - r, cy - r, cx + r, cy + r),
                      outline=(color[0], color[1], color[2], 140), width=stroke)
    base = img.convert("RGBA")
    base.alpha_composite(overlay)
    return base.convert("RGB")


def _make_background(bg_color: str, bg_image: Optional[Path],
                     w: int, h: int, out: Path,
                     bg_preset: Optional[str] = None,
                     scene_shapes: Optional[str] = None) -> None:
    # 1) base 만들기 (transparent > preset > image > solid color 우선순위)
    if bg_color and bg_color.lower() == "transparent":
        # 알파 0 — 디바이스 frame 위로 비치는 투명 배경 (PNG 출력 시 의미; mp4는 검정)
        img = Image.new("RGB", (w, h), (0, 0, 0))
    elif bg_preset and bg_preset in BG_PRESETS:
        img = render_bg_preset(bg_preset, w, h)
    elif bg_image and bg_image.exists():
        img = Image.open(bg_image).convert("RGBA")
        sw, sh = img.size
        target_ratio = w / h
        src_ratio = sw / sh
        if src_ratio > target_ratio:
            new_w = int(sh * target_ratio)
            offset = (sw - new_w) // 2
            img = img.crop((offset, 0, offset + new_w, sh))
        else:
            new_h = int(sw / target_ratio)
            offset = (sh - new_h) // 2
            img = img.crop((0, offset, sw, offset + new_h))
        img = img.resize((w, h), Image.LANCZOS).convert("RGB")
    else:
        rgba = _hex_to_rgba(bg_color)
        img = Image.new("RGB", (w, h), rgba[:3])

    # 2) scene shapes 합성 (있을 때만)
    if scene_shapes and scene_shapes != "none":
        img = _apply_scene_shapes(img, scene_shapes)

    img.save(out, format="PNG")


# ── Job registry (in-memory) ──────────────────────────────────────────────

Status = Literal["queued", "recording", "compositing", "done", "failed"]


@dataclass
class MockupJob:
    id: str
    status: Status = "queued"
    progress: str = ""
    output_url: str = ""        # 최종 산출물 URL (Supabase public)
    output_kind: str = "mp4"    # mp4 | png
    error: str = ""
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)

    def update(self, **kw):
        for k, v in kw.items():
            setattr(self, k, v)
        self.updated_at = time.time()


_JOBS: dict[str, MockupJob] = {}
_JOBS_LOCK = threading.Lock()
_EXECUTOR_LIMIT = 2  # 동시 처리 — Playwright는 무거움
_active = threading.Semaphore(_EXECUTOR_LIMIT)


def get_job(job_id: str) -> Optional[MockupJob]:
    with _JOBS_LOCK:
        return _JOBS.get(job_id)


def _create_job() -> MockupJob:
    job = MockupJob(id=uuid.uuid4().hex)
    with _JOBS_LOCK:
        _JOBS[job.id] = job
    return job


# ── High-level entrypoint ─────────────────────────────────────────────────

@dataclass
class GenerateRequest:
    mode: Literal["url", "upload"]
    url: Optional[str] = None              # mode='url'
    source_path: Optional[Path] = None     # mode='upload' (서버 측 임시 파일)
    source_is_video: bool = True           # upload 모드에서 mp4/png 구분
    device_id: str = "iphone-16-pro"
    aspect: str = "9:16"
    bg_color: str = "#1a1a2e"
    bg_image_path: Optional[Path] = None
    device_scale: float = 0.85
    viewport_w: int = 390
    viewport_h: int = 844
    duration_sec: float = 6.0
    # 이미지 upload 일 때만 의미 — zoompan motion preset.
    # 'none' 이면 PNG output (정지영상), 'zoom-in' 등은 mp4 output.
    motion: str = "none"
    # shots.so 벤치 ② — procedural 배경 preset id (BG_PRESETS). 우선순위 bg_image > bg_color.
    bg_preset: Optional[str] = None
    # shots.so 벤치 ④ — 최종 video stream 에 적용할 마감 효과 (OVERLAY_EFFECTS).
    overlay_effect: Optional[str] = None
    # shots.so audit 추가분
    device_shadow: Optional[str] = None      # SCENE: Shadow (none/soft/hard/glow/diffused)
    device_shadow_opacity: float = 1.0       # 0.0..1.0
    device_shadow_angle: Optional[float] = None  # Adjust Light (°). None=spec default
    device_style: Optional[str] = None       # frame 시각 변종 (default/outline/glass)
    hide_mockup: bool = False                # device frame 숨김 (screen 만)
    radius_override: Optional[int] = None    # corner_radius 사용자 override
    # shots.so audit phase 2 추가분
    tilt_x: float = 0.0                      # 3D perspective 좌우 기울기 (°)
    tilt_y: float = 0.0                      # 3D perspective 위아래 기울기 (°)
    scene_shapes: Optional[str] = None       # SCENE: Shapes 카탈로그 id
    # Animations 타임라인 (upload+이미지 일 때만 의미; 비어 있으면 단일 motion 경로)
    animation_keyframes: Optional[list[AnimKeyframe]] = None


# ── Motion preset (정적 이미지 → 살아있는 mp4) ──────────────────────────
# ffmpeg zoompan 으로 한 이미지에 미세 zoom + pan 을 입혀 영상화한다.
# 사용자의 앱 캡처 1장을 4-6초 mp4 로 만들어 주는 게 핵심 use case.
#
# 주의: zoompan 은 입력 frame 을 내부 처리 단계에서 trunc 해서 정수 zoom 만 보이는
# "stutter" 가 있는 게 유명한 함정. 해결책으로 입력을 미리 SCALE_UP 배 크게
# 리스케일해서 zoompan 의 정수화가 보이지 않게 한다 (표준 트릭).

SCALE_UP = 8  # zoompan stutter 회피용 사전 업스케일 배수


# ── Templates (사전 콤보 — shots.so audit 후속) ─────────────────────────
# 한 카드 클릭 = 디바이스 + 배경 + 스타일 + 그림자 + 모션 + 마감효과 + 비율
# 를 한 번에 set 해주는 thin preset.

TEMPLATES: dict[str, dict] = {
    "saas-cosmic": {
        "label": "SaaS 코스믹", "tagline": "어두운 우주 + 글래스 디바이스",
        "device_id": "iphone-16-pro", "aspect": "9:16",
        "bg_preset": "cosmic", "device_style": "glass",
        "device_shadow": "glow", "device_shadow_opacity": 0.9,
        "overlay_effect": "none", "motion": "zoom-in",
    },
    "warm-sunset": {
        "label": "웜 선셋", "tagline": "오렌지·핑크 + 부드러운 그림자",
        "device_id": "iphone-16-pro", "aspect": "9:16",
        "bg_preset": "sunset", "device_style": "default",
        "device_shadow": "soft", "device_shadow_opacity": 0.8,
        "overlay_effect": "none", "motion": "pan-tl-br",
    },
    "studio-paper": {
        "label": "스튜디오 페이퍼", "tagline": "베이지 + 하드 섀도우",
        "device_id": "iphone-16-pro", "aspect": "1:1",
        "bg_preset": "paper", "device_style": "default",
        "device_shadow": "hard", "device_shadow_opacity": 1.0,
        "overlay_effect": "none", "motion": "none",
    },
    "ocean-clean": {
        "label": "오션 클린", "tagline": "청량한 그라데이션 + 디퓨즈 섀도우",
        "device_id": "iphone-16-pro", "aspect": "4:5",
        "bg_preset": "ocean", "device_style": "default",
        "device_shadow": "diffused", "device_shadow_opacity": 0.7,
        "overlay_effect": "none", "motion": "zoom-in",
    },
    "android-mesh": {
        "label": "안드로이드 메시", "tagline": "Galaxy + 메시 그라데이션",
        "device_id": "galaxy-s25-ultra", "aspect": "9:16",
        "bg_preset": "mesh-cool", "device_style": "default",
        "device_shadow": "soft", "device_shadow_opacity": 0.85,
        "overlay_effect": "none", "motion": "zoom-in",
    },
    "retro-vhs": {
        "label": "레트로 VHS", "tagline": "VHS 효과 + 그레인",
        "device_id": "iphone-16-pro", "aspect": "9:16",
        "bg_preset": "grain-bw", "device_style": "outline",
        "device_shadow": "none", "device_shadow_opacity": 0.0,
        "overlay_effect": "vhs", "motion": "pulse",
    },
    "minimal-glass": {
        "label": "미니멀 글래스", "tagline": "글래스 디바이스 + 흰 배경",
        "device_id": "iphone-16-pro", "aspect": "4:5",
        "bg_preset": "glass", "device_style": "glass",
        "device_shadow": "soft", "device_shadow_opacity": 0.6,
        "overlay_effect": "none", "motion": "none",
    },
    "radiant-burst": {
        "label": "래디언트 버스트", "tagline": "Pixel + 중앙 burst + 글로우",
        "device_id": "pixel-9-pro", "aspect": "9:16",
        "bg_preset": "radiant", "device_style": "default",
        "device_shadow": "glow", "device_shadow_opacity": 1.0,
        "overlay_effect": "none", "motion": "zoom-out",
    },
}


def get_template(template_id: str) -> dict | None:
    return TEMPLATES.get(template_id)


# ── Overlay effects (shots.so 벤치 ④) ───────────────────────────────────
# 최종 합성된 mp4 의 video stream 에 한 줄 ffmpeg filter chain 을 덧붙여
# VHS / glitch / grain 같은 마감 효과를 입힌다. preview 는 (지금은) 미반영
# — 미적용 시 byte-identical (overlay_effect == 'none' 이면 분기 안 탐).

OVERLAY_EFFECTS: dict[str, dict] = {
    "none":      {"label": "효과 없음", "filter": ""},
    # VHS: 노이즈 + 약간의 hue 흔들림 + 가로 라인 (cellauto 대신 가벼운 조합)
    "vhs":       {"label": "VHS",
                  "filter": "noise=alls=18:allf=t,hue=h='2*sin(t*8)':s=1.05,curves=preset=increase_contrast"},
    # Glitch: 주기적인 큰 hue shift (시간 함수)
    "glitch":    {"label": "글리치",
                  "filter": "hue=h='40*sin(t*15)':s='1+0.2*sin(t*7)',eq=contrast=1.1"},
    # Film grain: 영화필름 결
    "grain":     {"label": "필름 그레인",
                  "filter": "noise=alls=10:allf=t+u,eq=contrast=1.05:saturation=0.95"},
    # CRT scanlines: sin 기반 주기 dim (geq == 파서 회피 + 더 부드러움; 주기 ≈ 3px)
    "scanlines": {"label": "스캔라인",
                  "filter": "geq=r='r(X,Y)*(0.82+0.18*(1+sin(Y*2.094))/2)':g='g(X,Y)*(0.82+0.18*(1+sin(Y*2.094))/2)':b='b(X,Y)*(0.82+0.18*(1+sin(Y*2.094))/2)'"},
    # Faded vintage: 색온도 + 살짝 페이드
    "vintage":   {"label": "빈티지",
                  "filter": "curves=preset=vintage,eq=brightness=0.02:saturation=0.85"},
}


# ── Tilt (3D perspective) ───────────────────────────────────────────────
# 전체 합성 영상에 ffmpeg perspective filter 적용 — 4 corner 를 안쪽으로 당겨
# 3D 회전 효과. v1 한계: 배경까지 함께 기울어짐 (단색/그라데이션 bg 와 가장
# 잘 어울림). v2 = 디바이스만 기울이려면 frame+screen 만 별도 filter chain.

def tilt_perspective(tilt_x: float, tilt_y: float,
                     w: int | None = None, h: int | None = None) -> str:
    """tilt_x/y ∈ [-30, 30] degree. 0/0 ⇒ '' (no-op, byte-identical).

    ffmpeg `perspective` 의 x0..x3, y0..y3 는 iw/ih expression 미지원이라
    실제 픽셀 값을 직접 계산해서 박아 넣는다. w/h 가 None 이면 placeholder
    필터 (signature 만 채움) 만 반환 — 호출자는 항상 w/h 를 넘겨야 한다.
    """
    if abs(tilt_x) < 0.5 and abs(tilt_y) < 0.5:
        return ""
    if w is None or h is None or w <= 0 or h <= 0:
        return ""
    fx = max(-0.45, min(0.45, float(tilt_x) / 60.0))
    fy = max(-0.45, min(0.45, float(tilt_y) / 60.0))
    top_in = max(0.0,  fy)
    bot_in = max(0.0, -fy)
    left_in_y  = max(0.0,  fx)
    right_in_y = max(0.0, -fx)
    # 4 corner output 좌표 (pixel)
    tl_x = int(w * top_in);              tl_y = int(h * left_in_y)
    tr_x = int(w * (1.0 - top_in));      tr_y = int(h * right_in_y)
    bl_x = int(w * bot_in);              bl_y = int(h * (1.0 - left_in_y))
    br_x = int(w * (1.0 - bot_in));      br_y = int(h * (1.0 - right_in_y))
    return (f"perspective=x0={tl_x}:y0={tl_y}:x1={tr_x}:y1={tr_y}:"
            f"x2={bl_x}:y2={bl_y}:x3={br_x}:y3={br_y}")


def effect_to_ffmpeg(effect_id: str) -> str:
    """preset 의 filter chain 문자열. 'none' / 미지값은 빈 문자열."""
    if not effect_id or effect_id == "none":
        return ""
    spec = OVERLAY_EFFECTS.get(effect_id)
    if not spec:
        return ""
    return spec["filter"]

MOTION_PRESETS: set[str] = {
    "none",
    "zoom-in",       # 가운데 중심 천천히 zoom in (1.0 → 1.18)
    "zoom-out",      # zoom out (1.18 → 1.0)
    "pan-tl-br",     # 좌상 → 우하 대각 pan + 살짝 zoom
    "pan-bl-tr",     # 좌하 → 우상 대각 pan + 살짝 zoom
    "pulse",         # zoom in 했다가 살짝 out (Ken Burns 호흡)
    "parallax",      # shots.so 'Parallax' — 살짝 zoom + 좌우 미세 swing (sin)
}


def _zoompan_expr(motion_id: str, duration_frames: int) -> tuple[str, str, str]:
    """preset 별 (z, x, y) ffmpeg zoompan 표현식. 가운데 정렬 기준."""
    d = duration_frames
    # zoompan 의 'on' 은 누적 출력 프레임 인덱스 (0..d-1)
    if motion_id == "zoom-in":
        return (
            f"1.0 + 0.18*on/{d-1}",       # z: 1.0 → 1.18
            "iw/2 - (iw/zoom/2)",          # x: 중앙
            "ih/2 - (ih/zoom/2)",
        )
    if motion_id == "zoom-out":
        return (
            f"1.18 - 0.18*on/{d-1}",
            "iw/2 - (iw/zoom/2)",
            "ih/2 - (ih/zoom/2)",
        )
    if motion_id == "pan-tl-br":
        # 1.18 배 줌 + 좌상 (x=0,y=0) → 우하 (x=iw-iw/zoom,y=ih-ih/zoom)
        return (
            "1.18",
            f"(iw - iw/zoom) * on/{d-1}",
            f"(ih - ih/zoom) * on/{d-1}",
        )
    if motion_id == "pan-bl-tr":
        return (
            "1.18",
            f"(iw - iw/zoom) * on/{d-1}",
            f"(ih - ih/zoom) * (1 - on/{d-1})",
        )
    if motion_id == "pulse":
        # 0→0.5 구간: 1.0 → 1.18, 0.5→1.0 구간: 1.18 → 1.05
        # 단순 piecewise: if(lt(on,d/2), 1.0 + 0.36*on/(d-1), 1.18 - 0.26*(on - (d-1)/2)/(d-1))
        half = (d - 1) / 2.0
        return (
            f"if(lt(on,{half}), 1.0 + 0.36*on/{d-1}, 1.18 - 0.26*(on-{half})/{d-1})",
            "iw/2 - (iw/zoom/2)",
            "ih/2 - (ih/zoom/2)",
        )
    if motion_id == "parallax":
        # shots.so 'Parallax' — 살짝 zoom 고정 + 좌우 미세 sin swing
        # 한 사이클 = duration 동안 1.5 회전 (=540°). 진폭은 iw 의 약 2.5%.
        return (
            "1.06",
            f"iw/2 - (iw/zoom/2) + iw*0.025*sin(2*PI*1.5*on/{d-1})",
            "ih/2 - (ih/zoom/2)",
        )
    # 'none' 은 호출자가 zoompan 대신 그냥 loop+t 를 써야 함 — 도달하면 안 됨
    raise ValueError(f"motion preset not zoompan-applicable: {motion_id}")


def image_with_motion(in_image: Path, duration_sec: float, motion_id: str,
                      out_w: int, out_h: int, out_mp4: Path,
                      fps: int = 30) -> None:
    """입력 이미지 1장 → motion 적용된 mp4 (duration_sec 길이, out_w x out_h).

    motion_id == 'none' 이면 zoompan 없이 단순 정지영상화 (`_scene_to_clip` 의
    image 경로와 동일). 그 외에는 zoompan + 사전 업스케일로 부드러운 모션.
    """
    if motion_id == "none":
        vf = (f"scale={out_w}:{out_h}:force_original_aspect_ratio=increase,"
              f"crop={out_w}:{out_h},setsar=1,fps={fps},format=yuv420p")
        _run_ffmpeg([
            "-loop", "1", "-i", str(in_image),
            "-t", f"{duration_sec:.3f}",
            "-vf", vf, "-an",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
            "-pix_fmt", "yuv420p",
            str(out_mp4),
        ], timeout=60)
        return
    if motion_id not in MOTION_PRESETS:
        raise ValueError(f"unknown motion preset: {motion_id}")

    total_frames = max(2, int(round(duration_sec * fps)))
    z_expr, x_expr, y_expr = _zoompan_expr(motion_id, total_frames)
    # 입력을 미리 SCALE_UP 배 키운 뒤 zoompan 적용 → 출력 크기로 다시 scale.
    # zoompan 의 s 는 출력 frame 의 px 크기. 사전 업스케일된 좌표계에서 잘라
    # 출력 해상도(out_w x out_h)로 직접 떨어뜨린다.
    vf = (
        f"scale=iw*{SCALE_UP}:ih*{SCALE_UP}:flags=lanczos,"
        f"zoompan=z='{z_expr}':x='{x_expr}':y='{y_expr}':"
        f"d={total_frames}:s={out_w}x{out_h}:fps={fps},"
        f"setsar=1,format=yuv420p"
    )
    _run_ffmpeg([
        "-loop", "1", "-i", str(in_image),
        "-t", f"{duration_sec:.3f}",
        "-vf", vf, "-an",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
        "-pix_fmt", "yuv420p",
        str(out_mp4),
    ], timeout=120)


# ── Animation timeline (한 화면 안에서 time-axis 자유 모션 배치) ────────
# v1: 이미지 입력 1장 + keyframes 리스트 → segment 별 image_with_motion 호출
# → ffmpeg concat → 단일 mp4. 빈 keyframes = 호출자가 build 단계 자체를 skip
# (byte-identical). 영상 입력은 v2.

@dataclass
class AnimKeyframe:
    """타임라인의 한 segment. [start_sec, end_sec) 구간에 motion 적용."""
    start_sec: float
    end_sec: float
    motion: str = "none"   # MOTION_PRESETS 의 id


def _fill_timeline_gaps(keyframes: list[AnimKeyframe], total_sec: float
                        ) -> list[AnimKeyframe]:
    """keyframes 를 시간 정렬 + 겹침 정리 + 빈 구간 'none' 으로 자동 채움.

    겹치는 segment 는 뒤에 등장한 keyframe 이 이긴다 (앞 segment 의 end 를
    뒤 segment 의 start 로 자른다). start_sec >= end_sec 인 segment 는 drop.
    """
    valid = [k for k in keyframes if k.end_sec > k.start_sec
             and k.start_sec >= 0 and k.end_sec <= total_sec + 0.01]
    valid.sort(key=lambda k: k.start_sec)
    # 겹침 해소
    cleaned: list[AnimKeyframe] = []
    for k in valid:
        if cleaned and k.start_sec < cleaned[-1].end_sec:
            cleaned[-1] = AnimKeyframe(
                start_sec=cleaned[-1].start_sec,
                end_sec=k.start_sec,
                motion=cleaned[-1].motion,
            )
            if cleaned[-1].end_sec <= cleaned[-1].start_sec:
                cleaned.pop()
        cleaned.append(k)
    # 빈 구간 채움
    out: list[AnimKeyframe] = []
    cursor = 0.0
    for k in cleaned:
        if k.start_sec - cursor > 0.05:
            out.append(AnimKeyframe(cursor, k.start_sec, "none"))
        out.append(k)
        cursor = k.end_sec
    if total_sec - cursor > 0.05:
        out.append(AnimKeyframe(cursor, total_sec, "none"))
    return out


def build_image_timeline(in_image: Path, keyframes: list[AnimKeyframe],
                         total_sec: float, w: int, h: int,
                         out_mp4: Path) -> None:
    """이미지 1장 + keyframes 리스트 → segment 별 motion mp4 → concat → out_mp4."""
    segs = _fill_timeline_gaps(keyframes, total_sec)
    if not segs:
        # 안전 폴백 — 전체 static 1 segment
        image_with_motion(in_image, total_sec, "none", w, h, out_mp4)
        return
    work = out_mp4.parent / f"_tl_{uuid.uuid4().hex[:8]}"
    work.mkdir(exist_ok=True)

    seg_paths: list[Path] = []
    try:
        for i, seg in enumerate(segs):
            dur = max(0.1, seg.end_sec - seg.start_sec)
            seg_mp4 = work / f"seg_{i:03d}.mp4"
            motion = seg.motion if seg.motion in MOTION_PRESETS else "none"
            image_with_motion(in_image, dur, motion, w, h, seg_mp4)
            seg_paths.append(seg_mp4)

        if len(seg_paths) == 1:
            shutil.move(str(seg_paths[0]), str(out_mp4))
            return

        # concat — segment 들이 동일 codec/해상도/fps 로 만들어졌으니 concat demuxer 가능
        list_file = work / "concat.txt"
        with open(list_file, "w", encoding="utf-8") as f:
            for p in seg_paths:
                # ffmpeg concat 파일은 single-quoted path, 백슬래시 OK
                escaped = str(p).replace("\\", "/").replace("'", r"\'")
                f.write(f"file '{escaped}'\n")
        _run_ffmpeg([
            "-f", "concat", "-safe", "0", "-i", str(list_file),
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
            "-pix_fmt", "yuv420p", "-movflags", "+faststart",
            str(out_mp4),
        ], timeout=180)
    finally:
        try: shutil.rmtree(work, ignore_errors=True)
        except: pass


# ── Scene sequence (멀티 화면 + xfade 트랜지션) ─────────────────────────
# 화면 N개를 받아서 ffmpeg xfade 체인으로 이어붙인 영상을 만든다.
# 각 화면은 이미지 또는 영상; 이미지면 loop+t 로 영상화.
# 결과 webm/mp4 는 기존 `_composite` 가 그대로 받아서 device frame 을 입힌다.

# xfade 가 지원하는 transition 키 — 프론트는 이 목록에서만 고를 수 있다.
SUPPORTED_TRANSITIONS = {
    "cut",          # ffmpeg xfade 가 'cut' 은 없음 → concat 만 (offset=clip 길이)
    "fade",         # xfade transition='fade'
    "slide-left",   # xfade transition='slideleft'
    "slide-right",  # xfade transition='slideright'
    "slide-up",     # xfade transition='slideup'
    "slide-down",   # xfade transition='slidedown'
}

_XFADE_NAME = {
    "fade": "fade",
    "slide-left": "slideleft",
    "slide-right": "slideright",
    "slide-up": "slideup",
    "slide-down": "slidedown",
}


@dataclass
class SceneSpec:
    """한 화면. file_path = 서버 측 임시 파일 (이미지 또는 영상)."""
    file_path: Path
    is_video: bool
    duration_sec: float = 2.5
    transition: str = "cut"        # 이 화면으로 들어올 때의 트랜지션 (첫 화면은 무시)
    transition_ms: int = 400       # 트랜지션 길이 (ms). cut 이면 무시.
    motion: str = "none"           # zoompan preset (이미지 화면에만 적용; 영상은 무시)


def _scene_to_clip(scene: SceneSpec, screen_w: int, screen_h: int,
                   out_mp4: Path) -> float:
    """한 scene 을 (screen_w x screen_h) 해상도 + 30fps 의 mp4 로 정규화.

    이미지면 `-loop 1 -t duration_sec` 로 영상화. 영상이면 그대로 디코드
    → scale+crop → setsar=1. 모두 동일한 코덱/픽포맷이라 다음 xfade 체인
    에서 stream 호환 문제가 안 난다. 반환값은 실제 clip 길이(초).
    """
    vf = (f"scale={screen_w}:{screen_h}:force_original_aspect_ratio=increase,"
          f"crop={screen_w}:{screen_h},setsar=1,fps=30,format=yuv420p")
    if scene.is_video:
        # 영상은 자기 길이를 따른다 (ffprobe 없이 ffmpeg 가 알아서 EOF)
        _run_ffmpeg([
            "-i", str(scene.file_path),
            "-vf", vf, "-an",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
            "-movflags", "+faststart",
            str(out_mp4),
        ], timeout=120)
        # 길이 = ffprobe 없이 추정: scene.duration_sec 가 0 이상이면 그것 우선,
        # 아니면 1초로 폴백 (xfade offset 계산에 필요). 정확하지 않아도 트랜지션
        # 시작점만 영향 — 한 scene 의 마지막 frame 으로 transition 들어감.
        return max(0.5, float(scene.duration_sec))
    # 이미지
    dur = max(0.5, min(60.0, float(scene.duration_sec)))
    motion = scene.motion if scene.motion in MOTION_PRESETS else "none"
    if motion != "none":
        image_with_motion(scene.file_path, dur, motion, screen_w, screen_h, out_mp4)
    else:
        _run_ffmpeg([
            "-loop", "1", "-i", str(scene.file_path),
            "-t", f"{dur:.3f}",
            "-vf", vf, "-an",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
            "-pix_fmt", "yuv420p",
            str(out_mp4),
        ], timeout=60)
    return dur


def make_scene_sequence(scenes: list[SceneSpec], screen_w: int, screen_h: int,
                        out_mp4: Path) -> float:
    """scenes 를 transition 체인으로 이어 붙인 mp4 를 만든다.

    1. 각 scene 을 동일 포맷의 mp4 로 정규화 (`_scene_to_clip`).
    2. transition === 'cut' 인 인접 쌍은 concat 으로, 나머지는 xfade 로 연결.
       구현 단순화를 위해 v1 은 *모든* 인접 쌍을 xfade 체인으로 연결하고,
       'cut' 은 transition_ms=0 + transition='fade' 로 매핑한다 (이펙트 없이
       즉시 교체와 같은 결과). 이렇게 하면 filter_complex 가 일관된 한 형태.
    3. 반환: 시퀀스 전체 길이(초).
    """
    if not scenes:
        raise ValueError("scenes 비어 있음")
    out_mp4.parent.mkdir(parents=True, exist_ok=True)
    work = out_mp4.parent / f"_seq_{uuid.uuid4().hex[:8]}"
    work.mkdir(exist_ok=True)

    # 1) 각 scene 정규화
    clip_paths: list[Path] = []
    clip_durs: list[float] = []
    for i, sc in enumerate(scenes):
        p = work / f"clip_{i:03d}.mp4"
        d = _scene_to_clip(sc, screen_w, screen_h, p)
        clip_paths.append(p)
        clip_durs.append(d)

    if len(clip_paths) == 1:
        shutil.move(str(clip_paths[0]), str(out_mp4))
        try: shutil.rmtree(work, ignore_errors=True)
        except: pass
        return clip_durs[0]

    # 2) xfade 체인 빌드
    #    각 인접 쌍 i→i+1 에 대해:
    #      transition_name (cut 이면 'fade'+dur=0.001 으로 즉시 컷)
    #      offset = (현재까지 시퀀스 길이) − transition_dur
    inputs: list[str] = []
    for p in clip_paths:
        inputs += ["-i", str(p)]

    filter_parts: list[str] = []
    prev_label = "0:v"
    elapsed = clip_durs[0]
    total = clip_durs[0]
    for i in range(1, len(clip_paths)):
        sc = scenes[i]
        kind = sc.transition if sc.transition in SUPPORTED_TRANSITIONS else "cut"
        if kind == "cut":
            xf_name = "fade"
            xf_dur = 0.001
        else:
            xf_name = _XFADE_NAME[kind]
            xf_dur = max(0.05, min(2.0, float(sc.transition_ms) / 1000.0))
        offset = max(0.0, elapsed - xf_dur)
        out_label = f"v{i}"
        filter_parts.append(
            f"[{prev_label}][{i}:v]xfade=transition={xf_name}:"
            f"duration={xf_dur:.3f}:offset={offset:.3f}[{out_label}]"
        )
        prev_label = out_label
        # 트랜지션은 두 클립이 xf_dur 만큼 겹쳐서 발생 — 누적 길이는 clip_dur - xf_dur 만큼만 추가
        total = elapsed + clip_durs[i] - xf_dur
        elapsed = total

    fc = ";".join(filter_parts)
    _run_ffmpeg([
        *inputs,
        "-filter_complex", fc,
        "-map", f"[{prev_label}]",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
        "-pix_fmt", "yuv420p", "-movflags", "+faststart",
        str(out_mp4),
    ], timeout=300)

    try: shutil.rmtree(work, ignore_errors=True)
    except: pass
    return total


def submit_job(req: GenerateRequest, *, user_id: str,
               upload_to_supabase) -> MockupJob:
    """비동기 작업 시작. upload_to_supabase(bytes, ext) → public_url callable."""
    job = _create_job()

    def run():
        _active.acquire()
        try:
            _run_job(job, req, user_id=user_id, upload_to_supabase=upload_to_supabase)
        except Exception as e:
            job.update(status="failed", error=str(e)[:500])
        finally:
            _active.release()

    t = threading.Thread(target=run, daemon=True)
    t.start()
    return job


@dataclass
class GenerateSequenceRequest:
    """멀티 화면 시퀀스 → 디바이스 프레임 합성."""
    scenes: list[SceneSpec]
    device_id: str = "iphone-16-pro"
    aspect: str = "9:16"
    bg_color: str = "#1a1a2e"
    bg_image_path: Optional[Path] = None
    device_scale: float = 0.85
    bg_preset: Optional[str] = None
    overlay_effect: Optional[str] = None
    device_shadow: Optional[str] = None
    device_shadow_opacity: float = 1.0
    device_shadow_angle: Optional[float] = None
    device_style: Optional[str] = None
    hide_mockup: bool = False
    radius_override: Optional[int] = None
    tilt_x: float = 0.0
    tilt_y: float = 0.0
    scene_shapes: Optional[str] = None


def submit_sequence_job(req: GenerateSequenceRequest, *, user_id: str,
                        upload_to_supabase) -> MockupJob:
    """비동기 시퀀스 작업. submit_job 과 같은 패턴, _run_sequence_job 으로 분기."""
    job = _create_job()

    def run():
        _active.acquire()
        try:
            _run_sequence_job(job, req, user_id=user_id,
                              upload_to_supabase=upload_to_supabase)
        except Exception as e:
            job.update(status="failed", error=str(e)[:500])
        finally:
            _active.release()

    t = threading.Thread(target=run, daemon=True)
    t.start()
    return job


def _run_sequence_job(job: MockupJob, req: GenerateSequenceRequest, *,
                      user_id: str, upload_to_supabase) -> None:
    work = Path(tempfile.mkdtemp(prefix=f"mockup_seq_{job.id}_"))
    try:
        if not req.scenes:
            raise ValueError("scenes 비어 있음")
        if req.device_id not in DEVICES:
            raise ValueError(f"unknown device: {req.device_id}")
        if req.aspect not in ASPECTS:
            raise ValueError(f"unknown aspect: {req.aspect}")

        spec = DEVICES[req.device_id]
        body_w, body_h = spec["body_w"], spec["body_h"]
        canvas_w, canvas_h = ASPECTS[req.aspect]
        sx, sy, sw, sh = device_aperture(req.device_id)
        # screen 해상도는 frame PNG 좌표계 기준으로 잡는다 (composite_video 가
        # 이걸 canvas 좌표로 다시 scale 함). 시퀀스 영상 자체는 frame 의 screen
        # 영역과 같은 픽셀 비율이면 충분 — 정확히 같은 px 일 필요는 없지만,
        # 동일 px 로 만들면 composite 단계에서 ffmpeg scale 이 거의 1:1.
        screen_w, screen_h = sw, sh

        # 1) 시퀀스 영상 만들기
        job.update(status="recording", progress=f"화면 {len(req.scenes)}개 정규화/연결 중")
        seq_mp4 = work / "sequence.mp4"
        make_scene_sequence(req.scenes, screen_w, screen_h, seq_mp4)

        # 2) 디바이스 프레임 합성
        job.update(status="compositing", progress="디바이스 프레임 합성 중")
        out_path = work / "out.mp4"
        composite_video(seq_mp4, req.device_id, req.aspect,
                        req.bg_color, req.bg_image_path,
                        req.device_scale, out_path,
                        bg_preset=req.bg_preset,
                        overlay_effect=req.overlay_effect,
                        device_shadow=req.device_shadow,
                        device_shadow_opacity=req.device_shadow_opacity,
                        device_style=req.device_style,
                        hide_mockup=req.hide_mockup,
                        radius_override=req.radius_override)

        # 3) 업로드
        job.update(progress="업로드 중")
        data = out_path.read_bytes()
        public_url = upload_to_supabase(data, "mp4", user_id=user_id)

        job.update(status="done", output_url=public_url,
                   output_kind="mp4", progress="완료")
    finally:
        try: shutil.rmtree(work, ignore_errors=True)
        except: pass


def _run_job(job: MockupJob, req: GenerateRequest, *, user_id: str,
             upload_to_supabase) -> None:
    work = Path(tempfile.mkdtemp(prefix=f"mockup_{job.id}_"))
    try:
        # 1) source 확보
        if req.mode == "url":
            if not req.url:
                raise ValueError("url 필수")
            job.update(status="recording", progress="페이지 녹화 중")
            webm = work / "source.webm"
            record_url(req.url, req.viewport_w, req.viewport_h,
                       req.duration_sec, webm)
            source = webm
            is_video = True
        else:
            if not req.source_path or not req.source_path.exists():
                raise ValueError("업로드 파일 없음")
            source = req.source_path
            is_video = req.source_is_video

        # 2) composite
        # 이미지 + (motion preset OR animation timeline) 이면 먼저 영상화 → video 경로
        motion = (req.motion or "none") if not is_video else "none"
        has_timeline = bool(req.animation_keyframes) and not is_video
        if has_timeline:
            sx, sy, sw, sh = device_aperture(req.device_id)
            job.update(status="recording",
                       progress=f"애니메이션 타임라인 ({len(req.animation_keyframes)}개 keyframe)")
            mot_mp4 = work / "timeline.mp4"
            build_image_timeline(source, req.animation_keyframes,
                                  req.duration_sec, sw, sh, mot_mp4)
            source = mot_mp4
            is_video = True
        elif motion != "none" and motion in MOTION_PRESETS:
            sx, sy, sw, sh = device_aperture(req.device_id)
            job.update(status="recording", progress=f"이미지 모션({motion}) 적용 중")
            mot_mp4 = work / "motion.mp4"
            image_with_motion(source, req.duration_sec, motion, sw, sh, mot_mp4)
            source = mot_mp4
            is_video = True
        job.update(status="compositing", progress="디바이스 프레임 합성 중")
        ext = "mp4" if is_video else "png"
        out_path = work / f"out.{ext}"
        if is_video:
            composite_video(source, req.device_id, req.aspect,
                            req.bg_color, req.bg_image_path,
                            req.device_scale, out_path,
                            bg_preset=req.bg_preset,
                            overlay_effect=req.overlay_effect,
                            device_shadow=req.device_shadow,
                            device_shadow_opacity=req.device_shadow_opacity,
                            device_shadow_angle=req.device_shadow_angle,
                            device_style=req.device_style,
                            hide_mockup=req.hide_mockup,
                            radius_override=req.radius_override,
                            tilt_x=req.tilt_x, tilt_y=req.tilt_y,
                            scene_shapes=req.scene_shapes)
        else:
            composite_image(source, req.device_id, req.aspect,
                            req.bg_color, req.bg_image_path,
                            req.device_scale, out_path,
                            bg_preset=req.bg_preset,
                            device_shadow=req.device_shadow,
                            device_shadow_opacity=req.device_shadow_opacity,
                            device_shadow_angle=req.device_shadow_angle,
                            device_style=req.device_style,
                            hide_mockup=req.hide_mockup,
                            radius_override=req.radius_override,
                            tilt_x=req.tilt_x, tilt_y=req.tilt_y,
                            scene_shapes=req.scene_shapes)

        # 3) upload
        job.update(progress="업로드 중")
        data = out_path.read_bytes()
        public_url = upload_to_supabase(data, ext, user_id=user_id)

        job.update(status="done", output_url=public_url,
                   output_kind=ext, progress="완료")
    finally:
        try: shutil.rmtree(work, ignore_errors=True)
        except: pass
