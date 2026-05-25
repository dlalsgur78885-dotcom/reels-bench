"""Mockup Worker — Render 배포용 (Playwright + ffmpeg 무거운 작업).

api/server.py 의 무거운 mockup/figma render endpoints만 분리.
Vercel serverless에서 안 돌아가는 작업(Chromium ~170MB, in-memory job state)을
Render long-running 서비스에서 처리.

남은 가벼운 endpoints는 main backend (Vercel) 에 그대로:
  - /api/figma/oauth/*, status, disconnect, fetch (Figma API 호출만)
  - /api/mockup/devices, /api/mockup/frame/:id.png
"""

from __future__ import annotations

import logging
import os
import shutil
import sys
import tempfile
import threading
import uuid
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

ROOT = Path(__file__).parent
load_dotenv(ROOT / ".env")
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "api"))

from api.services import auth as auth_svc          # noqa: E402
from api.services import supabase as supa_svc      # noqa: E402
from api.services import mockup as mockup_svc      # noqa: E402
from api.services import figma as figma_svc        # noqa: E402
from api.services import figma_render as figma_render_svc  # noqa: E402

logger = logging.getLogger("uvicorn.error")

app = FastAPI(title="mockup-worker")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

_MOCKUP_BUCKET = "mockup-outputs"
_MOCKUP_UPLOADS = ROOT / "data" / "mockup_uploads"


def _upload_to_supabase(data: bytes, ext: str, *, user_id: str) -> str:
    supa_svc.storage_create_bucket(_MOCKUP_BUCKET, public=True)
    fid = uuid.uuid4().hex
    path = f"{user_id}/{fid}.{ext}"
    ct = "video/mp4" if ext == "mp4" else "image/png"
    ok, err = supa_svc.storage_upload(_MOCKUP_BUCKET, path, data,
                                       content_type=ct, upsert=True)
    if not ok:
        raise HTTPException(500, f"Storage 업로드 실패: {err}")
    return supa_svc.storage_public_url(_MOCKUP_BUCKET, path)


@app.get("/")
@app.get("/api/health")
def health():
    return {"ok": True, "service": "mockup-worker"}


@app.on_event("startup")
def warm_up_frame_preview_cache():
    """프론트가 Mockup 탭 클릭 시 18+ 카드 동시 fetch — 직렬 cold 처리 시
    20s+ 걸림. 서버 시작 시 모든 변형 미리 캐시 채워두면 그 후 모든 호출
    캐시 hit (~0.2s)."""
    def _warm():
        try:
            did = "iphone-16-pro"
            # STYLE 9
            for sid in mockup_svc.DEVICE_STYLES.keys():
                mockup_svc.render_frame_preview(did, style=sid, dummy_bg_id="sunset")
            # SHADOW 5
            for sid in mockup_svc.DEVICE_SHADOWS.keys():
                if sid == "none":
                    mockup_svc.render_frame_preview(did, dummy_bg_id="mesh-cool")
                else:
                    mockup_svc.render_frame_preview(did, shadow=sid, dummy_bg_id="mesh-cool")
            # BORDER 4
            for r in (None, 0, 120, 240):
                mockup_svc.render_frame_preview(did, radius_override=r, dummy_bg_id="ocean")
            logger.info("[warmup] frame-preview cache populated")
        except Exception as e:
            logger.warning(f"[warmup] failed: {e}")
    # background — startup 자체는 막지 않음
    threading.Thread(target=_warm, daemon=True).start()


# ── Static helpers (devices + frame PNG) — Vercel에도 있지만 worker 단독 동작 위해 복제 ──

@app.get("/api/mockup/devices")
def devices(request: Request):
    auth_svc.require_user(request)
    out = []
    for did, spec in mockup_svc.DEVICES.items():
        sx, sy, sw, sh = mockup_svc.device_aperture(did)
        out.append({
            "id": did, "name": spec["name"],
            "body_w": spec["body_w"], "body_h": spec["body_h"],
            "screen_x": sx, "screen_y": sy,
            "screen_w": sw, "screen_h": sh,
            "screen_radius": spec["screen_radius"],
            "corner_radius": spec["corner_radius"],
            "color": spec["color"], "notch": spec.get("notch", False),
        })
    return {"devices": out}


