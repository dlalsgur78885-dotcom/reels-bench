"""편집된 Figma 디자인 → 애니메이션 HTML → Playwright 녹화 → mp4.

Pipeline:
  base_image_url (Figma raster export) + 편집된 text layers + animation specs
  → 임시 HTML 페이지 (file:// 로 Playwright가 연다)
  → Playwright headless 녹화 (N초)
  → webm → ffmpeg mp4 변환 (선택)
"""

from __future__ import annotations

import html
import json
import shutil
import tempfile
import time
from pathlib import Path
from typing import Literal, Optional

import requests

# 지원 애니메이션 프리셋
ANIMATIONS = {
    "none":        {"label": "없음",       "css_in": "", "duration_ms": 0},
    "fade-in":     {"label": "페이드 인",  "css_in": "fadeIn",   "duration_ms": 600},
    "slide-up":    {"label": "슬라이드 ↑", "css_in": "slideUp",  "duration_ms": 700},
    "slide-down":  {"label": "슬라이드 ↓", "css_in": "slideDown", "duration_ms": 700},
    "slide-left":  {"label": "슬라이드 ←", "css_in": "slideLeft", "duration_ms": 700},
    "slide-right": {"label": "슬라이드 →", "css_in": "slideRight", "duration_ms": 700},
    "scale-in":    {"label": "스케일 인",  "css_in": "scaleIn",  "duration_ms": 600},
    "typewriter":  {"label": "타자 효과",  "css_in": "typewriter", "duration_ms": 1200},
}


CSS_KEYFRAMES = """
@keyframes fadeIn      { from { opacity: 0; }            to { opacity: 1; } }
@keyframes slideUp     { from { opacity: 0; transform: translateY(40px); } to { opacity: 1; transform: translateY(0); } }
@keyframes slideDown   { from { opacity: 0; transform: translateY(-40px); } to { opacity: 1; transform: translateY(0); } }
@keyframes slideLeft   { from { opacity: 0; transform: translateX(40px); } to { opacity: 1; transform: translateX(0); } }
@keyframes slideRight  { from { opacity: 0; transform: translateX(-40px); } to { opacity: 1; transform: translateX(0); } }
@keyframes scaleIn     { from { opacity: 0; transform: scale(0.85); }      to { opacity: 1; transform: scale(1); } }
@keyframes typewriter  { from { width: 0; } to { width: 100%; } }
"""


def build_animation_html(*,
                         base_image_url: str,
                         frame_w: int, frame_h: int,
                         layers: list[dict],
                         duration_sec: float = 4.0) -> str:
    """편집된 텍스트 레이어 + 애니메이션 → 자가완결 HTML 페이지.

    layers item 구조:
      {
        id, text, x, y, w, h,
        font_family, font_size, font_weight, color, align,
        line_height_px, letter_spacing,
        animation (preset key), delay_ms (시작 지연)
      }
    """
    # base image: URL이면 그대로, 로컬 path면 file:// 처리는 호출자 책임
    safe_bg = html.escape(base_image_url, quote=True)

    layer_html_parts: list[str] = []
    for i, L in enumerate(layers):
        anim_key = L.get("animation", "none")
        anim = ANIMATIONS.get(anim_key, ANIMATIONS["none"])
        delay = max(0, int(L.get("delay_ms", 0)))
        css_anim = ""
        anim_extra_css = ""
        if anim["css_in"]:
            css_anim = (f"animation: {anim['css_in']} {anim['duration_ms']}ms "
                        f"cubic-bezier(0.22, 1, 0.36, 1) {delay}ms both;")
            # typewriter는 시작 전 width:0 + overflow:hidden + whitespace:nowrap
            if anim_key == "typewriter":
                anim_extra_css = ("white-space: nowrap; overflow: hidden; "
                                  "display: inline-block; ")
        else:
            # 애니메이션 없음이라도 delay 동안 숨김 처리 필요? 아니, 그냥 표시.
            pass

        lh = L.get("line_height_px")
        line_height_css = f"line-height: {float(lh):.2f}px;" if lh else ""
        ls = L.get("letter_spacing") or 0
        letter_css = f"letter-spacing: {float(ls):.3f}px;" if ls else ""

        fonts = (L.get("font_family") or "Inter").replace("'", "")
        text = html.escape(L.get("text", ""))

        layer_html_parts.append(f"""
        <div class="layer" style="
            position: absolute;
            left: {float(L.get('x', 0)):.2f}px;
            top: {float(L.get('y', 0)):.2f}px;
            width: {float(L.get('w', 0)):.2f}px;
            min-height: {float(L.get('h', 0)):.2f}px;
            color: {html.escape(L.get('color', '#000'))};
            font-family: '{html.escape(fonts)}', system-ui, -apple-system, sans-serif;
            font-size: {float(L.get('font_size', 16)):.2f}px;
            font-weight: {int(L.get('font_weight', 400))};
            text-align: {html.escape(L.get('align', 'left'))};
            {line_height_css}
            {letter_css}
            {anim_extra_css}
            {css_anim}
        ">{text}</div>
        """)

    layers_html = "\n".join(layer_html_parts)

    return f"""<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<title>Figma Mockup Animation</title>
<style>
  html, body {{ margin: 0; padding: 0; overflow: hidden; background: transparent; }}
  body {{ width: {frame_w}px; height: {frame_h}px; }}
  .stage {{
    position: relative;
    width: {frame_w}px;
    height: {frame_h}px;
    background: url('{safe_bg}') center/cover no-repeat #fff;
  }}
  {CSS_KEYFRAMES}
</style>
</head>
<body>
  <div class="stage">
    {layers_html}
  </div>
  <script>
    // 폰트 로딩 완료까지 기다림 — Playwright가 page.evaluate로 확인
    window.__ready = false;
    (async () => {{
      try {{ await document.fonts.ready; }} catch (_) {{}}
      // 이미지 디코딩
      const img = new Image();
      img.src = '{safe_bg}';
      try {{ await img.decode(); }} catch (_) {{}}
      window.__ready = true;
    }})();
  </script>
</body>
</html>"""


def download_image(url: str, out_path: Path, timeout: int = 30) -> None:
    r = requests.get(url, timeout=timeout, stream=True)
    r.raise_for_status()
    with open(out_path, "wb") as f:
        for chunk in r.iter_content(chunk_size=1 << 16):
            f.write(chunk)


def record_animation(html_path: Path, frame_w: int, frame_h: int,
                     duration_sec: float, out_webm: Path) -> None:
    """build_animation_html() 가 만든 file:// HTML을 Playwright로 녹화."""
    from playwright.sync_api import sync_playwright

    out_webm.parent.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(
            viewport={"width": frame_w, "height": frame_h},
            device_scale_factor=1,
            record_video_dir=str(out_webm.parent),
            record_video_size={"width": frame_w, "height": frame_h},
        )
        page = ctx.new_page()
        page.goto(html_path.as_uri(), wait_until="load", timeout=15000)
        # 폰트/이미지 로딩 대기 (최대 5초)
        try:
            page.wait_for_function("window.__ready === true", timeout=5000)
        except Exception:
            pass
        # 애니메이션 끝까지 + 여유
        page.wait_for_timeout(int(duration_sec * 1000))
        video = page.video
        ctx.close()
        browser.close()
        if video:
            actual = Path(video.path())
            if actual != out_webm:
                if out_webm.exists():
                    out_webm.unlink()
                shutil.move(str(actual), str(out_webm))
