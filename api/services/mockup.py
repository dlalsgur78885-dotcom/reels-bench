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
from PIL import Image, ImageChops, ImageDraw

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
}

ASPECTS = {
    "9:16": (1080, 1920),
    "1:1":  (1080, 1080),
    "16:9": (1920, 1080),
}

# ── Device frame rendering ────────────────────────────────────────────────

def device_aperture(device_id: str) -> tuple[int, int, int, int]:
    """screen 영역 (x, y, w, h) — frame PNG 내부 좌표."""
    s = DEVICES[device_id]
    bz = s["bezel"]
    return (bz, bz, s["body_w"] - 2 * bz, s["body_h"] - 2 * bz)


def render_device_frame(device_id: str) -> bytes:
    """디바이스 프레임 PNG bytes. screen 영역은 알파 투명."""
    s = DEVICES[device_id]
    W, H = s["body_w"], s["body_h"]
    bz = s["bezel"]
    sx, sy = bz, bz
    sw, sh = W - 2 * bz, H - 2 * bz

    body_color = _hex_to_rgba(s["color"])
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Body (rounded rect)
    draw.rounded_rectangle((0, 0, W - 1, H - 1),
                           radius=s["corner_radius"], fill=body_color)

    # Subtle inner highlight (thin lighter ring along bezel)
    inset = 6
    highlight = tuple(min(255, c + 30) for c in body_color[:3]) + (180,)
    draw.rounded_rectangle((inset, inset, W - 1 - inset, H - 1 - inset),
                           radius=s["corner_radius"] - inset,
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
                    device_scale: float, out_path: Path) -> None:
    """source(mp4/webm) + bg + device frame → out_path(mp4)."""
    _composite(source, device_id, aspect, bg_color, bg_image,
               device_scale, out_path, is_video=True)


def composite_image(source: Path, device_id: str, aspect: str,
                    bg_color: str, bg_image: Optional[Path],
                    device_scale: float, out_path: Path) -> None:
    """source(png/jpg) + bg + device frame → out_path(png)."""
    _composite(source, device_id, aspect, bg_color, bg_image,
               device_scale, out_path, is_video=False)


def _composite(source: Path, device_id: str, aspect: str,
               bg_color: str, bg_image: Optional[Path],
               device_scale: float, out_path: Path, is_video: bool) -> None:
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

    # device frame PNG → temp 파일
    tmp_frame = out_path.parent / f"_frame_{device_id}.png"
    tmp_frame.write_bytes(render_device_frame(device_id))

    # bg PNG (solid color or uploaded image)
    tmp_bg = out_path.parent / f"_bg_{uuid.uuid4().hex[:8]}.png"
    _make_background(bg_color, bg_image, canvas_w, canvas_h, tmp_bg)

    out_path.parent.mkdir(parents=True, exist_ok=True)

    if is_video:
        # filter_complex:
        #   [0]=bg PNG (looped)  [1]=source video  [2]=frame PNG (looped)
        #   `overlay=shortest=1` 로 source video 길이에 맞춰 잘림
        fc = (
            f"[1:v]scale={scr_w}:{scr_h}:force_original_aspect_ratio=increase,"
            f"crop={scr_w}:{scr_h},setpts=PTS-STARTPTS[scr];"
            f"[0:v][scr]overlay={scr_x}:{scr_y}:shortest=1[base];"
            f"[2:v]scale={dev_w}:{dev_h}[dev];"
            f"[base][dev]overlay={dev_x}:{dev_y}:shortest=1,format=yuv420p"
        )
        _run_ffmpeg([
            "-loop", "1", "-i", str(tmp_bg),
            "-i", str(source),
            "-loop", "1", "-i", str(tmp_frame),
            "-filter_complex", fc,
            "-shortest", "-fflags", "+shortest",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast",
            "-crf", "20", "-movflags", "+faststart",
            str(out_path),
        ], timeout=240)
    else:
        fc = (
            f"[1:v]scale={scr_w}:{scr_h}:force_original_aspect_ratio=increase,"
            f"crop={scr_w}:{scr_h}[scr];"
            f"[0:v][scr]overlay={scr_x}:{scr_y}[base];"
            f"[2:v]scale={dev_w}:{dev_h}[dev];"
            f"[base][dev]overlay={dev_x}:{dev_y}"
        )
        _run_ffmpeg([
            "-i", str(tmp_bg),
            "-i", str(source),
            "-i", str(tmp_frame),
            "-filter_complex", fc,
            "-frames:v", "1",
            str(out_path),
        ], timeout=60)

    # cleanup
    try: tmp_frame.unlink()
    except: pass
    try: tmp_bg.unlink()
    except: pass


def _make_background(bg_color: str, bg_image: Optional[Path],
                     w: int, h: int, out: Path) -> None:
    if bg_image and bg_image.exists():
        img = Image.open(bg_image).convert("RGBA")
        # center-crop to canvas aspect
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
        img = img.resize((w, h), Image.LANCZOS)
        img.save(out, format="PNG")
        return

    # solid color
    rgba = _hex_to_rgba(bg_color)
    img = Image.new("RGBA", (w, h), rgba)
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
        job.update(status="compositing", progress="디바이스 프레임 합성 중")
        ext = "mp4" if is_video else "png"
        out_path = work / f"out.{ext}"
        if is_video:
            composite_video(source, req.device_id, req.aspect,
                            req.bg_color, req.bg_image_path,
                            req.device_scale, out_path)
        else:
            composite_image(source, req.device_id, req.aspect,
                            req.bg_color, req.bg_image_path,
                            req.device_scale, out_path)

        # 3) upload
        job.update(progress="업로드 중")
        data = out_path.read_bytes()
        public_url = upload_to_supabase(data, ext, user_id=user_id)

        job.update(status="done", output_url=public_url,
                   output_kind=ext, progress="완료")
    finally:
        try: shutil.rmtree(work, ignore_errors=True)
        except: pass