@app.get("/api/mockup/backgrounds")
def backgrounds(request: Request):
    auth_svc.require_user(request)
    return {"backgrounds": [
        {"id": pid, "label": spec["label"]}
        for pid, spec in mockup_svc.BG_PRESETS.items()
    ]}


@app.get("/api/mockup/background/{preset_id}.png")
def background_png(preset_id: str, request: Request):
    # public — procedural 배경 thumbnail
    if preset_id not in mockup_svc.BG_PRESETS:
        raise HTTPException(404, "unknown bg preset")
    png = mockup_svc.render_bg_preset_thumbnail(preset_id)
    return Response(content=png, media_type="image/png",
                    headers={"Cache-Control": "public, max-age=3600"})


@app.get("/api/mockup/effects")
def effects(request: Request):
    auth_svc.require_user(request)
    return {"effects": [
        {"id": eid, "label": spec["label"]}
        for eid, spec in mockup_svc.OVERLAY_EFFECTS.items()
    ]}


@app.get("/api/mockup/frame/{device_id}.png")
def frame_png(device_id: str, request: Request,
              style: str | None = None,
              radius: int | None = None,
              shadow: str | None = None,
              shadow_opacity: float = 1.0,
              shadow_angle: float | None = None):
    # public — procedural 디바이스 frame 이미지, 민감 데이터 없음.
    # 카드 background-image 호출이 Authorization 헤더 없이 가니까 인증 제거.
    if device_id not in mockup_svc.DEVICES:
        raise HTTPException(404, "unknown device")
    use_style = style if (style and style in mockup_svc.DEVICE_STYLES) else None
    png = mockup_svc.render_device_frame(device_id, style=use_style,
                                          radius_override=radius)
    if shadow and shadow in mockup_svc.DEVICE_SHADOWS and shadow != "none":
        png = mockup_svc.add_device_shadow(png, shadow,
                                            opacity=max(0.0, min(1.0, shadow_opacity)),
                                            angle_deg=shadow_angle)
    return Response(content=png, media_type="image/png",
                    headers={"Cache-Control": "public, max-age=3600"})


@app.get("/api/mockup/templates")
def templates(request: Request):
    auth_svc.require_user(request)
    out = []
    for tid, spec in mockup_svc.TEMPLATES.items():
        # 미리보기 thumbnail 은 bg_preset 의 thumbnail URL 을 재사용 (단순화)
        out.append({
            "id": tid,
            "label": spec["label"],
            "tagline": spec.get("tagline", ""),
            "device_id": spec["device_id"],
            "aspect": spec["aspect"],
            "bg_preset": spec["bg_preset"],
            "device_style": spec["device_style"],
            "device_shadow": spec["device_shadow"],
            "device_shadow_opacity": spec["device_shadow_opacity"],
            "overlay_effect": spec["overlay_effect"],
            "motion": spec["motion"],
        })
    return {"templates": out}


@app.get("/api/mockup/frame-preview/{device_id}.png")
def frame_preview_png(device_id: str, request: Request,
                      style: str | None = None,
                      radius: int | None = None,
                      shadow: str | None = None,
                      shadow_opacity: float = 1.0,
                      shadow_angle: float | None = None,
                      bg: str = "sunset"):
    """STYLE/SHADOW 카드용 frame + 더미 screen content 합성 미리보기 PNG. public."""
    if device_id not in mockup_svc.DEVICES:
        raise HTTPException(404, "unknown device")
    use_style = style if (style and style in mockup_svc.DEVICE_STYLES) else None
    use_bg = bg if bg in mockup_svc.BG_PRESETS else "sunset"
    png = mockup_svc.render_frame_preview(
        device_id, style=use_style, radius_override=radius,
        shadow=shadow, shadow_opacity=max(0.0, min(1.0, shadow_opacity)),
        shadow_angle=shadow_angle, dummy_bg_id=use_bg,
    )
    return Response(content=png, media_type="image/png",
                    headers={"Cache-Control": "public, max-age=3600"})


@app.get("/api/mockup/device-styles")
def device_styles(request: Request):
    auth_svc.require_user(request)
    return {"styles": [{"id": sid, "label": spec["label"]}
                       for sid, spec in mockup_svc.DEVICE_STYLES.items()]}


@app.get("/api/mockup/device-shadows")
def device_shadows(request: Request):
    auth_svc.require_user(request)
    return {"shadows": [{"id": sid, "label": spec["label"]}
                        for sid, spec in mockup_svc.DEVICE_SHADOWS.items()]}


@app.get("/api/mockup/magic-bg/{file_id}.png")
def magic_bg_png(file_id: str, request: Request, w: int = 540, h: int = 720):
    """업로드된 미디어 → dominant color 2개 vertical gradient PNG. shots.so 'Magic' v1."""
    me = auth_svc.require_user(request)
    src = _resolve_upload(me["id"], file_id)
    if not src:
        raise HTTPException(404, "file not found")
    try:
        img = mockup_svc.magic_bg_from_image(src, max(64, min(2000, w)), max(64, min(2000, h)))
        import io as _io
        buf = _io.BytesIO()
        img.save(buf, format="PNG", optimize=True)
        return Response(content=buf.getvalue(), media_type="image/png",
                        headers={"Cache-Control": "no-store"})
    except Exception as e:
        raise HTTPException(500, f"magic bg failed: {str(e)[:200]}")


@app.get("/api/mockup/unsplash/search")
def unsplash_search(q: str, request: Request, per_page: int = 12):
    """Unsplash Search API 프록시. UNSPLASH_ACCESS_KEY 없으면 503."""
    auth_svc.require_user(request)
    key = (os.getenv("UNSPLASH_ACCESS_KEY") or "").strip()
    if not key:
        raise HTTPException(503, "UNSPLASH_ACCESS_KEY 미설정 — env 추가 필요")
    import requests
    try:
        r = requests.get("https://api.unsplash.com/search/photos",
                         params={"query": q, "per_page": max(1, min(30, per_page)),
                                 "orientation": "landscape"},
                         headers={"Authorization": f"Client-ID {key}"},
                         timeout=12)
        if r.status_code != 200:
            raise HTTPException(r.status_code, f"unsplash: {r.text[:200]}")
        data = r.json()
        results = [{
            "id": x.get("id"),
            "thumb": x.get("urls", {}).get("thumb"),
            "small": x.get("urls", {}).get("small"),
            "regular": x.get("urls", {}).get("regular"),
            "alt": x.get("alt_description") or x.get("description") or "",
            "author": (x.get("user") or {}).get("name") or "",
        } for x in data.get("results", []) if x.get("urls")]
        return {"results": results, "total": data.get("total", 0)}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"unsplash error: {str(e)[:200]}")


@app.get("/api/mockup/scene-shapes")
def scene_shapes_catalog(request: Request):
    auth_svc.require_user(request)
    return {"shapes": [{"id": sid, "label": spec["label"]}
                       for sid, spec in mockup_svc.SCENE_SHAPES.items()]}


@app.get("/api/mockup/scene-shape/{shape_id}.png")
def scene_shape_thumb(shape_id: str, request: Request):
    # public — procedural shape thumbnail
    if shape_id not in mockup_svc.SCENE_SHAPES:
        raise HTTPException(404, "unknown shape")
    png = mockup_svc.render_scene_shape_thumbnail(shape_id)
    return Response(content=png, media_type="image/png",
                    headers={"Cache-Control": "public, max-age=3600"})


# ── Heavy: source upload ─────────────────────────────────────────────────

@app.post("/api/mockup/upload")
async def upload(request: Request):
    me = auth_svc.require_user(request)
    form = await request.form()
    f = form.get("file")
    if not f or not hasattr(f, "read"):
        raise HTTPException(400, "file 필수 (multipart)")
    name = getattr(f, "filename", "upload")
    suffix = Path(name).suffix.lower() or ".bin"
    if suffix not in (".mp4", ".mov", ".webm", ".png", ".jpg", ".jpeg"):
        raise HTTPException(400, f"지원 안 함: {suffix}")
    user_dir = _MOCKUP_UPLOADS / me["id"]
    user_dir.mkdir(parents=True, exist_ok=True)
    fid = uuid.uuid4().hex
    out = user_dir / f"{fid}{suffix}"
    data = await f.read()
    out.write_bytes(data)
    is_video = suffix in (".mp4", ".mov", ".webm")
    return {"file_id": fid, "is_video": is_video,
            "size_bytes": len(data), "filename": name}


def _resolve_upload(user_id: str, file_id: str | None) -> Path | None:
    if not file_id:
        return None
    user_dir = _MOCKUP_UPLOADS / user_id
    if not user_dir.is_dir():
        return None
    for p in user_dir.iterdir():
        if p.stem == file_id:
            return p
    return None


class AnimKeyframeReq(BaseModel):
    start_sec: float
    end_sec: float
    motion: str = "none"


class GenerateReq(BaseModel):
    mode: str
    url: str | None = None
    source_file_id: str | None = None
    bg_file_id: str | None = None
    device_id: str = "iphone-16-pro"
    aspect: str = "9:16"
    bg_color: str = "#1a1a2e"
    device_scale: float = 0.85
    viewport_w: int = 390
    viewport_h: int = 844
    duration_sec: float = 6.0
    motion: str = "none"          # 이미지 upload + motion preset (zoom-in 등)
    animation_keyframes: list[AnimKeyframeReq] | None = None
    bg_preset: str | None = None  # 배경 procedural preset
    overlay_effect: str | None = None  # VHS/glitch/grain 등 마감 효과
    # shots.so audit 추가분
    device_shadow: str | None = None
    device_shadow_opacity: float = 1.0
    device_shadow_angle: float | None = None
    device_style: str | None = None
    hide_mockup: bool = False
    radius_override: int | None = None
    tilt_x: float = 0.0
    tilt_y: float = 0.0
    scene_shapes: str | None = None


@app.post("/api/mockup/generate")
def generate(body: GenerateReq, request: Request):
    me = auth_svc.require_user(request)
    if body.mode not in ("url", "upload"):
        raise HTTPException(400, "mode = 'url' | 'upload'")
    if body.device_id not in mockup_svc.DEVICES:
        raise HTTPException(400, f"unknown device: {body.device_id}")
    if body.aspect not in mockup_svc.ASPECTS:
        raise HTTPException(400, f"unknown aspect: {body.aspect}")

    source_path: Path | None = None
    is_video = True
    if body.mode == "url":
        if not (body.url or "").startswith(("http://", "https://")):
            raise HTTPException(400, "url 필수")
    else:
        source_path = _resolve_upload(me["id"], body.source_file_id)
        if not source_path:
            raise HTTPException(400, "source_file_id 유효하지 않음")
        is_video = source_path.suffix.lower() in (".mp4", ".mov", ".webm")
    bg_path = _resolve_upload(me["id"], body.bg_file_id) if body.bg_file_id else None

    motion = body.motion if body.motion in mockup_svc.MOTION_PRESETS else "none"
    bg_preset = body.bg_preset if (body.bg_preset and body.bg_preset in mockup_svc.BG_PRESETS) else None
    overlay_effect = body.overlay_effect if (body.overlay_effect and body.overlay_effect in mockup_svc.OVERLAY_EFFECTS) else None
    device_shadow = body.device_shadow if (body.device_shadow and body.device_shadow in mockup_svc.DEVICE_SHADOWS) else None
    device_style = body.device_style if (body.device_style and body.device_style in mockup_svc.DEVICE_STYLES) else None
    keyframes: list[mockup_svc.AnimKeyframe] | None = None
    if body.animation_keyframes:
        keyframes = []
        for kf in body.animation_keyframes:
            m = kf.motion if kf.motion in mockup_svc.MOTION_PRESETS else "none"
            keyframes.append(mockup_svc.AnimKeyframe(
                start_sec=max(0.0, float(kf.start_sec)),
                end_sec=max(0.0, float(kf.end_sec)),
                motion=m,
            ))
    req = mockup_svc.GenerateRequest(
        mode=body.mode, url=body.url,
        source_path=source_path, source_is_video=is_video,
        device_id=body.device_id, aspect=body.aspect,
        bg_color=body.bg_color, bg_image_path=bg_path,
        device_scale=body.device_scale,
        viewport_w=body.viewport_w, viewport_h=body.viewport_h,
        duration_sec=body.duration_sec,
        motion=motion,
        bg_preset=bg_preset,
        overlay_effect=overlay_effect,
        device_shadow=device_shadow,
        device_shadow_opacity=max(0.0, min(1.0, body.device_shadow_opacity)),
        device_shadow_angle=body.device_shadow_angle,
        device_style=device_style,
        hide_mockup=bool(body.hide_mockup),
        radius_override=body.radius_override,
        tilt_x=max(-30.0, min(30.0, body.tilt_x)),
        tilt_y=max(-30.0, min(30.0, body.tilt_y)),
        scene_shapes=body.scene_shapes if (body.scene_shapes and body.scene_shapes in mockup_svc.SCENE_SHAPES) else None,
        animation_keyframes=keyframes,
    )
    job = mockup_svc.submit_job(
        req, user_id=me["id"],
        upload_to_supabase=_upload_to_supabase,
    )
    return {"job_id": job.id, "status": job.status}


# ── Heavy: scene sequence (멀티 화면 + xfade 트랜지션) ──────────────────

class SceneReq(BaseModel):
    """한 화면 spec. file_id 는 /api/mockup/upload 의 응답."""
    file_id: str
    duration_sec: float = 2.5
    transition: str = "cut"
    transition_ms: int = 400
    motion: str = "none"          # 이미지 화면에만 적용 (zoom-in 등)


class GenerateSequenceReq(BaseModel):
    scenes: list[SceneReq]
    device_id: str = "iphone-16-pro"
    aspect: str = "9:16"
    bg_color: str = "#1a1a2e"
    bg_file_id: str | None = None
    device_scale: float = 0.85
    bg_preset: str | None = None
    overlay_effect: str | None = None
    device_shadow: str | None = None
    device_shadow_opacity: float = 1.0
    device_shadow_angle: float | None = None
    device_style: str | None = None
    hide_mockup: bool = False
    radius_override: int | None = None
    tilt_x: float = 0.0
    tilt_y: float = 0.0
    scene_shapes: str | None = None


@app.post("/api/mockup/generate-sequence")
def generate_sequence(body: GenerateSequenceReq, request: Request):
    me = auth_svc.require_user(request)
    if not body.scenes:
        raise HTTPException(400, "scenes 비어 있음")
    if len(body.scenes) > 20:
        raise HTTPException(400, "한 시퀀스 최대 20 화면")
    if body.device_id not in mockup_svc.DEVICES:
        raise HTTPException(400, f"unknown device: {body.device_id}")
    if body.aspect not in mockup_svc.ASPECTS:
        raise HTTPException(400, f"unknown aspect: {body.aspect}")
    for sc in body.scenes:
        if sc.transition not in mockup_svc.SUPPORTED_TRANSITIONS:
            raise HTTPException(400, f"unknown transition: {sc.transition}")

    specs: list[mockup_svc.SceneSpec] = []
    for sc in body.scenes:
        p = _resolve_upload(me["id"], sc.file_id)
        if not p:
            raise HTTPException(400, f"file_id 유효하지 않음: {sc.file_id}")
        is_video = p.suffix.lower() in (".mp4", ".mov", ".webm")
        motion = sc.motion if sc.motion in mockup_svc.MOTION_PRESETS else "none"
        specs.append(mockup_svc.SceneSpec(
            file_path=p, is_video=is_video,
            duration_sec=sc.duration_sec,
            transition=sc.transition,
            transition_ms=sc.transition_ms,
            motion=motion,
        ))

    bg_path = _resolve_upload(me["id"], body.bg_file_id) if body.bg_file_id else None
    bg_preset = body.bg_preset if (body.bg_preset and body.bg_preset in mockup_svc.BG_PRESETS) else None
    overlay_effect = body.overlay_effect if (body.overlay_effect and body.overlay_effect in mockup_svc.OVERLAY_EFFECTS) else None
    device_shadow = body.device_shadow if (body.device_shadow and body.device_shadow in mockup_svc.DEVICE_SHADOWS) else None
    device_style = body.device_style if (body.device_style and body.device_style in mockup_svc.DEVICE_STYLES) else None
    req = mockup_svc.GenerateSequenceRequest(
        scenes=specs,
        device_id=body.device_id, aspect=body.aspect,
        bg_color=body.bg_color, bg_image_path=bg_path,
        device_scale=body.device_scale,
        bg_preset=bg_preset, overlay_effect=overlay_effect,
        device_shadow=device_shadow,
        device_shadow_opacity=max(0.0, min(1.0, body.device_shadow_opacity)),
        device_shadow_angle=body.device_shadow_angle,
        device_style=device_style,
        hide_mockup=bool(body.hide_mockup),
        radius_override=body.radius_override,
        tilt_x=max(-30.0, min(30.0, body.tilt_x)),
        tilt_y=max(-30.0, min(30.0, body.tilt_y)),
        scene_shapes=body.scene_shapes if (body.scene_shapes and body.scene_shapes in mockup_svc.SCENE_SHAPES) else None,
    )
    job = mockup_svc.submit_sequence_job(
        req, user_id=me["id"],
        upload_to_supabase=_upload_to_supabase,
    )
    return {"job_id": job.id, "status": job.status}


@app.get("/api/mockup/status")
def status(job_id: str, request: Request):
    auth_svc.require_user(request)
    job = mockup_svc.get_job(job_id)
    if not job:
        raise HTTPException(404, "job not found")
    return {
        "job_id": job.id, "status": job.status, "progress": job.progress,
        "output_url": job.output_url, "output_kind": job.output_kind,
        "error": job.error,
        "created_at": job.created_at, "updated_at": job.updated_at,
    }


# ── Heavy: Figma animation render ────────────────────────────────────────

class FigmaRenderReq(BaseModel):
    image_url: str
    frame_w: int
    frame_h: int
    layers: list[dict]
    duration_sec: float = 4.0
    device_id: str | None = None
    aspect: str = "9:16"
    bg_color: str = "#1a1a2e"
    device_scale: float = 0.85


@app.post("/api/figma/render-video")
def figma_render_video(body: FigmaRenderReq, request: Request):
    me = auth_svc.require_user(request)
    job = mockup_svc._create_job()

    def run():
        mockup_svc._active.acquire()
        work = Path(tempfile.mkdtemp(prefix=f"figma_render_{job.id}_"))
        try:
            job.update(status="recording", progress="베이스 이미지 다운로드")
            bg_local = work / "base.png"
            figma_render_svc.download_image(body.image_url, bg_local)

            job.update(progress="애니메이션 HTML 빌드")
            html_text = figma_render_svc.build_animation_html(
                base_image_url=bg_local.as_uri(),
                frame_w=body.frame_w, frame_h=body.frame_h,
                layers=body.layers, duration_sec=body.duration_sec,
            )
            html_path = work / "scene.html"
            html_path.write_text(html_text, encoding="utf-8")

            job.update(progress="Playwright 녹화 중")
            webm = work / "raw.webm"
            figma_render_svc.record_animation(
                html_path, body.frame_w, body.frame_h,
                body.duration_sec, webm,
            )

            if body.device_id and body.device_id in mockup_svc.DEVICES:
                job.update(status="compositing", progress="디바이스 프레임 합성")
                out = work / "out.mp4"
                mockup_svc.composite_video(
                    webm, body.device_id, body.aspect,
                    body.bg_color, None, body.device_scale, out,
                )
            else:
                job.update(status="compositing", progress="mp4 인코딩")
                out = work / "out.mp4"
                mockup_svc._run_ffmpeg([
                    "-i", str(webm),
                    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast",
                    "-crf", "20", "-movflags", "+faststart",
                    str(out),
                ], timeout=120)

            job.update(progress="업로드 중")
            data = out.read_bytes()
            public_url = _upload_to_supabase(data, "mp4", user_id=me["id"])
            job.update(status="done", output_url=public_url,
                       output_kind="mp4", progress="완료")
        except Exception as e:
            logger.exception("[figma/render] job %s failed", job.id)
            job.update(status="failed", error=str(e)[:500])
        finally:
            try: shutil.rmtree(work, ignore_errors=True)
            except: pass
            mockup_svc._active.release()

    threading.Thread(target=run, daemon=True).start()
    return {"job_id": job.id, "status": job.status}


@app.get("/api/figma/render-status")
def figma_render_status(job_id: str, request: Request):
    return status(job_id, request)
