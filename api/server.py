"""
FastAPI backend — routes only
Run: uvicorn api.server:app --port 8000
"""

from fastapi import FastAPI, HTTPException, BackgroundTasks, Query, Response, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pathlib import Path
from pydantic import BaseModel
from concurrent.futures import ThreadPoolExecutor
import time, threading, logging, os, re
import requests
from datetime import datetime, timezone

logger = logging.getLogger("uvicorn.error")

from services import supabase, pipeline, thumb, comments, script_gen
from services import secrets as secrets_svc
from services import elevenlabs as tts_svc

app = FastAPI(title="Reels Bench API")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

# API Key 인증 미들웨어 — 외부 origin은 X-API-Key 필수
from services import auth as auth_svc  # noqa: E402
from fastapi.responses import JSONResponse  # noqa: E402

_PUBLIC_API_PATHS = {
    "/api/health",
    "/api/_debug/fs",
    "/api/_debug/auth",
}
_OUR_DOMAINS = ("reels-bench.vercel.app", "localhost", "127.0.0.1")
# Vercel 프리뷰 (reels-bench-<hash>-<team>.vercel.app) 도 허용
_OUR_HOST_PREFIXES = ("reels-bench-",)
_OUR_HOST_SUFFIX = ".vercel.app"


def _is_our_origin(value: str) -> bool:
    if not value:
        return False
    if any(d in value for d in _OUR_DOMAINS):
        return True
    # 프리뷰 URL: scheme 떼고 host만 검사
    try:
        from urllib.parse import urlparse
        host = urlparse(value).hostname or ""
    except Exception:
        host = ""
    if host.endswith(_OUR_HOST_SUFFIX) and any(host.startswith(p) for p in _OUR_HOST_PREFIXES):
        return True
    return False


@app.middleware("http")
async def api_key_middleware(request, call_next):
    path = request.url.path
    # /api/* 외 (정적 자원, SPA route)는 무관
    if not path.startswith("/api/"):
        return await call_next(request)
    # 공개 endpoint
    if path in _PUBLIC_API_PATHS:
        return await call_next(request)

    # same-origin (자체 사이트 + Vercel 프리뷰) → skip
    if _is_our_origin(request.headers.get("origin", "")) or _is_our_origin(request.headers.get("referer", "")):
        return await call_next(request)

    # 외부 → API Key 요구
    api_key = (
        request.headers.get("X-API-Key")
        or request.headers.get("x-api-key")
        or request.query_params.get("api_key")
    )
    if not auth_svc.verify_key(api_key):
        return JSONResponse(
            {"error": "unauthorized",
             "detail": "Missing or invalid API key. Use X-API-Key header or ?api_key= query."},
            status_code=401,
        )

    return await call_next(request)


# ── Script Generation ──

class ScriptGenRequest(BaseModel):
    product_name: str
    pain: str = ""
    desire: str = ""
    usps: list[dict]  # 광고에 들어갈 USP 목록 (첫 항목 = 메인, 나머지 = 서브)
    reference_shortcodes: list[str]
    reference_source: str = "reels"  # 'reels' | 'youtube' — 참고 영상 플랫폼
    refine: bool = True  # False = 1차만 (draft), True = 1차+2차
    target_persona: dict | None = None  # { name, scenario, signals, tone_hint }
    # chunk.section→user_usp_id (단일) 또는 user_usp_ids[] (multi). 둘 다 지원.
    chunk_usp_override: dict[str, list[int] | int] | None = None
    chunk_meta_override: dict[str, dict] | None = None  # chunk.section→{topic, role} (분석 metadata 수정)
    skip_chunk_sections: list[str] | None = None  # 이번 생성에서 제외할 chunk.section 목록
    skip_sentence_starts: list[float] | None = None  # 이번 생성에서 제외할 sentence start time 목록 (DB 안 건드림)
    section_overrides: dict[str, dict] | None = None  # {hook|intro|cta: {shortcode, chunk}} 다른 ref로 교체
    cta_override: dict | None = None  # backward compat: section_overrides.cta와 동일
    hook_archetype_override: dict | None = None  # wizard에서 primary 변경 시 {archetype, pattern, core_word}
    session_id: str | None = None  # 진행률 polling용 식별자


@app.get("/api/script/progress/{session_id}")
def get_script_progress(session_id: str, request: Request):
    """스크립트 생성 진행률 polling. 세션별 (step, percent, message, started_at, updated_at)."""
    auth_svc.require_user(request)
    p = script_gen.get_progress(session_id)
    if not p:
        return {"session_id": session_id, "found": False}
    return {"session_id": session_id, "found": True, **p}


def _log_gen_event(profile: dict | None, req, *, success: bool, cost_usd: float | None = None,
                   sentence_count: int | None = None, duration_target_sec: int | None = None,
                   error_msg: str | None = None) -> None:
    """script_gen_events에 비동기 best-effort insert. 실패해도 무시 (table 없거나 등)."""
    try:
        SUPA = (os.getenv("SUPABASE_URL") or "").strip()
        SK = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
        if not SUPA or not SK:
            return
        payload = {
            "user_id": (profile or {}).get("id"),
            "product_name": req.product_name,
            "reference_shortcodes": req.reference_shortcodes,
            "reference_source": req.reference_source,
            "persona_name": (req.target_persona or {}).get("name"),
            "success": success,
            "cost_usd": cost_usd,
            "sentence_count": sentence_count,
            "duration_target_sec": duration_target_sec,
            "error_msg": (error_msg[:500] if error_msg else None),
        }
        supabase.get_session().post(
            f"{SUPA}/rest/v1/script_gen_events",
            headers={"apikey": SK, "Authorization": f"Bearer {SK}",
                     "Content-Type": "application/json", "Prefer": "return=minimal"},
            json=payload, timeout=5,
        )
    except Exception as e:
        logger.warning("[gen-event] log failed: %s", e)


@app.post("/api/script/generate")
def gen_script(req: ScriptGenRequest, request: Request):
    # 인증된 user면 profile 추출 (이벤트 로그용). 실패해도 generation은 진행.
    profile = None
    try:
        profile = auth_svc.require_user(request)
    except Exception:
        pass
    if not req.product_name.strip():
        raise HTTPException(400, "제품명/서비스명 필수")
    if not req.reference_shortcodes:
        raise HTTPException(400, "참고 릴스 1개 이상 필요")
    # === 진단 로그 ===
    logger.info(
        "[script/gen] product=%r refs=%s refine=%s persona=%s usps=%d (sizes=%s) pain_len=%d desire_len=%d",
        req.product_name, req.reference_shortcodes, req.refine,
        (req.target_persona or {}).get("name", "(null)"),
        len(req.usps or []),
        [len((u or {}).get("reviews") or []) for u in (req.usps or [])],
        len(req.pain or ""), len(req.desire or ""),
    )
    # === wizard 매핑 전달 디버그 ===
    logger.info(
        "[script/gen DEBUG] chunk_usp_override=%r skip_chunks=%r skip_sentences=%r section_overrides_keys=%s hook_archetype_override=%r",
        req.chunk_usp_override,
        req.skip_chunk_sections,
        req.skip_sentence_starts,
        list((req.section_overrides or {}).keys()),
        req.hook_archetype_override,
    )
    try:
        script_gen.reset_cost_meter()
        chunk_override = None
        if req.chunk_usp_override:
            chunk_override = {k: v for k, v in req.chunk_usp_override.items() if v is not None}
        meta_override = req.chunk_meta_override or None
        result = script_gen.generate(
            product_name=req.product_name,
            pain=req.pain,
            desire=req.desire,
            usps=req.usps or [],
            reference_shortcodes=req.reference_shortcodes,
            reference_source=req.reference_source if req.reference_source in ("reels", "youtube") else "reels",
            refine=req.refine,
            target_persona=req.target_persona,
            chunk_usp_override=chunk_override,
            chunk_meta_override=meta_override,
            skip_chunk_sections=req.skip_chunk_sections or None,
            skip_sentence_starts=req.skip_sentence_starts or None,
            section_overrides=req.section_overrides,
            cta_override=req.cta_override,
            hook_archetype_override=req.hook_archetype_override,
            session_id=req.session_id,
        )
        n_sentences = len(result.get("sentences") or [])
        cost = script_gen.summarize_cost()
        result["_cost"] = cost
        logger.info(
            "[script/gen] DONE sentences=%d duration=%s refined=%s cost=$%.4f (%d calls, in=%d out=%d)",
            n_sentences, result.get("duration_target_sec"), result.get("_refined", False),
            cost["total_cost_usd"], cost["total_calls"], cost["total_in_tokens"], cost["total_out_tokens"],
        )
        _log_gen_event(
            profile, req, success=True,
            cost_usd=cost.get("total_cost_usd"),
            sentence_count=n_sentences,
            duration_target_sec=result.get("duration_target_sec"),
        )
        return result
    except Exception as e:
        import traceback
        tb = traceback.format_exc()
        logger.error("[script/gen] FAILED: %s\n%s", e, tb[-2000:])
        _log_gen_event(profile, req, success=False, error_msg=str(e))
        raise HTTPException(500, f"스크립트 생성 실패: {e}")


class PersonaExtractRequest(BaseModel):
    usp: str
    reviews: list[str]
    pain_solved: str = ""
    product_id: int | None = None  # 옵션: 제공 시 캐시 lookup·write
    usp_index: int | None = None


@app.post("/api/script/personas")
def extract_personas(req: PersonaExtractRequest):
    if not req.usp.strip() or not req.reviews:
        raise HTTPException(400, "usp·reviews 필수")

    SUPA = (os.getenv("SUPABASE_URL") or "").strip()
    SK = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    _r = supabase.get_session()

    # 1. 캐시 lookup
    if req.product_id is not None and req.usp_index is not None:
        try:
            r = _r.get(
                f"{SUPA}/rest/v1/my_products?id=eq.{req.product_id}&select=usps",
                headers={"apikey": SK, "Authorization": f"Bearer {SK}"},
                timeout=5,
            )
            if r.status_code == 200 and r.json():
                usps = r.json()[0].get("usps") or []
                if 0 <= req.usp_index < len(usps):
                    cached = usps[req.usp_index].get("personas")
                    if cached and isinstance(cached, list) and len(cached) > 0:
                        # pain/desire 필드가 모든 페르소나에 있는지 검사 — 없으면 stale cache로 간주, 재추출
                        all_have_pain_desire = all(
                            (p.get("pain") and p.get("desire")) for p in cached
                        )
                        if all_have_pain_desire:
                            logger.info("[personas] CACHE HIT product=%s usp_idx=%s", req.product_id, req.usp_index)
                            return {"personas": cached, "_cached": True}
                        else:
                            logger.info("[personas] CACHE STALE (no pain/desire) — re-extract product=%s usp_idx=%s",
                                        req.product_id, req.usp_index)
        except Exception as e:
            logger.warning("personas cache lookup failed: %s", e)

    # 2. Gemini 호출
    try:
        personas = script_gen.extract_personas(req.usp, req.reviews, req.pain_solved)
    except Exception as e:
        raise HTTPException(500, f"페르소나 추출 실패: {e}")

    # 3. 캐시 write back (best-effort)
    if personas and req.product_id is not None and req.usp_index is not None:
        try:
            r = _r.get(
                f"{SUPA}/rest/v1/my_products?id=eq.{req.product_id}&select=usps",
                headers={"apikey": SK, "Authorization": f"Bearer {SK}"},
                timeout=5,
            )
            if r.status_code == 200 and r.json():
                usps = r.json()[0].get("usps") or []
                if 0 <= req.usp_index < len(usps):
                    usps[req.usp_index]["personas"] = personas
                    _r.patch(
                        f"{SUPA}/rest/v1/my_products?id=eq.{req.product_id}",
                        headers={"apikey": SK, "Authorization": f"Bearer {SK}",
                                 "Content-Type": "application/json", "Prefer": "return=minimal"},
                        json={"usps": usps},
                        timeout=5,
                    )
                    logger.info("[personas] cached %d personas product=%s usp_idx=%s", len(personas), req.product_id, req.usp_index)
        except Exception as e:
            logger.warning("personas cache write failed: %s", e)

    return {"personas": personas, "_cached": False}


class UnifiedPersonasRequest(BaseModel):
    usps: list[dict]
    product_name: str = ""


@app.post("/api/script/unified-personas")
def extract_unified_personas_ep(req: UnifiedPersonasRequest, request: Request):
    """선택된 USP들의 공통점 분석 + 모든 USP에 fit하는 통합 페르소나 추출.

    기존 /api/script/personas는 단일 USP별. 이 endpoint는 다수 USP를 동시에 보고 교집합 페르소나 도출.
    """
    auth_svc.require_user(request)
    if not req.usps:
        raise HTTPException(400, "usps 비어있음")
    try:
        result = script_gen.extract_unified_personas(req.usps, req.product_name or "")
        return result
    except Exception as e:
        logger.warning("[unified-personas] failed: %s", e)
        raise HTTPException(500, f"unified personas 추출 실패: {e}")


class UspPersonasUpdateRequest(BaseModel):
    usp_index: int
    personas: list[dict]


@app.patch("/api/my-products/{pid}/usp-personas")
def update_usp_personas(pid: int, req: UspPersonasUpdateRequest, request: Request):
    """USP의 personas 캐시를 사용자가 직접 수정/추가/삭제."""
    me = auth_svc.require_user(request)
    SUPA = (os.getenv("SUPABASE_URL") or "").strip()
    SK = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    _r = supabase.get_session()
    # ownership
    own = _r.get(
        f"{SUPA}/rest/v1/my_products?id=eq.{pid}&select=owner_id,usps",
        headers={"apikey": SK, "Authorization": f"Bearer {SK}"}, timeout=10,
    ).json()
    if not own or own[0]["owner_id"] != me["id"]:
        raise HTTPException(403, "권한 없음")
    usps = own[0].get("usps") or []
    if req.usp_index < 0 or req.usp_index >= len(usps):
        raise HTTPException(400, "usp_index 범위 초과")
    usps[req.usp_index]["personas"] = req.personas
    r = _r.patch(
        f"{SUPA}/rest/v1/my_products?id=eq.{pid}",
        headers={"apikey": SK, "Authorization": f"Bearer {SK}",
                 "Content-Type": "application/json", "Prefer": "return=minimal"},
        json={"usps": usps}, timeout=10,
    )
    if r.status_code not in (200, 204):
        raise HTTPException(r.status_code, r.text[:200])
    return {"message": "갱신 완료", "personas": req.personas}


@app.post("/api/script/rebuild-transcript-from-ocr/{shortcode}")
def rebuild_transcript_from_ocr(shortcode: str, request: Request, force: bool = Query(False)):
    """BGM-only 릴스: opus_analyses의 화면텍스트를 transcript + segments로 사용.

    감지 (?force=false): Whisper transcript와 화면 OCR 단어 Jaccard < 0.15면 BGM 오인으로 판정.
    ?force=true: 감지 무시하고 강제 교체.
    """
    auth_svc.require_user(request)
    SUPA = (os.getenv("SUPABASE_URL") or "").strip()
    SK = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    _r = supabase.get_session()
    H = {"apikey": SK, "Authorization": f"Bearer {SK}"}

    rows = _r.get(
        f"{SUPA}/rest/v1/opus_analyses?shortcode=eq.{shortcode}&select=analysis&limit=1",
        headers=H, timeout=10,
    ).json()
    if not rows:
        raise HTTPException(404, "opus_analyses 없음 (분석 먼저)")
    ocr_pairs = script_gen.parse_frame_ocr_from_analysis(rows[0].get("analysis") or "")
    if not ocr_pairs:
        raise HTTPException(400, "화면 텍스트(OCR) 없음 — BGM-only 아닐 수 있음")

    tr_rows = _r.get(
        f"{SUPA}/rest/v1/reels_transcripts?shortcode=eq.{shortcode}&select=transcript&limit=1",
        headers=H, timeout=10,
    ).json()
    cur_transcript = (tr_rows[0].get("transcript") if tr_rows else "") or ""

    is_bgm = script_gen.detect_bgm_only_reel(cur_transcript, ocr_pairs)
    if not is_bgm and not force:
        return {
            "shortcode": shortcode, "skipped": True,
            "reason": "transcript가 OCR과 충분히 일치 — BGM 오인 아님 (force=true로 강제 가능)",
            "jaccard": script_gen._word_jaccard(cur_transcript, " ".join(t for _, t in ocr_pairs)),
        }

    meta_rows = _r.get(
        f"{SUPA}/rest/v1/reels_metadata?shortcode=eq.{shortcode}&select=video_duration&limit=1",
        headers=H, timeout=10,
    ).json()
    video_dur = float((meta_rows[0].get("video_duration") if meta_rows else 0) or 0)

    new_transcript, new_segments = script_gen.build_transcript_from_ocr(ocr_pairs, video_dur)
    if not new_segments:
        raise HTTPException(500, "OCR transcript 빌드 실패")

    upsert_url = f"{SUPA}/rest/v1/reels_transcripts?on_conflict=shortcode"
    _r.post(upsert_url, headers={
        **H, "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates,return=minimal",
    }, json={
        "shortcode": shortcode, "transcript": new_transcript,
        "language": "ko", "segments": new_segments,
    }, timeout=15)

    cached = pipeline.extra_cache.get(shortcode)
    if isinstance(cached, dict):
        cached["sentences"] = new_segments
        pipeline.extra_cache[shortcode] = cached

    return {
        "shortcode": shortcode, "replaced": True,
        "old_preview": cur_transcript[:120],
        "new_preview": new_transcript[:120],
        "segments_count": len(new_segments),
        "next_step": "classify-sentences 호출해 섹션 라벨 부여",
    }


class BodyBoundaries(BaseModel):
    splits: list[float]  # body 영역 내부의 분할 시각들. 예: [11, 15, 19, 23] → body_1~5


@app.post("/api/script/set-body-boundaries/{shortcode}")
def set_body_boundaries(shortcode: str, req: BodyBoundaries, request: Request):
    """body 분절 boundary 수동 지정. body 영역 내부 split 시각 list로 body_1~N 재라벨.

    예: splits=[11, 15, 19, 23]일 때
    - body_1: body 시작~11s
    - body_2: 11~15s
    - body_3: 15~19s
    - body_4: 19~23s
    - body_5: 23~body 끝
    """
    auth_svc.require_user(request)
    SUPA = (os.getenv("SUPABASE_URL") or "").strip()
    SK = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    _r = supabase.get_session()
    H = {"apikey": SK, "Authorization": f"Bearer {SK}"}

    tr_rows = _r.get(
        f"{SUPA}/rest/v1/reels_transcripts?shortcode=eq.{shortcode}&select=transcript,segments&limit=1",
        headers=H, timeout=10,
    ).json()
    if not tr_rows or not tr_rows[0].get("segments"):
        raise HTTPException(404, "transcript/segments 없음")
    sentences = tr_rows[0]["segments"]
    transcript = tr_rows[0].get("transcript", "")

    # 현재 body 영역의 시작·끝 (sentence section 기반)
    body_sents = [s for s in sentences if (s.get("section") or "").lower().startswith("body")]
    if not body_sents:
        raise HTTPException(400, "body 라벨된 sentence 없음")
    body_start = min(float(s.get("start", 0) or 0) for s in body_sents)
    body_end = max(float(s.get("end", 0) or 0) for s in body_sents)

    splits = sorted([s for s in req.splits if body_start < s < body_end])
    boundaries = [body_start] + splits + [body_end + 0.001]

    # 각 body sentence를 어느 body_N에 속하는지 시간 기반으로 매핑
    new_sentences = []
    for s in sentences:
        sec = (s.get("section") or "").lower()
        if not sec.startswith("body"):
            new_sentences.append(s); continue
        st = float(s.get("start", 0) or 0)
        en = float(s.get("end", st) or st)
        mid = (st + en) / 2
        new_label = "body_1"
        for i in range(len(boundaries) - 1):
            if boundaries[i] <= mid < boundaries[i+1]:
                new_label = f"body_{i+1}"; break
        new_sent = dict(s)
        new_sent["section"] = new_label
        new_sentences.append(new_sent)

    # 저장
    upsert_url = f"{SUPA}/rest/v1/reels_transcripts?on_conflict=shortcode"
    _r.post(upsert_url, headers={
        **H, "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates,return=minimal",
    }, json={
        "shortcode": shortcode, "transcript": transcript,
        "language": "ko", "segments": new_sentences,
    }, timeout=15)

    cached = pipeline.extra_cache.get(shortcode)
    if isinstance(cached, dict):
        cached["sentences"] = new_sentences
        pipeline.extra_cache[shortcode] = cached

    # 새 라벨 분포
    from collections import Counter
    sec_counts = Counter((s.get("section") or "?") for s in new_sentences)
    return {
        "shortcode": shortcode,
        "body_count": len(boundaries) - 1,
        "boundaries": [round(b, 1) for b in boundaries],
        "sections": dict(sec_counts),
        "next_step": "reanalyze-usp-layout 호출해 USP 매핑 갱신",
    }


@app.post("/api/script/reanalyze-structure/{shortcode}")
def reanalyze_structure_for_reel(shortcode: str, request: Request):
    """script_structure를 transcript 기반으로 재생성. 이후 usp_layout + body_chunks도 자동 재분석."""
    auth_svc.require_user(request)
    SUPA = (os.getenv("SUPABASE_URL") or "").strip()
    SK = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    _r = supabase.get_session()
    H = {"apikey": SK, "Authorization": f"Bearer {SK}"}

    tr_rows = _r.get(
        f"{SUPA}/rest/v1/reels_transcripts?shortcode=eq.{shortcode}&select=transcript&limit=1",
        headers=H, timeout=10,
    ).json()
    if not tr_rows or not tr_rows[0].get("transcript"):
        raise HTTPException(404, "transcript 없음")
    transcript = tr_rows[0]["transcript"]

    meta_rows = _r.get(
        f"{SUPA}/rest/v1/reels_metadata?shortcode=eq.{shortcode}&select=caption_text&limit=1",
        headers=H, timeout=10,
    ).json()
    caption = (meta_rows[0].get("caption_text") if meta_rows else "") or ""

    from services import gemini as _g
    structure = _g.analyze_script_structure(transcript, caption)
    if not structure:
        raise HTTPException(500, "structure 재생성 실패")

    # 기존 overall 보존 (usp_layout, section_roles 등) 후 새 분석으로 덮어쓰기
    cur_rows = _r.get(
        f"{SUPA}/rest/v1/reels_script_structure?shortcode=eq.{shortcode}&select=overall&limit=1",
        headers=H, timeout=10,
    ).json()
    cur_overall = (cur_rows[0].get("overall") if cur_rows else {}) or {}
    new_overall = structure.get("overall") or {}
    # 보존: 누적된 분석 필드들 (usp_layout 등은 제거됨)
    for k in ("section_roles", "body_chunks", "section_chunks", "sp_sentences"):
        if cur_overall.get(k) is not None and not new_overall.get(k):
            new_overall[k] = cur_overall[k]

    _r.patch(
        f"{SUPA}/rest/v1/reels_script_structure?shortcode=eq.{shortcode}",
        headers={**H, "Prefer": "return=minimal"},
        json={
            "hook": structure.get("hook"),
            "intro": structure.get("intro"),
            "body": structure.get("body"),
            "cta": structure.get("cta"),
            "overall": new_overall,
        }, timeout=15,
    )
    # 캐시 무효화 (extra_cache는 dict-like — assign으로 갱신)
    cached = pipeline.extra_cache.get(shortcode)
    if isinstance(cached, dict):
        cached["script_structure"] = {**(cached.get("script_structure") or {}), **structure, "overall": new_overall}
        pipeline.extra_cache[shortcode] = cached
    return {
        "shortcode": shortcode,
        "hook_text": (structure.get("hook") or {}).get("text", ""),
        "intro_text": (structure.get("intro") or {}).get("text", ""),
        "body_text": (structure.get("body") or {}).get("text", ""),
        "cta_text": (structure.get("cta") or {}).get("text", ""),
        "next_step": "classify-sentences + reanalyze-usp-layout 호출 권장 (선택)",
    }


@app.post("/api/script/analyze-section-chunks/{shortcode}")
def analyze_section_chunks_for_reel(shortcode: str, request: Request, source: str = "reels"):
    """모든 섹션(hook/intro/body_N/cta) chunk별 분석. overall.section_chunks에 저장 (+ body_chunks 호환 alias).

    Plan-A: chunks 결과를 정본으로 sentence.section + usp.appears_in 자동 동기화.
    source: 'reels' | 'youtube'
    """
    auth_svc.require_user(request)
    src = source if source in ("reels", "youtube") else "reels"
    ref = script_gen.fetch_reference(shortcode, source=src)
    if not ref:
        raise HTTPException(404, "참고 영상 없음")
    sentences = list(ref.get("sentences") or [])
    if not any(s.get("section") for s in sentences):
        raise HTTPException(400, "section 라벨된 sentences 필요")
    chunks = script_gen.analyze_section_chunks(ref)
    if not chunks:
        raise HTTPException(500, "section chunk 분석 실패")
    SUPA = (os.getenv("SUPABASE_URL") or "").strip()
    SK = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    _r = supabase.get_session()
    H = {"apikey": SK, "Authorization": f"Bearer {SK}"}
    tbl = script_gen._TABLES_BY_SOURCE[src]
    structure_tbl = tbl["structure"]
    rows = _r.get(
        f"{SUPA}/rest/v1/{structure_tbl}?shortcode=eq.{shortcode}&select=overall&limit=1",
        headers=H, timeout=10,
    ).json()
    if not rows:
        raise HTTPException(404, "script_structure 없음")
    overall = rows[0].get("overall") or {}
    overall["section_chunks"] = chunks
    overall["body_chunks"] = [
        {**c, "body_n": c["section"]} for c in chunks if c.get("section", "").startswith("body")
    ]

    # ⭐ chunks를 정본으로 sentence.section 자동 동기화 (usp_layout 제거됨)
    script_gen.chunks_as_source_of_truth(chunks, sentences, None)

    _r.patch(
        f"{SUPA}/rest/v1/{structure_tbl}?shortcode=eq.{shortcode}",
        headers={**H, "Prefer": "return=minimal"},
        json={"overall": overall}, timeout=15,
    )
    # sentences DB 갱신
    try:
        if src == "reels":
            transcript_text = " ".join((s.get("text") or "").strip() for s in sentences if (s.get("text") or "").strip())
            _r.post(
                f"{SUPA}/rest/v1/reels_transcripts?on_conflict=shortcode",
                headers={**H, "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates,return=minimal"},
                json={"shortcode": shortcode, "transcript": transcript_text, "language": "ko", "segments": sentences},
                timeout=15,
            )
        else:
            # youtube: pro_audio.sentences 갱신
            pa_tbl = tbl["pro_audio"]
            pa_rows = _r.get(
                f"{SUPA}/rest/v1/{pa_tbl}?shortcode=eq.{shortcode}&select=pro_audio&limit=1",
                headers=H, timeout=10,
            ).json()
            pro = (pa_rows[0].get("pro_audio") if pa_rows else {}) or {}
            pro["sentences"] = sentences
            _r.patch(
                f"{SUPA}/rest/v1/{pa_tbl}?shortcode=eq.{shortcode}",
                headers={**H, "Content-Type": "application/json", "Prefer": "return=minimal"},
                json={"pro_audio": pro}, timeout=15,
            )
    except Exception as e:
        logger.warning("[analyze-section-chunks] sentences sync failed: %s", e)
    return {"shortcode": shortcode, "source": src, "chunks": chunks, "count": len(chunks)}


class PreviewMappingRequest(BaseModel):
    product_id: int
    source: str = "reels"  # 'reels' | 'youtube'


class UpdateSectionChunksRequest(BaseModel):
    chunks: list[dict]


@app.patch("/api/script/section-chunks/{shortcode}")
def update_section_chunks(shortcode: str, body: UpdateSectionChunksRequest, request: Request, source: str = "reels"):
    """ref의 section_chunks 분석 결과를 직접 수정 (분석이 잘못된 경우 보정용)."""
    auth_svc.require_user(request)
    src = source if source in ("reels", "youtube") else "reels"
    SUPA = (os.getenv("SUPABASE_URL") or "").strip()
    SK = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    _r = supabase.get_session()
    H = {"apikey": SK, "Authorization": f"Bearer {SK}"}
    tbl = script_gen._TABLES_BY_SOURCE[src]
    structure_tbl = tbl["structure"]

    rows = _r.get(
        f"{SUPA}/rest/v1/{structure_tbl}?shortcode=eq.{shortcode}&select=overall&limit=1",
        headers=H, timeout=10,
    ).json()
    if not rows:
        raise HTTPException(404, "script_structure 없음")
    overall = rows[0].get("overall") or {}
    overall["section_chunks"] = body.chunks
    overall["body_chunks"] = [
        {**c, "body_n": c.get("section")} for c in body.chunks if (c.get("section") or "").startswith("body")
    ]
    r = _r.patch(
        f"{SUPA}/rest/v1/{structure_tbl}?shortcode=eq.{shortcode}",
        headers={**H, "Prefer": "return=minimal"},
        json={"overall": overall}, timeout=15,
    )
    if r.status_code not in (200, 204):
        raise HTTPException(r.status_code, r.text[:200])

    # ⭐ chunks 변경 후 sentences.section 동기화 (chunks 정본화)
    try:
        if src == "reels":
            trans_rows = _r.get(
                f"{SUPA}/rest/v1/reels_transcripts?shortcode=eq.{shortcode}&select=transcript,segments&limit=1",
                headers=H, timeout=10,
            ).json()
            if trans_rows:
                sentences = list(trans_rows[0].get("segments") or [])
                script_gen.chunks_as_source_of_truth(body.chunks, sentences, None)
                transcript_text = " ".join((s.get("text") or "").strip() for s in sentences if (s.get("text") or "").strip())
                _r.post(
                    f"{SUPA}/rest/v1/reels_transcripts?on_conflict=shortcode",
                    headers={**H, "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates,return=minimal"},
                    json={"shortcode": shortcode, "transcript": transcript_text, "language": "ko", "segments": sentences},
                    timeout=15,
                )
                logger.info("[update-section-chunks] reels sentences synced (%d)", len(sentences))
        else:
            pa_tbl = tbl["pro_audio"]
            pa_rows = _r.get(
                f"{SUPA}/rest/v1/{pa_tbl}?shortcode=eq.{shortcode}&select=pro_audio&limit=1",
                headers=H, timeout=10,
            ).json()
            if pa_rows:
                pro = pa_rows[0].get("pro_audio") or {}
                sentences = list(pro.get("sentences") or pro.get("tts_script") or [])
                script_gen.chunks_as_source_of_truth(body.chunks, sentences, None)
                pro["sentences"] = sentences
                _r.patch(
                    f"{SUPA}/rest/v1/{pa_tbl}?shortcode=eq.{shortcode}",
                    headers={**H, "Content-Type": "application/json", "Prefer": "return=minimal"},
                    json={"pro_audio": pro}, timeout=15,
                )
                logger.info("[update-section-chunks] youtube sentences synced (%d)", len(sentences))
    except Exception as e:
        logger.warning("[update-section-chunks] sentences sync failed: %s", e)

    return {"shortcode": shortcode, "source": src, "count": len(body.chunks)}


@app.patch("/api/script/hook-archetype/{shortcode}")
def update_hook_archetype(shortcode: str, body: dict, request: Request, source: str = "reels"):
    """Hook chunk의 archetype 메타데이터 수정 (분석이 잘못 분류한 경우).

    body: {"archetype": "curiosity_teaser" | ..., "pattern": "...", "core_word": "...", "reasoning": "..."}
    archetype만 보내면 pattern/core_word는 보존.
    """
    auth_svc.require_user(request)
    src = source if source in ("reels", "youtube") else "reels"
    SUPA = (os.getenv("SUPABASE_URL") or "").strip()
    SK = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    _r = supabase.get_session()
    H = {"apikey": SK, "Authorization": f"Bearer {SK}"}
    structure_tbl = script_gen._TABLES_BY_SOURCE[src]["structure"]

    new_arch = (body or {}).get("archetype")
    valid_keys = set(script_gen.HOOK_ARCHETYPES.keys())
    if not new_arch or new_arch not in valid_keys:
        raise HTTPException(400, f"archetype은 다음 중 하나: {sorted(valid_keys)}")

    rows = _r.get(
        f"{SUPA}/rest/v1/{structure_tbl}?shortcode=eq.{shortcode}&select=overall&limit=1",
        headers=H, timeout=10,
    ).json()
    if not rows:
        raise HTTPException(404, "script_structure 없음")
    overall = rows[0].get("overall") or {}
    chunks = list(overall.get("section_chunks") or [])
    hook_idx = next((i for i, c in enumerate(chunks) if (c.get("section") or "").lower() == "hook"), -1)
    if hook_idx < 0:
        raise HTTPException(404, "hook chunk 없음")
    prev = chunks[hook_idx].get("archetype") or {}
    new_dict = {
        "archetype": new_arch,
        "pattern": (body.get("pattern") if "pattern" in body else prev.get("pattern")) or "",
        "core_word": (body.get("core_word") if "core_word" in body else prev.get("core_word")) or "",
        "reasoning": (body.get("reasoning") if "reasoning" in body else prev.get("reasoning")) or "사용자 수동 수정",
    }
    chunks[hook_idx] = {**chunks[hook_idx], "archetype": new_dict}
    overall["section_chunks"] = chunks

    r = _r.patch(
        f"{SUPA}/rest/v1/{structure_tbl}?shortcode=eq.{shortcode}",
        headers={**H, "Prefer": "return=minimal"},
        json={"overall": overall}, timeout=15,
    )
    if r.status_code not in (200, 204):
        raise HTTPException(r.status_code, r.text[:200])
    return {"shortcode": shortcode, "source": src, "archetype": new_dict}


@app.post("/api/usp/suggest-description")
def suggest_usp_description(body: dict, request: Request):
    """USP 이름 + (선택) 리뷰 → LLM이 description 자동 생성.

    body: {product_name: str, usp_name: str, reviews?: [str]}
    Returns: {description: str}

    description 형식: "문제: ...\n해결: ...\n혜택: ...\n핵심 명사: ..."
    writer가 명사 화이트리스트로 활용 가능하도록 구체 명사 풍부하게.
    """
    auth_svc.require_user(request)
    product_name = (body.get("product_name") or "").strip()
    usp_name = (body.get("usp_name") or "").strip()
    reviews = body.get("reviews") or []
    if not usp_name:
        raise HTTPException(400, "usp_name 필수")
    reviews_block = ""
    if isinstance(reviews, list) and reviews:
        joined = "\n".join(f"- {r}" for r in reviews[:8] if isinstance(r, str) and r.strip())
        if joined:
            reviews_block = f"\n## 사용자 리뷰 (어휘 source 참고)\n{joined}\n"
    prompt = f"""당신은 소비자 인사이트 분석가입니다. USP 정보로 광고 작가가 활용할 **소비자 언어 description**을 생성하세요.

## 입력
- product: {product_name or '(미명시)'}
- USP: {usp_name}
{reviews_block}

## 핵심 원칙 — 소비자 언어 (판매자 언어 X)
- ✅ **소비자**: "잘 때 답답해서 자꾸 깸", "벗고 자면 신경 쓰여", "편해서 푹 자요", "어깨 안 눌려"
- ❌ **판매자**: "고급 패드 내장", "프리미엄 소재", "전문 디자인", "특허 기술", "혁신적 솔루션"
- 1인칭 시점 ("나는/저는") + 구체 행동 ("자다가/누우면/만져봤더니") + 감정 어휘 ("답답/편안/든든")
- spec/기능명 X — 사용자가 평소에 쓰는 일상 단어만

## 작업 (4가지)

1. **문제**: 소비자가 일상에서 겪는 불편 (1~2문장, 80자 이내)
   - 시점·상황: "잘 때", "퇴근하면", "외출 전에"
   - 행동: "뒤척이다", "벗어버린다", "맨날 신경 쓴다"
   - 감정: "짜증나", "답답해", "신경 쓰여"

2. **해결**: 이 제품을 쓰면 소비자가 어떻게 달라지는지 (1~2문장, 80자 이내)
   - 기능 이름 X — **사용자가 느끼는 변화**만 ("그냥 입었더니 안 답답해", "굴러봐도 안 흘러내려")
   - 행동 결과 중심: "이건 안 풀려요", "잘 때도 신경 안 써져요"

3. **혜택**: 사용 후 일상의 변화·감정 (1~2문장, 80자 이내)
   - 결과 scene: "푹 자고 일어나는 게 달라요", "외출 직전 꺼내 입어도 OK"
   - 감정: "편하다", "신경 안 쓴다", "든든하다"

4. **핵심 명사 (카테고리별 분리)**: writer가 어떤 톤의 문장에 어떤 단어 쓸지 명확히 — **3 그룹으로 분리**
   - **문제 측**: pain·friction 어휘 (답답, 자국, 신경 쓰여, 뒤척)
   - **해결 측**: action·mechanism 어휘 (그냥 입어, 안 답답, 굴러봐도 안 흘러)
   - **혜택 측**: outcome·emotion 어휘 (푹 자, 아침 다르다, 편안, 든든)
   - ⚠️ **카테고리 섞지 말 것** — "불안(문제)+최저가(해결)" 한 문장 들어가면 의미 충돌

5. **앱이 하는 것 / 앱이 안 하는 것 (Capability Fence)** ⭐⭐⭐: writer가 false claim 안 만들도록 boundary 명시
   - **앱이 하는 것** (capability_in): 실제 제품·서비스가 제공하는 기능·동작 (콤마 구분)
     - 예 (멤버십): "가격 검색, 비교, 최저가 알림, 가격 추적"
     - 예 (잠옷): "노카라 디자인, 모달 안감, 셔링 라인"
   - **앱이 안 하는 것** (capability_out): description에 어휘로 등장하지만 실제로는 안 하는 것 (콤마 구분)
     - 예 (멤버십): "실제 예약 (제휴 사이트 이동), 결제 (외부 처리)"
     - 예 (잠옷): "수선·교환 직접 처리 X"
   - ⚠️ "예약"이 description에 있어도 외부 사이트로 이동하면 capability_out에 명시 → writer가 "예약까지 한 번에" 같은 false functionality claim 회피

## 예 (USP="노브라잠옷")
문제: 잘 때 브라 자국 신경 쓰이고, 벗고 자면 가슴 처지는 거 느껴서 맨날 어쩌지 싶어
해결: 그냥 입고 자도 안 답답하고, 누워서 굴러봐도 안 흘러내려요
혜택: 자다가 깨도 신경 안 써지고, 푹 자고 아침 일어나는 게 달라요
핵심 명사:
- 문제 측: 답답, 자국, 처짐, 뒤척, 신경 쓰여
- 해결 측: 그냥 입어, 안 흘러, 굴러봐도, 누워도
- 혜택 측: 푹 자다, 아침 달라, 편안, 든든

## 출력 JSON
{{
  "문제": "...",
  "해결": "...",
  "혜택": "...",
  "핵심_명사_문제": "콤마 구분 (5-8개)",
  "핵심_명사_해결": "콤마 구분 (5-8개)",
  "핵심_명사_혜택": "콤마 구분 (3-6개)",
  "앱이_하는_것": "콤마 구분 (실제 제품 capability)",
  "앱이_안_하는_것": "콤마 구분 (description에 어휘 등장하지만 실제 안 하는 것)"
}}

JSON만. 설명 X.
"""
    schema = {
        "type": "object",
        "properties": {
            "문제": {"type": "string"},
            "해결": {"type": "string"},
            "혜택": {"type": "string"},
            "핵심_명사_문제": {"type": "string"},
            "핵심_명사_해결": {"type": "string"},
            "핵심_명사_혜택": {"type": "string"},
            "앱이_하는_것": {"type": "string"},
            "앱이_안_하는_것": {"type": "string"},
        },
        "required": ["문제", "해결", "혜택"],
    }
    try:
        result = script_gen.call_gemini(prompt, model="gemini-3.1-flash-lite-preview", max_tokens=4096, response_schema=schema)
        if isinstance(result, list) and result:
            result = result[0]
        if not isinstance(result, dict):
            raise RuntimeError("LLM 응답 형식 오류")
        problem = (result.get("문제") or "").strip()
        solution = (result.get("해결") or "").strip()
        benefit = (result.get("혜택") or "").strip()
        nouns_prob = (result.get("핵심_명사_문제") or "").strip()
        nouns_sol = (result.get("핵심_명사_해결") or "").strip()
        nouns_ben = (result.get("핵심_명사_혜택") or "").strip()
        description_lines = []
        if problem:
            description_lines.append(f"문제: {problem}")
        if solution:
            description_lines.append(f"해결: {solution}")
        if benefit:
            description_lines.append(f"혜택: {benefit}")
        if nouns_prob or nouns_sol or nouns_ben:
            description_lines.append("핵심 명사:")
            if nouns_prob:
                description_lines.append(f"- 문제 측: {nouns_prob}")
            if nouns_sol:
                description_lines.append(f"- 해결 측: {nouns_sol}")
            if nouns_ben:
                description_lines.append(f"- 혜택 측: {nouns_ben}")
        # capability fence
        cap_in = (result.get("앱이_하는_것") or "").strip()
        cap_out = (result.get("앱이_안_하는_것") or "").strip()
        if cap_in:
            description_lines.append(f"앱이 하는 것: {cap_in}")
        if cap_out:
            description_lines.append(f"앱이 안 하는 것: {cap_out}")
        description = "\n".join(description_lines)
        return {"description": description, "parts": result}
    except Exception as e:
        logger.warning("[suggest_usp_description] failed: %s", e)
        raise HTTPException(500, f"description 생성 실패: {e}")


@app.post("/api/usp/generate-reviews")
def generate_usp_reviews(body: dict, request: Request):
    """USP 이름 + description → LLM이 소비자 언어 리뷰 N개 생성.

    body: {product_name, usp_name, usp_description?, existing_reviews?: [str], count?: int (default 5)}
    Returns: {reviews: [str]}
    """
    auth_svc.require_user(request)
    product_name = (body.get("product_name") or "").strip()
    usp_name = (body.get("usp_name") or "").strip()
    usp_description = (body.get("usp_description") or "").strip()
    existing = body.get("existing_reviews") or []
    count = max(1, min(int(body.get("count") or 5), 10))
    if not usp_name:
        raise HTTPException(400, "usp_name 필수")

    existing_block = ""
    if isinstance(existing, list) and existing:
        joined = "\n".join(f"- {r}" for r in existing[:10] if isinstance(r, str) and r.strip())
        if joined:
            existing_block = f"\n## 이미 있는 리뷰 (중복 X — 다른 angle로)\n{joined}\n"

    desc_block = ""
    if usp_description:
        desc_block = f"\n## USP description\n{usp_description}\n"

    prompt = f"""당신은 한국 소비자 리뷰 작가입니다. 광고 작가가 어휘 source로 쓸 **진짜 소비자가 쓴 것 같은 리뷰** {count}개를 작성하세요.

## 입력
- product: {product_name or '(미명시)'}
- USP: {usp_name}
{desc_block}{existing_block}

## 핵심 원칙 — 진짜 소비자 톤
- ✅ **소비자 1인칭**: "저는 ~", "처음에 ~", "사실 ~", "써보니까 ~", "이거 ~"
- ✅ **구체 상황·행동**: "잘 때 ~", "출근하면서 ~", "고민하다가 ~", "몇 번 ~"
- ✅ **감정 어휘**: 답답, 짜증, 신경 쓰여, 편하다, 든든하다, 깜짝, 진짜
- ✅ **자연 호흡**: "~인 거 같아요", "~더라구요", "~라서 좋아요", "~네요"
- ❌ **판매자 톤 금지**: "프리미엄 ~", "고급 ~", "혁신적 ~", "최고의 ~"
- ❌ **광고 카피 금지**: "결국 인생템", "강추!", "10점 만점에 10점"

## angle 다양화 (필수)
{count}개 리뷰는 **다른 사용 시나리오·다른 pain·다른 측면**으로:
- 리뷰 A: 처음 시도 + 만족
- 리뷰 B: 이전 실패 + 비교
- 리뷰 C: 구체 상황 + 결과 감정
- 리뷰 D: 의외의 장점
- 리뷰 E: 디테일 묘사
→ 5개 리뷰가 같은 명사·동사로 시작하거나 같은 키워드 반복하면 무효

## 길이
- 각 리뷰 30~80자 (한국 인스타·블로그 리뷰 평균)
- 너무 짧지 않게 (15자 미만 X), 너무 길지 않게 (100자 초과 X)

## 출력 JSON
{{
  "reviews": [
    "리뷰 1 ...",
    "리뷰 2 ...",
    "리뷰 3 ..."
  ]
}}

JSON만. 설명·앞말·줄번호 X.
"""
    schema = {
        "type": "object",
        "properties": {
            "reviews": {
                "type": "array",
                "items": {"type": "string"},
                "minItems": count,
            },
        },
        "required": ["reviews"],
    }
    try:
        result = script_gen.call_gemini(prompt, model="gemini-3.1-flash-lite-preview", max_tokens=4096, response_schema=schema)
        if isinstance(result, list) and result:
            result = result[0]
        if not isinstance(result, dict):
            raise RuntimeError("LLM 응답 형식 오류")
        raw = result.get("reviews") or []
        # 정제: 빈 문자열 제거, 너무 짧은 거 제거, 중복 제거
        seen: set[str] = set()
        cleaned: list[str] = []
        for r in raw:
            if not isinstance(r, str):
                continue
            t = r.strip().strip('"').strip("'").strip()
            if len(t) < 8 or t in seen:
                continue
            seen.add(t)
            cleaned.append(t)
        if not cleaned:
            raise RuntimeError("리뷰 0개")
        return {"reviews": cleaned[:count]}
    except Exception as e:
        logger.warning("[generate_usp_reviews] failed: %s", e)
        raise HTTPException(500, f"리뷰 생성 실패: {e}")


@app.post("/api/script/preview-mapping/{shortcode}")
def preview_mapping(shortcode: str, body: PreviewMappingRequest, request: Request):
    """대본 생성 wizard용 — chunk-level USP 매핑 미리보기.

    각 chunk 단위로 우리 USP를 매칭. usp_layout은 더 이상 사용 안 함 (chunks가 정본).
    """
    auth_svc.require_user(request)
    SUPA = (os.getenv("SUPABASE_URL") or "").strip()
    SK = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    _r = supabase.get_session()
    H = {"apikey": SK, "Authorization": f"Bearer {SK}"}

    import time as _t
    t_start = _t.time()
    src = body.source if body.source in ("reels", "youtube") else "reels"
    # 1. ref + section_chunks 로드
    ref = script_gen.fetch_reference(shortcode, source=src)
    if not ref:
        raise HTTPException(404, "참고 영상 없음")
    overall = ((ref.get("structure") or {}).get("overall") or {})
    section_chunks = overall.get("section_chunks") or []
    chunks_cached = bool(section_chunks)
    if not section_chunks:
        t_chunks = _t.time()
        section_chunks = script_gen.analyze_section_chunks(ref) or []
        logger.info("[preview-mapping] %s analyze_section_chunks (uncached) %.1fs", shortcode, _t.time() - t_chunks)
    if not section_chunks:
        raise HTTPException(400, "section_chunks 없음 — 먼저 분석 필요")
    logger.info("[preview-mapping] %s stage1_load %.1fs (chunks_cached=%s)", shortcode, _t.time() - t_start, chunks_cached)

    # 2. product USPs 로드
    rows = _r.get(
        f"{SUPA}/rest/v1/my_products?id=eq.{body.product_id}&select=id,name,usps,persona",
        headers=H, timeout=10,
    ).json()
    if not rows:
        raise HTTPException(404, f"product {body.product_id} 없음")
    product = rows[0]
    user_usps = product.get("usps") or []
    if not user_usps:
        raise HTTPException(400, "product에 USP 없음")

    # 3. pre-planner + ref_desire_arc 병렬 호출
    prompt = script_gen._build_pre_planner_prompt(user_usps, section_chunks)

    def _call_pre_planner():
        # max_tokens=8192 + responseSchema 강제 → user_usp_ids[] 형식 보장
        r = script_gen.call_gemini(
            prompt, model="gemini-3-flash-preview", max_tokens=8192,
            response_schema=script_gen.PRE_PLANNER_SCHEMA,
        )
        return r[0] if isinstance(r, list) and r else r

    def _call_ref_desires():
        try:
            # ⭐ product 도메인 anchor 전달 — ref의 emotional frame을 product 도메인 사용자로 transform
            return script_gen.analyze_ref_desire_arc(
                [], section_chunks,
                product_name=product.get("name", ""),
                product_usps=user_usps,
            )
        except Exception as e:
            logger.warning("[preview-mapping] ref_desires 추출 실패: %s", e)
            return []

    t_par = _t.time()
    with ThreadPoolExecutor(max_workers=2) as ex:
        f_pp = ex.submit(_call_pre_planner)
        f_rd = ex.submit(_call_ref_desires)
        try:
            result = f_pp.result()
        except Exception as e:
            import traceback
            tb = traceback.format_exc()[-500:]
            # JSON 파싱 실패/truncation → 빈 매핑으로 graceful fallback (wizard에서 사용자가 수동 매핑 가능)
            logger.warning("[preview-mapping] pre-planner 실패 — 빈 매핑으로 진행: %s\n%s", e, tb)
            result = {}
        ref_desires = f_rd.result() or []
    logger.info("[preview-mapping] %s stage2_parallel(pp+rd) %.1fs total %.1fs",
                shortcode, _t.time() - t_par, _t.time() - t_start)

    # 4. chunk-level mapping 보강
    if not isinstance(result, dict):
        logger.warning("[preview-mapping] pre-planner result 비정상 타입: %s — 빈 매핑으로 진행", type(result).__name__)
        result = {}
    raw_map = result.get("chunk_mapping") or []
    # chunk.section → chunk meta (role, usp_ids 추가 노출용)
    chunk_meta_by_sec = {c.get("section", ""): c for c in section_chunks}
    mapping_full: list[dict] = []
    for m in raw_map:
        sec = m.get("chunk_section")
        if not isinstance(sec, str):
            continue
        # multi: user_usp_ids[] 우선, 없으면 single user_usp_id를 list로 승격 (backward compat)
        ids_raw = m.get("user_usp_ids")
        if not isinstance(ids_raw, list):
            single = m.get("user_usp_id")
            ids_raw = [single] if isinstance(single, int) else []
        resolved_ids: list[int] = []
        for u in ids_raw:
            if isinstance(u, int) and 1 <= u <= len(user_usps) and u not in resolved_ids:
                resolved_ids.append(u)
        confidence = (m.get("confidence") or "").strip().lower()
        if confidence not in ("strong", "loose", "none"):
            confidence = "none" if not resolved_ids else "strong"
        primary = resolved_ids[0] if resolved_ids else None
        chunk_meta = chunk_meta_by_sec.get(sec, {})
        mapping_full.append({
            "chunk_section": sec,
            "user_usp_ids": resolved_ids,
            "user_usp_names": [user_usps[i - 1].get("usp", "") for i in resolved_ids],
            "user_usp_id": primary,  # backward compat (primary)
            "user_usp_name": user_usps[primary - 1].get("usp", "") if primary else None,
            "chunk_role": chunk_meta.get("role", ""),
            "chunk_topic": chunk_meta.get("topic", ""),
            "chunk_summary": chunk_meta.get("summary", ""),
            "chunk_ref_usp_ids": chunk_meta.get("usp_ids") or [],  # ref USPs (참고용)
            "confidence": confidence,
            "reason": m.get("reason", ""),
        })

    # 5. gap 분석 (multi 기준)
    matched_user_ids: set[int] = set()
    for m in mapping_full:
        for u in (m.get("user_usp_ids") or []):
            matched_user_ids.add(u)
    unused_user = [
        {"user_usp_id": i + 1, "user_usp_name": u.get("usp", "")}
        for i, u in enumerate(user_usps) if (i + 1) not in matched_user_ids
    ]
    unmatched_chunks = [m for m in mapping_full if not m.get("user_usp_ids")]

    # 6. sp_sentences (DB 분석 결과 그대로 read-through)
    sp_sentences = overall.get("sp_sentences") or []

    # 7. hook archetype 노출 (wizard에서 primary/secondary 선택용)
    hook_archetype = None
    for c in section_chunks:
        if (c.get("section") or "").lower() == "hook":
            ha = c.get("archetype")
            if isinstance(ha, dict):
                hook_archetype = ha
            break

    return {
        "shortcode": shortcode,
        "product": {"id": product["id"], "name": product.get("name", ""), "usps": user_usps},
        "section_chunks": section_chunks,
        "chunk_mapping": mapping_full,
        "unused_user_usps": unused_user,
        "unmatched_chunks": unmatched_chunks,
        "ref_desires": ref_desires,
        "sp_sentences": sp_sentences,
        "hook_archetype": hook_archetype,
    }


@app.post("/api/script/analyze-body-chunks/{shortcode}")
def analyze_body_chunks_for_reel(shortcode: str, request: Request):
    """deprecated — analyze-section-chunks와 동일 동작."""
    auth_svc.require_user(request)
    ref = script_gen.fetch_reference(shortcode)
    if not ref:
        raise HTTPException(404, "참고 릴스 없음")
    sentences = ref.get("sentences") or []
    if not any((s.get("section") or "").lower().startswith("body") for s in sentences):
        raise HTTPException(400, "body_N 라벨된 sentences 필요 (먼저 classify-sentences 실행)")
    chunks = script_gen.analyze_body_chunks(ref)
    if not chunks:
        raise HTTPException(500, "body chunk 분석 실패")
    SUPA = (os.getenv("SUPABASE_URL") or "").strip()
    SK = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    _r = supabase.get_session()
    H = {"apikey": SK, "Authorization": f"Bearer {SK}"}
    rows = _r.get(
        f"{SUPA}/rest/v1/reels_script_structure?shortcode=eq.{shortcode}&select=overall&limit=1",
        headers=H, timeout=10,
    ).json()
    if not rows:
        raise HTTPException(404, "script_structure 없음")
    overall = rows[0].get("overall") or {}
    overall["body_chunks"] = chunks
    _r.patch(
        f"{SUPA}/rest/v1/reels_script_structure?shortcode=eq.{shortcode}",
        headers={**H, "Prefer": "return=minimal"},
        json={"overall": overall}, timeout=15,
    )
    return {"shortcode": shortcode, "chunks": chunks, "count": len(chunks)}


@app.post("/api/script/extract-roles/{shortcode}")
def extract_roles_for_reel(shortcode: str, request: Request):
    """참고 릴스의 섹션별 narrative role을 추출해 script_structure.overall.section_roles에 저장."""
    auth_svc.require_user(request)
    ref = script_gen.fetch_reference(shortcode)
    if not ref:
        raise HTTPException(404, "참고 릴스 데이터 없음")
    sentences = ref.get("sentences") or []
    if not sentences or not any((s.get("section") for s in sentences)):
        raise HTTPException(400, "section 라벨된 sentences 필요 — 먼저 classify-sentences 실행")
    roles = script_gen.extract_narrative_roles(ref)
    if not roles:
        raise HTTPException(500, "역할 추출 실패")
    SUPA = (os.getenv("SUPABASE_URL") or "").strip()
    SK = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    _r = supabase.get_session()
    H = {"apikey": SK, "Authorization": f"Bearer {SK}"}
    rows = _r.get(
        f"{SUPA}/rest/v1/reels_script_structure?shortcode=eq.{shortcode}&select=overall&limit=1",
        headers=H, timeout=10,
    ).json()
    if not rows:
        raise HTTPException(404, "script_structure 없음")
    overall = rows[0].get("overall") or {}
    overall["section_roles"] = roles
    _r.patch(
        f"{SUPA}/rest/v1/reels_script_structure?shortcode=eq.{shortcode}",
        headers={**H, "Prefer": "return=minimal"},
        json={"overall": overall}, timeout=15,
    )
    return {"shortcode": shortcode, "roles": roles, "section_count": len(roles)}


def _classify_sentences_core(shortcode: str, source: str, resegment: bool) -> dict:
    """sentence-level section 분류 backfill — reels/youtube 공용."""
    SUPA = (os.getenv("SUPABASE_URL") or "").strip()
    SK = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    _r = supabase.get_session()
    H = {"apikey": SK, "Authorization": f"Bearer {SK}"}
    t = script_gen._tables(source)

    # 1. sentences + structure 로드 (source별 분기)
    if t["sentences_in_pro_audio"]:
        # YouTube: pro_audio.sentences (있으면) 또는 tts_script
        pa_rows = _r.get(
            f"{SUPA}/rest/v1/{t['pro_audio']}?shortcode=eq.{shortcode}&select=pro_audio&limit=1",
            headers=H, timeout=10,
        ).json()
        if not pa_rows:
            raise HTTPException(404, "pro_audio 없음")
        pa = pa_rows[0].get("pro_audio") or {}
        sentences = pa.get("sentences") or pa.get("tts_script") or []
        transcript = " ".join((s.get("text") or "").strip() for s in sentences).strip()
    else:
        # Reels: reels_transcripts
        trans = _r.get(
            f"{SUPA}/rest/v1/{t['transcripts']}?shortcode=eq.{shortcode}&select=transcript,segments&limit=1",
            headers=H, timeout=10,
        ).json()
        if not trans:
            raise HTTPException(404, "transcript 없음")
        sentences = trans[0].get("segments") or []
        transcript = trans[0].get("transcript", "")
    if not sentences:
        raise HTTPException(400, "sentences 없음")

    if resegment:
        sentences = script_gen.resegment_to_sentences(sentences)

    struct = _r.get(
        f"{SUPA}/rest/v1/{t['structure']}?shortcode=eq.{shortcode}&select=hook,intro,body,cta&limit=1",
        headers=H, timeout=10,
    ).json()
    if not struct:
        raise HTTPException(400, "script_structure 없음 — 분석 먼저 완료해야 함")
    structure = struct[0]

    # 2. 분류
    try:
        classified = script_gen.classify_sentence_sections(sentences, structure)
    except Exception as e:
        raise HTTPException(500, f"분류 실패: {e}")
    if not classified or len(classified) != len(sentences):
        raise HTTPException(500, "분류 결과 비정상")

    # 3. 저장 — source별 분기
    if t["sentences_in_pro_audio"]:
        # YouTube: pro_audio.sentences에 저장 (기존 pro_audio 병합)
        pa_rows = _r.get(
            f"{SUPA}/rest/v1/{t['pro_audio']}?shortcode=eq.{shortcode}&select=pro_audio&limit=1",
            headers=H, timeout=10,
        ).json()
        cur_pa = (pa_rows[0].get("pro_audio") if pa_rows else {}) or {}
        new_pa = {**cur_pa, "sentences": classified}
        rr = _r.patch(
            f"{SUPA}/rest/v1/{t['pro_audio']}?shortcode=eq.{shortcode}",
            headers={**H, "Content-Type": "application/json", "Prefer": "return=minimal"},
            json={"pro_audio": new_pa}, timeout=15,
        )
        if rr.status_code not in (200, 204):
            raise HTTPException(rr.status_code, rr.text[:200])
    else:
        # Reels: reels_transcripts.segments UPSERT
        upsert_url = f"{SUPA}/rest/v1/{t['transcripts']}?on_conflict=shortcode"
        rr = _r.post(upsert_url, headers={
            **H,
            "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates,return=minimal",
        }, json={
            "shortcode": shortcode,
            "transcript": transcript,
            "language": "ko",
            "segments": classified,
        }, timeout=15)
        if rr.status_code not in (200, 201, 204):
            raise HTTPException(rr.status_code, rr.text[:200])

    # 캐시 무효화 (Reels만 — extra_cache는 IG 전용)
    if source == "reels":
        cached = pipeline.extra_cache.get(shortcode)
        if isinstance(cached, dict):
            cached["sentences"] = classified
            pipeline.extra_cache[shortcode] = cached

    from collections import Counter
    sec_counts = Counter(c.get("section", "?") for c in classified)
    return {
        "shortcode": shortcode,
        "source": source,
        "total_sentences": len(classified),
        "sections": dict(sec_counts),
    }


@app.post("/api/script/classify-sentences/{shortcode}")
def classify_sentences_for_reel(
    shortcode: str, request: Request,
    resegment: bool = Query(True, description="다중 문장 segment를 문장 단위로 쪼갠 후 분류"),
):
    """인스타 릴스용 — 기존 분석된 릴스에 sentence-level section 분류 backfill."""
    auth_svc.require_user(request)
    return _classify_sentences_core(shortcode, source="reels", resegment=resegment)


@app.post("/api/yt/script/classify-sentences/{shortcode}")
def classify_sentences_for_yt(
    shortcode: str, request: Request,
    resegment: bool = Query(True, description="다중 문장 segment를 문장 단위로 쪼갠 후 분류"),
):
    """유튜브 Shorts용 — pro_audio.tts_script을 분류해서 pro_audio.sentences로 저장."""
    auth_svc.require_user(request)
    return _classify_sentences_core(shortcode, source="youtube", resegment=resegment)


@app.get("/api/script/section-pool")
@app.get("/api/script/cta-pool")  # backward compat
def section_pool(section: str = Query("cta", description="hook|intro|cta"), exclude: str = Query("", description="제외할 shortcode"), shortcode: str = Query("", description="특정 shortcode 1개 조회"), limit: int = Query(50, ge=1, le=500)):
    """분석된 릴스에서 특정 섹션 chunks를 모아 반환 — wizard에서 다른 ref의 hook/intro/cta로 swap용."""
    section = (section or "cta").lower().strip()
    if section not in ("hook", "intro", "cta"):
        section = "cta"
    SUPA = (os.getenv("SUPABASE_URL") or "").strip()
    SK = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    H = {"apikey": SK, "Authorization": f"Bearer {SK}"}
    _r = supabase.get_session()

    # script_structure에 overall.section_chunks가 있는 것만 (CTA chunk 포함 가능성)
    if shortcode:
        rows = _r.get(
            f"{SUPA}/rest/v1/reels_script_structure?shortcode=eq.{shortcode}&select=shortcode,hook,intro,cta,overall&limit=1",
            headers=H, timeout=15,
        ).json() or []
    else:
        rows = _r.get(
            f"{SUPA}/rest/v1/reels_script_structure?select=shortcode,hook,intro,cta,overall&limit=500",
            headers=H, timeout=15,
        ).json() or []

    # 메타에서 author 가져오기 (배치)
    sc_list = [r["shortcode"] for r in rows if r.get("shortcode")]
    authors: dict[str, str] = {}
    if sc_list:
        sc_q = ",".join(f'"{s}"' for s in sc_list)
        meta_rows = _r.get(
            f"{SUPA}/rest/v1/reels_metadata?shortcode=in.({sc_q})&select=shortcode,author_username&limit={len(sc_list)}",
            headers=H, timeout=15,
        ).json() or []
        authors = {m["shortcode"]: (m.get("author_username") or "") for m in meta_rows if m.get("shortcode")}

    out: list[dict] = []
    for r in rows:
        sc = r.get("shortcode")
        if not sc or sc == exclude:
            continue
        overall = r.get("overall") or {}
        chunks = overall.get("section_chunks") or []
        target_chunk = next((c for c in chunks if (c.get("section") or "").lower() == section), None)
        target_text = ""
        if target_chunk:
            target_text = " ".join((s.get("text") or "").strip() for s in (target_chunk.get("sentences") or [])).strip()
        if not target_text:
            # fallback: structure.<section>.text — chunk 없을 때 즉석 합성
            sec_obj = r.get(section) if isinstance(r.get(section), dict) else {}
            target_text = (sec_obj.get("text") or "").strip()
            if target_text and not target_chunk:
                target_chunk = {
                    "section": section,
                    "topic": sec_obj.get("type", ""),
                    "role": section,
                    "summary": sec_obj.get("analysis", ""),
                    "sentences": [{"start": 0.0, "end": 3.0, "text": target_text, "section": section}],
                }
        if not target_text:
            continue
        out.append({
            "shortcode": sc,
            "author": authors.get(sc, ""),
            "section": section,
            "section_text": target_text,
            "section_chunk": target_chunk,
            # backward compat (cta-pool 별칭 사용처용)
            "cta_text": target_text,
            "cta_chunk": target_chunk,
            "topic": (target_chunk or {}).get("topic", "") if target_chunk else "",
        })
    # shortcode 쿼리는 limit 무시, 그 외는 적용
    if not shortcode:
        out = out[:limit]
    return {"items": out, "total": len(out)}


@app.get("/api/script/ref-sentences/{shortcode}")
def get_ref_sentences(shortcode: str, request: Request, source: str = "reels"):
    """ref 영상의 sentences (start/end/text/section) 시간순 반환 — 대본 비교용."""
    auth_svc.require_user(request)
    src = source if source in ("reels", "youtube") else "reels"
    ref = script_gen.fetch_reference(shortcode, source=src)
    if not ref:
        raise HTTPException(404, "ref 없음")
    sents = ref.get("sentences") or []
    out = [{
        "start": s.get("start"),
        "end": s.get("end"),
        "text": s.get("text", ""),
        "section": s.get("section", ""),
    } for s in sents if (s.get("text") or "").strip()]
    out.sort(key=lambda x: x.get("start") or 0)
    return {"shortcode": shortcode, "source": src, "sentences": out}


@app.get("/api/script/reference-info/{shortcode}")
def reference_info(shortcode: str):
    """참고 릴스의 구조 정보 (분류·문장 수·body 슬롯 수) — UI 가이드용.

    recommended_usps는 chunks의 USP 그룹 수 (primary_usp_id가 있는 chunks).
    """
    try:
        ref = script_gen.fetch_reference(shortcode)
        if not ref:
            raise HTTPException(404, "참고 릴스 데이터 없음")
        props = script_gen.analyze_reference_proportions(ref)
        body_class = script_gen.classify_body_structure(ref)
        body_slot_count = len(props.get("body_slots") or [])
        # chunks 기반 USP 개수 (engagement 제외 — primary_usp_id 있는 chunks 그룹)
        overall = ((ref.get("structure") or {}).get("overall") or {})
        chunks = overall.get("section_chunks") or []
        usp_ids_in_chunks = set()
        for c in chunks:
            uid = c.get("primary_usp_id")
            if isinstance(uid, int):
                usp_ids_in_chunks.add(uid)
        if usp_ids_in_chunks:
            recommended = len(usp_ids_in_chunks)
        elif body_class.get("type") in ("단일USP_카테고리분할", "단일진행"):
            recommended = 1
        else:
            recommended = body_slot_count
        return {
            "shortcode": shortcode,
            "duration_sec": props.get("total_sec"),
            "total_sentences": len(ref.get("sentences") or []),
            "body_slot_count": body_slot_count,
            "body_class": body_class,
            "recommended_usps": recommended,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"참고 분석 실패: {e}")


class ScriptRefineRequest(BaseModel):
    draft: dict
    usps: list[dict] = []  # 통일 도시 추출용
    reference_shortcode: str | None = None  # 참고 길이 매칭용
    # ⭐ wizard에서 사용자가 삭제한 chunk/sentence — ref filtering에 활용 (복원 방지)
    skip_chunk_sections: list[str] | None = None
    skip_sentence_starts: list[float] | None = None
    variant: str = "default"  # 'default' (기본 다듬기) | 'strong' (강한 변주 — 어휘 더 크게 변경)
    # 페르소나 anchor — variant=strong(humanize) 적용 시 페르소나 시그널 보존용
    target_persona: dict | None = None


@app.post("/api/script/refine")
def refine_script(req: ScriptRefineRequest):
    if not req.draft or not req.draft.get("sentences"):
        raise HTTPException(400, "draft.sentences 필수")
    try:
        script_gen.reset_cost_meter()
        unified = script_gen.select_unified_scenario(req.usps or [])
        # 참고 릴스 fetch — 길이 매칭용
        ref_info = None
        if req.reference_shortcode:
            try:
                ref = script_gen.fetch_reference(req.reference_shortcode)
                if ref:
                    ref_sents = [s for s in (ref.get("sentences") or []) if s.get("text", "").strip()]
                    # ⭐ 사용자가 wizard에서 삭제한 chunk/sentence는 ref에서도 제외
                    # → refine이 "삭제된 문장을 복원" 안 함 (draft 길이와 ref 길이 매칭)
                    skip_secs = {(s or "").strip().lower() for s in (req.skip_chunk_sections or []) if isinstance(s, str)}
                    skip_starts = {round(float(x), 2) for x in (req.skip_sentence_starts or [])}
                    if skip_secs or skip_starts:
                        before = len(ref_sents)
                        ref_sents = [
                            s for s in ref_sents
                            if (s.get("section") or "").strip().lower() not in skip_secs
                            and round(float(s.get("start") or 0), 2) not in skip_starts
                        ]
                        logger.info("[refine] ref filtered: %d → %d (skip chunks=%s, skip starts=%d)",
                                    before, len(ref_sents), sorted(skip_secs), len(skip_starts))
                    ref_duration = max((float(s.get("end", 0)) for s in ref_sents), default=0) if ref_sents else 0
                    ref_info = {
                        "sentence_count": len(ref_sents),
                        "duration": ref_duration,
                        "sentences": ref_sents,
                    }
            except Exception as e:
                logger.warning("ref fetch failed in refine: %s", e)
        # B. Flash 어색 검출 (v3 baseline)
        awkward_info = []
        try:
            ref_for_aw = (ref_info or {}).get("sentences") or []
            awkward_info = script_gen.detect_awkward_sentences(req.draft.get("sentences") or [], ref_for_aw)
            if awkward_info:
                logger.info("[refine] %d awkward sentences detected", len(awkward_info))
        except Exception as e:
            logger.warning("[refine] awkward detection failed: %s", e)
        # B-2. 어휘 중복 검출 — anchor [:2] 기준, 같은 stem 2+ 문장 등장 시 교정 대상
        vocab_repeats: dict[str, list[int]] = {}
        try:
            vocab_repeats = script_gen.detect_vocab_repeats(req.draft.get("sentences") or [])
            if vocab_repeats:
                logger.info("[refine] vocab repeats: %s", {k: v for k, v in list(vocab_repeats.items())[:5]})
        except Exception as e:
            logger.warning("[refine] vocab repeat detection failed: %s", e)
        prompt = script_gen.build_refine_prompt(req.draft, unified.get("city"), ref_info=ref_info, usps=req.usps, awkward_info=awkward_info, vocab_repeats=vocab_repeats, target_persona=req.target_persona)
        # variant: strong = 기본 refine + humanize-korean 룰 추가 (AI 티 제거)
        variant = req.variant if req.variant in ("default", "strong") else "default"
        if variant == "strong":
            prompt += """

## ⚡ humanize 후처리 (variant=strong — im-not-ai 스타일)
기본 다듬기 룰에 더해 **AI가 쓴 한글 티**를 자연스러운 사람말투로 교정.

### 0. 페르소나 시그널 우선 (다른 humanize 룰보다 먼저)
- 위 페르소나 anchor의 pain_scene·desire_scene·identity 어휘 중 **1개 이상** 출력에 명시
- tone_hint 어조(반말/존댓말/인플루언서 톤 등) 유지
- 아래 humanize 룰이 페르소나 어휘·톤을 덮어쓰지 않게 함 (페르소나 vocab은 추상명사·광고 클리셰 검열에서 제외)

### 1. 번역투 제거 (강제)
- ❌ "~을 통해 / ~에 있어 / ~로 인해 / ~에 대해 / ~로서의"
  → ✅ 자연 한국어 ("~로 / ~한 / ~서 / ~한테는 / ~인")
- 예: "이 기능을 통해 절약할 수 있어요" → "이 기능으로 절약돼요"

### 2. 추상명사 회피
- ❌ "편리함 / 효율성 / 만족도 / 자신감 / 행복 / 즐거움 / 가능성"
  → ✅ 구체 동사·장면 ("편해요 / 빠르게 / 쓸 만해요 / 자국 안 남아요")
- AI 티 1순위: 추상명사 끝 + 광고적 어휘

### 3. 종결 어미 다양화 (균일 금지)
- ❌ 모든 문장이 "~어요/~예요/~해요"로 균일 종결
- ✅ ref와 같이 ~잖아요/~거든요/~봐/~줘/~네/~지/~ㄴ/체언 종결을 섞기
- ref가 ~ㄴ 관형형이면 우리도 ~ㄴ (~한·~된)

### 4. 접속사 남발 제거
- ❌ "그리고 / 또한 / 하지만 / 그러나" 매 문장 머리에 박지 말 것
- ✅ 흐름은 어미·문맥으로. 접속사 1~2개만 정말 필요한 자리에

### 5. 직역·기계적 패턴 제거
- ❌ "당신의 ~ / 우리의 ~ / 본 제품은 ~" 같은 직역구
- ❌ "~할 수 있습니다 / ~하실 수 있어요" 정중·기계 어투 균일
- ✅ ref 톤 그대로 (구어·반말·일상)

### 6. 광고 클리셰 회피
- ❌ "혁신적 / 프리미엄 / 차별화된 / 특별한 / 놀라운"
- ✅ 구체 행동·수치·감각 어휘 (페르소나 vocab)

### 7. 리듬 균일성 깨기
- 문장 길이 모두 비슷하면 AI 티 — 짧은 문장 + 긴 문장 섞이기 (ref 패턴 따라)
- 단, 어절·음절 룰은 spec 기준 그대로 준수

### 출력 원칙
- 위 룰을 적용하되 **의미는 100% 보존** (수치/USP 명사/페르소나 vocab 변경 금지)
- ref 어절·음절·종결 형태 룰은 절대 깨지 않음 (구조 X, 어휘·톤만 humanize)
- 결과가 1차와 동일하면 실패 — AI 티를 식별 가능하게 제거할 것
"""
        logger.info("[refine] variant=%s", variant)
        draft_n = len(req.draft.get("sentences") or [])
        # 길이 매칭: ref 있으면 그 수로, 없으면 draft 그대로
        if ref_info and ref_info["sentence_count"] > 0:
            target_n = ref_info["sentence_count"]
            min_n = max(1, target_n - 2)
        else:
            target_n = draft_n
            min_n = max(1, draft_n - 2) if draft_n else None
        refined = script_gen.call_gemini(prompt, min_sentences=min_n)
        if isinstance(refined, list) and refined:
            refined = refined[0]
        if not isinstance(refined, dict) or not refined.get("sentences"):
            raise RuntimeError("refine 결과가 비어있습니다")
        # per-sentence 길이 검증 + 자동 retry
        if ref_info and ref_info.get("sentences"):
            violations = script_gen._find_refine_overflow(refined.get("sentences") or [], ref_info["sentences"])
            if violations:
                logger.warning("[refine] overflow at indices: %s", [(v[0], v[1], v[2]) for v in violations])
                try:
                    retry_prompt = script_gen.build_refine_retry_prompt(refined, violations, ref_info["sentences"])
                    retry = script_gen.call_gemini(retry_prompt, min_sentences=min_n)
                    if isinstance(retry, list) and retry:
                        retry = retry[0]
                    if isinstance(retry, dict) and retry.get("sentences"):
                        # per-sentence merge — 각 violation 위치에서 retry가 더 짧으면 그 문장만 교체
                        merged = list(refined.get("sentences") or [])
                        retry_sents = retry.get("sentences") or []
                        # 안전장치: retry가 원본보다 50% 이하 문장만 갖고 있으면 스킵 (Gemini가 일부만 출력한 경우)
                        if len(retry_sents) < len(merged) * 0.5:
                            logger.warning("[refine] retry returned only %d/%d sentences — skipping merge", len(retry_sents), len(merged))
                            retry_sents = []
                        ref_sents_arr = ref_info["sentences"]
                        improved = 0
                        for v_idx, v_gen_syl, v_ref_syl, _, _ in violations:
                            if v_idx >= len(merged) or v_idx >= len(retry_sents):
                                continue
                            new_text = (retry_sents[v_idx] or {}).get("text", "")
                            if not new_text.strip():
                                continue
                            new_syl = script_gen._count_kor_syllables(new_text)
                            # retry가 더 짧고 ref ±15% 이내면 교체
                            if new_syl < v_gen_syl and new_syl <= v_ref_syl * 1.15:
                                merged[v_idx] = {**merged[v_idx], "text": new_text}
                                improved += 1
                        if improved:
                            logger.info("[refine] retry improved %d/%d sentences", improved, len(violations))
                            refined["sentences"] = merged
                except Exception as e:
                    logger.warning("[refine] retry failed: %s", e)
        refined["_refined"] = True
        # _references_used 보존
        if req.draft.get("_references_used"):
            refined["_references_used"] = req.draft["_references_used"]
        cost = script_gen.summarize_cost()
        refined["_cost"] = cost
        logger.info("[refine] cost=$%.4f (%d calls, in=%d out=%d)",
                    cost["total_cost_usd"], cost["total_calls"], cost["total_in_tokens"], cost["total_out_tokens"])
        return refined
    except Exception as e:
        raise HTTPException(500, f"다듬기 실패: {e}")


# ── Admin Secrets (Vault) ──

_secret_list_cache: tuple[float, list] | None = None
_SECRET_LIST_CACHE_TTL = 60

class SecretUpsertRequest(BaseModel):
    name: str
    value: str
    description: str = ""


@app.get("/api/admin/secrets")
def list_secrets(request: Request):
    """admin: 등록된 시크릿 메타정보 (값 X)."""
    auth_svc.require_admin(request)
    global _secret_list_cache
    if _secret_list_cache and time.time() - _secret_list_cache[0] < _SECRET_LIST_CACHE_TTL:
        return _secret_list_cache[1]
    try:
        items = secrets_svc.list_secrets()
        _secret_list_cache = (time.time(), items)
        return items
    except Exception as e:
        raise HTTPException(500, f"시크릿 조회 실패: {e}")


@app.post("/api/admin/secrets")
def upsert_secret(req: SecretUpsertRequest, request: Request):
    """admin: 시크릿 생성·갱신. 캐시 즉시 무효화."""
    auth_svc.require_admin(request)
    if not req.name.strip() or not req.value.strip():
        raise HTTPException(400, "name·value 필수")
    try:
        sid = secrets_svc.upsert_secret(req.name.strip(), req.value, req.description)
        global _secret_list_cache
        _secret_list_cache = None
        return {"id": sid, "name": req.name, "message": "갱신 완료"}
    except Exception as e:
        raise HTTPException(500, f"시크릿 저장 실패: {e}")


@app.delete("/api/admin/secrets/{name}")
def delete_secret(name: str, request: Request):
    """admin: 시크릿 삭제."""
    auth_svc.require_admin(request)
    try:
        ok = secrets_svc.delete_secret(name)
        global _secret_list_cache
        _secret_list_cache = None
        return {"deleted": ok}
    except Exception as e:
        raise HTTPException(500, f"시크릿 삭제 실패: {e}")


# ── My Products ──

class MyProductIn(BaseModel):
    name: str
    persona: str | None = None
    usps: list[dict] = []
    social_proof: list[dict] = []


_MY_PRODUCTS_CACHE_TTL = 20
_my_products_cache: dict[str, tuple[float, list]] = {}
_shareable_users_cache: dict[str, tuple[float, list]] = {}
_users_cache: dict[str, tuple[float, list]] = {}
_USERS_CACHE_TTL = 60
_MY_SCRIPTS_CACHE_TTL = 20
_my_scripts_cache: dict[str, tuple[float, dict]] = {}


def _invalidate_my_scripts_cache():
    _my_scripts_cache.clear()


def _cache_get(cache: dict, key: str, ttl: int):
    item = cache.get(key)
    if not item:
        return None
    ts, data = item
    if time.time() - ts > ttl:
        cache.pop(key, None)
        return None
    return data


def _cache_set(cache: dict, key: str, data):
    cache[key] = (time.time(), data)
    return data


def _invalidate_my_products_cache():
    _my_products_cache.clear()
    _shareable_users_cache.clear()


@app.get("/api/my-products")
def list_my_products(request: Request):
    me = auth_svc.require_user(request)
    cached = _cache_get(_my_products_cache, me["id"], _MY_PRODUCTS_CACHE_TTL)
    if cached is not None:
        return cached
    SUPA = (os.getenv("SUPABASE_URL") or "").strip()
    SK = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    _r = supabase.get_session()
    H = {"apikey": SK, "Authorization": f"Bearer {SK}"}

    # 소유 + 공유받은 상품을 병렬로 조회
    with ThreadPoolExecutor(max_workers=2) as ex:
        f_own = ex.submit(
            _r.get,
            f"{SUPA}/rest/v1/my_products?owner_id=eq.{me['id']}&select=*&order=updated_at.desc",
            headers=H, timeout=10,
        )
        f_shared = ex.submit(
            _r.get,
            f"{SUPA}/rest/v1/my_product_shares?shared_with_id=eq.{me['id']}"
            f"&select=permission,product:my_products(*)",
            headers=H, timeout=10,
        )

    own = f_own.result().json() or []
    shared_rows = f_shared.result().json() or []

    me_name = (me.get("display_name") or (me.get("email") or "").split("@")[0])
    for p in own:
        p["is_shared"] = False
        p["permission"] = "owner"
        p["owner_name"] = me_name

    # 소유자 이름 매핑 (공유받은 상품이 있을 때만)
    name_map: dict[str, str] = {}
    owner_ids = list({row["product"]["owner_id"] for row in shared_rows if row.get("product")})
    if owner_ids:
        prof = _r.get(
            f"{SUPA}/rest/v1/profiles?id=in.({','.join(owner_ids)})&select=id,display_name,email",
            headers=H, timeout=10,
        ).json() or []
        for p in prof:
            name_map[p["id"]] = p.get("display_name") or (p.get("email") or "").split("@")[0]

    shared = []
    for row in shared_rows:
        prod = row.get("product")
        if not prod:
            continue
        prod["is_shared"] = True
        prod["permission"] = row["permission"]
        prod["owner_name"] = name_map.get(prod["owner_id"], "?")
        shared.append(prod)

    merged = own + shared
    merged.sort(key=lambda x: x.get("updated_at") or "", reverse=True)
    return _cache_set(_my_products_cache, me["id"], merged)


@app.post("/api/my-products")
def create_my_product(req: MyProductIn, request: Request):
    me = auth_svc.require_user(request)
    if not req.name.strip():
        raise HTTPException(400, "이름 필수")
    SUPA = (os.getenv("SUPABASE_URL") or "").strip()
    SK = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    _r = supabase.get_session()
    r = _r.post(
        f"{SUPA}/rest/v1/my_products",
        headers={"apikey": SK, "Authorization": f"Bearer {SK}",
                 "Content-Type": "application/json", "Prefer": "return=representation"},
        json={"owner_id": me["id"], "name": req.name, "persona": req.persona, "usps": req.usps, "social_proof": req.social_proof},
        timeout=10,
    )
    if r.status_code not in (200, 201):
        raise HTTPException(r.status_code, r.text[:200])
    _invalidate_my_products_cache()
    return r.json()[0] if r.json() else {}


@app.patch("/api/my-products/{pid}")
def update_my_product(pid: int, req: MyProductIn, request: Request):
    me = auth_svc.require_user(request)
    SUPA = (os.getenv("SUPABASE_URL") or "").strip()
    SK = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    _r = supabase.get_session()
    H = {"apikey": SK, "Authorization": f"Bearer {SK}"}
    # 소유자 OR 수정 권한 share OR admin
    own = _r.get(f"{SUPA}/rest/v1/my_products?id=eq.{pid}&select=owner_id",
        headers=H, timeout=10).json()
    if not own:
        raise HTTPException(404, "상품 없음")
    if me.get("role") != "admin" and own[0]["owner_id"] != me["id"]:
        share = _r.get(
            f"{SUPA}/rest/v1/my_product_shares?product_id=eq.{pid}"
            f"&shared_with_id=eq.{me['id']}&permission=eq.edit&select=id&limit=1",
            headers=H, timeout=10,
        ).json()
        if not share:
            raise HTTPException(403, "권한 없음")
    r = _r.patch(
        f"{SUPA}/rest/v1/my_products?id=eq.{pid}",
        headers={"apikey": SK, "Authorization": f"Bearer {SK}",
                 "Content-Type": "application/json", "Prefer": "return=representation"},
        json={"name": req.name, "persona": req.persona, "usps": req.usps, "social_proof": req.social_proof},
        timeout=10,
    )
    if r.status_code not in (200, 204):
        raise HTTPException(r.status_code, r.text[:200])
    _invalidate_my_products_cache()
    return r.json()[0] if r.json() else {}


# ── Generated Scripts: 생성된 대본 저장·관리 ──

class GenScriptIn(BaseModel):
    ref_shortcode: str | None = None
    source_type: str = "insta"  # insta | youtube | fb_ads
    persona_name: str | None = None
    title: str | None = None
    sentences: list[dict] = []
    meta: dict = {}
    caption: str | None = None
    pinned_comment: str | None = None


class GenScriptPatch(BaseModel):
    title: str | None = None
    caption: str | None = None
    pinned_comment: str | None = None
    sentences: list[dict] | None = None
    shooting_plan_url: str | None = None
    status: str | None = None  # 'pending' | 'done'
    group_name: str | None = None  # 사용자 정의 그룹
    stages: list[dict] | None = None  # meta.stages 통째 갱신 (key 기반: base/alt_a/alt_b)


class GenScriptShareIn(BaseModel):
    shared_with_id: str | None = None  # 우선
    email: str | None = None  # backward compat
    permission: str = "view"  # 'view' | 'edit'


def _check_script_access(pid: int, sid: str, me: dict, edit: bool = False) -> dict:
    """대본 접근 권한 체크. 반환: 대본 행. created_by OR 공유 OR admin."""
    SUPA = (os.getenv("SUPABASE_URL") or "").strip()
    SK = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    _r = supabase.get_session()
    H = {"apikey": SK, "Authorization": f"Bearer {SK}"}
    rows = _r.get(
        f"{SUPA}/rest/v1/generated_scripts?id=eq.{sid}&product_id=eq.{pid}&select=*&limit=1",
        headers=H, timeout=10,
    ).json()
    if not rows:
        raise HTTPException(404, "대본 없음")
    row = rows[0]
    if me.get("role") == "admin" or row.get("created_by") == me["id"]:
        return row
    perm_q = "permission=eq.edit" if edit else ""
    qs = f"script_id=eq.{sid}&shared_with_id=eq.{me['id']}&select=id&limit=1"
    if perm_q:
        qs += f"&{perm_q}"
    share = _r.get(f"{SUPA}/rest/v1/generated_script_shares?{qs}", headers=H, timeout=10).json()
    if not share:
        raise HTTPException(403, "대본 권한 없음")
    return row


def _check_product_access(pid: int, me: dict, edit: bool = False) -> None:
    """소유 OR (edit이면 edit share / view면 view+) OR admin."""
    SUPA = (os.getenv("SUPABASE_URL") or "").strip()
    SK = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    _r = supabase.get_session()
    H = {"apikey": SK, "Authorization": f"Bearer {SK}"}
    own = _r.get(f"{SUPA}/rest/v1/my_products?id=eq.{pid}&select=owner_id",
                 headers=H, timeout=10).json()
    if not own:
        raise HTTPException(404, "상품 없음")
    if me.get("role") == "admin" or own[0]["owner_id"] == me["id"]:
        return
    perm_filter = "permission=eq.edit" if edit else ""
    qs = f"product_id=eq.{pid}&shared_with_id=eq.{me['id']}&select=id&limit=1"
    if perm_filter:
        qs += f"&{perm_filter}"
    share = _r.get(f"{SUPA}/rest/v1/my_product_shares?{qs}", headers=H, timeout=10).json()
    if not share:
        raise HTTPException(403, "권한 없음")


@app.post("/api/my-products/{pid}/scripts")
def create_gen_script(pid: int, body: GenScriptIn, request: Request):
    me = auth_svc.require_user(request)
    _check_product_access(pid, me, edit=True)
    SUPA = (os.getenv("SUPABASE_URL") or "").strip()
    SK = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    _r = supabase.get_session()
    meta_full = dict(body.meta or {})
    if body.caption is not None:
        meta_full["caption"] = body.caption
    if body.pinned_comment is not None:
        meta_full["pinned_comment"] = body.pinned_comment
    r = _r.post(
        f"{SUPA}/rest/v1/generated_scripts",
        headers={"apikey": SK, "Authorization": f"Bearer {SK}",
                 "Content-Type": "application/json", "Prefer": "return=representation"},
        json={
            "product_id": pid,
            "ref_shortcode": body.ref_shortcode,
            "source_type": body.source_type,
            "persona_name": body.persona_name,
            "title": body.title or (body.persona_name or "대본"),
            "sentences": body.sentences,
            "meta": meta_full,
            "created_by": me["id"],
        }, timeout=15,
    )
    if r.status_code not in (200, 201):
        raise HTTPException(r.status_code, r.text[:300])
    _invalidate_my_scripts_cache()
    return r.json()[0] if r.json() else {}


@app.patch("/api/my-products/{pid}/scripts/{sid}")
def update_gen_script(pid: int, sid: str, body: GenScriptPatch, request: Request):
    """저장된 대본 일부 수정 (title / sentences / caption / pinned_comment). 작성자 또는 edit 공유 가능."""
    me = auth_svc.require_user(request)
    row = _check_script_access(pid, sid, me, edit=True)
    SUPA = (os.getenv("SUPABASE_URL") or "").strip()
    SK = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    _r = supabase.get_session()
    H = {"apikey": SK, "Authorization": f"Bearer {SK}"}
    cur_meta = row.get("meta") or {}
    payload: dict = {}
    if body.title is not None:
        payload["title"] = body.title
    if body.sentences is not None:
        payload["sentences"] = body.sentences
    if body.caption is not None:
        cur_meta["caption"] = body.caption
    if body.pinned_comment is not None:
        cur_meta["pinned_comment"] = body.pinned_comment
    if body.shooting_plan_url is not None:
        cur_meta["shooting_plan_url"] = body.shooting_plan_url
    if body.status is not None:
        cur_meta["status"] = "done" if body.status == "done" else "pending"
    if body.group_name is not None:
        gn = body.group_name.strip()
        if gn:
            cur_meta["group_name"] = gn
        else:
            cur_meta.pop("group_name", None)
    if body.stages is not None:
        cur_meta["stages"] = body.stages
    if any(x is not None for x in [body.caption, body.pinned_comment, body.shooting_plan_url, body.status, body.group_name, body.stages]):
        payload["meta"] = cur_meta
    if not payload:
        return {"updated": False, "row": row}
    logger.info("[gen-script PATCH] sid=%s pid=%s keys=%s sentences_n=%s",
                sid, pid, list(payload.keys()),
                len(payload.get("sentences") or []) if "sentences" in payload else None)
    r = _r.patch(
        f"{SUPA}/rest/v1/generated_scripts?id=eq.{sid}&product_id=eq.{pid}",
        headers={**H, "Content-Type": "application/json", "Prefer": "return=representation"},
        json=payload, timeout=15,
    )
    if r.status_code not in (200, 204):
        raise HTTPException(r.status_code, r.text[:300])
    rows = r.json() if r.status_code == 200 else []
    _invalidate_my_scripts_cache()
    return {"updated": True, "row": rows[0] if rows else None}


class SavedRefineRequest(BaseModel):
    variant: str = "default"


@app.post("/api/my-products/{pid}/scripts/{sid}/refine")
def refine_saved_script(pid: int, sid: str, body: SavedRefineRequest, request: Request):
    """저장된 대본을 다듬기 처리 → meta.stages에 단계별 누적 + sentences 최신으로 갱신.

    stages 구조: [{stage: 1, sentences, variant?, created_at}, ...]
    stage 1 = 원본 (첫 다듬기 시 자동 백업), stage 2+ = 다듬기 결과.
    """
    me = auth_svc.require_user(request)
    row = _check_script_access(pid, sid, me, edit=True)
    SUPA = (os.getenv("SUPABASE_URL") or "").strip()
    SK = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    _r = supabase.get_session()
    H = {"apikey": SK, "Authorization": f"Bearer {SK}"}

    from datetime import datetime, timezone
    variant = body.variant if body.variant in ("default", "strong") else "default"
    target_key = "alt_a" if variant == "default" else "alt_b"

    # 기존 stages 정규화 + 입력 sentences는 base (stages.base 또는 row.sentences)
    raw_stages = list((row.get("meta") or {}).get("stages") or [])
    def _norm_key(s: dict):
        if s.get("key") in ("base", "alt_a", "alt_b"): return s["key"]
        v = s.get("variant")
        if v == "original": return "base"
        if v == "default": return "alt_a"
        if v == "strong": return "alt_b"
        return None
    stages_map: dict = {}
    for s in raw_stages:
        k = _norm_key(s)
        if k and k not in stages_map:
            stages_map[k] = {"key": k, "sentences": s.get("sentences") or [], "created_at": s.get("created_at")}

    base_sents = (stages_map.get("base") or {}).get("sentences") or row.get("sentences") or []
    if not base_sents:
        raise HTTPException(400, "현재 sentences 없음")
    if target_key in stages_map:
        raise HTTPException(400, f"{('A' if target_key == 'alt_a' else 'B')}원고 이미 있음 — 재생성 불가")
    cur_sents = base_sents

    # 매핑된 상품 USPs 로드 (refine prompt 입력)
    prod_rows = _r.get(
        f"{SUPA}/rest/v1/my_products?id=eq.{pid}&select=usps&limit=1",
        headers=H, timeout=10,
    ).json() or []
    usps = (prod_rows[0].get("usps") if prod_rows else []) or []

    ref_shortcode = row.get("ref_shortcode")
    try:
        script_gen.reset_cost_meter()
        unified = script_gen.select_unified_scenario(usps or [])
        ref_info = None
        if ref_shortcode:
            try:
                ref = script_gen.fetch_reference(ref_shortcode)
                if ref:
                    ref_sents = [s for s in (ref.get("sentences") or []) if s.get("text", "").strip()]
                    ref_duration = max((float(s.get("end", 0)) for s in ref_sents), default=0) if ref_sents else 0
                    ref_info = {"sentence_count": len(ref_sents), "duration": ref_duration, "sentences": ref_sents}
            except Exception as e:
                logger.warning("[saved-refine] ref fetch failed: %s", e)
        awkward_info = []
        try:
            ref_for_aw = (ref_info or {}).get("sentences") or []
            awkward_info = script_gen.detect_awkward_sentences(cur_sents, ref_for_aw)
        except Exception as e:
            logger.warning("[saved-refine] awkward detection failed: %s", e)
        vocab_repeats: dict = {}
        try:
            vocab_repeats = script_gen.detect_vocab_repeats(cur_sents)
        except Exception as e:
            logger.warning("[saved-refine] vocab repeat detection failed: %s", e)
        draft = {"sentences": cur_sents}
        # 저장된 대본 meta에 target_persona 저장돼 있으면 활용 (페르소나 anchor 보존용)
        saved_persona = ((row.get("meta") or {}).get("target_persona")) or None
        prompt = script_gen.build_refine_prompt(draft, unified.get("city"), ref_info=ref_info, usps=usps, awkward_info=awkward_info, vocab_repeats=vocab_repeats, target_persona=saved_persona)
        if variant == "strong":
            prompt += """

## ⚡ humanize 후처리 (variant=strong — im-not-ai 스타일)
페르소나 시그널(pain_scene·desire_scene·identity·tone_hint) 보존 우선.
그 위에 번역투/추상명사/균일 종결/접속사 남발/직역구/광고 클리셰 제거.
어절·음절·종결 룰은 보존, 어휘·톤만 humanize. 1차와 동일하면 실패.
"""
        target_n = ref_info["sentence_count"] if ref_info else len(cur_sents)
        min_n = max(1, target_n - 2)
        refined = script_gen.call_gemini(prompt, min_sentences=min_n)
        if isinstance(refined, list) and refined:
            refined = refined[0]
        new_sents = (refined or {}).get("sentences") or []
        if not new_sents:
            raise HTTPException(500, "refine 결과 없음")
        # direction/emotion/delivery 같은 TTS 메타를 base에서 1:1 merge (LLM 응답에 빠지면 base 유지)
        merged_new: list[dict] = []
        for i, rs in enumerate(new_sents):
            base = base_sents[i] if i < len(base_sents) else {}
            merged_new.append({
                **base,
                "text": rs.get("text") or base.get("text", ""),
                "direction": rs.get("direction") if rs.get("direction") is not None else base.get("direction"),
                "emotion": rs.get("emotion") if rs.get("emotion") is not None else base.get("emotion"),
                "intensity": rs.get("intensity") if rs.get("intensity") is not None else base.get("intensity"),
                "delivery": rs.get("delivery") if rs.get("delivery") is not None else base.get("delivery"),
            })
        new_sents = merged_new
    except HTTPException:
        raise
    except Exception as e:
        logger.warning("[saved-refine] failed: %s", e)
        raise HTTPException(500, f"다듬기 실패: {e}")

    # key 기반 stages 갱신 — base 보장 + target_key (alt_a/alt_b) 추가
    cur_meta = dict(row.get("meta") or {})
    now_iso = datetime.now(timezone.utc).isoformat()
    if "base" not in stages_map:
        stages_map["base"] = {"key": "base", "sentences": base_sents, "created_at": now_iso}
    stages_map[target_key] = {"key": target_key, "sentences": new_sents, "created_at": now_iso}
    order = ["base", "alt_a", "alt_b"]
    stages = [stages_map[k] for k in order if k in stages_map]
    cur_meta["stages"] = stages

    # sentences 컬럼은 base로 유지 (A/B는 stages에만)
    r = _r.patch(
        f"{SUPA}/rest/v1/generated_scripts?id=eq.{sid}&product_id=eq.{pid}",
        headers={**H, "Content-Type": "application/json", "Prefer": "return=representation"},
        json={"sentences": base_sents, "meta": cur_meta}, timeout=15,
    )
    if r.status_code not in (200, 204):
        raise HTTPException(r.status_code, r.text[:300])
    rows = r.json() if r.status_code == 200 else []
    return {"refined": True, "key": target_key, "row": rows[0] if rows else None}


@app.get("/api/my-products/{pid}/scripts/{sid}/shares")
def list_script_shares(pid: int, sid: str, request: Request):
    me = auth_svc.require_user(request)
    _check_script_access(pid, sid, me, edit=False)
    SUPA = (os.getenv("SUPABASE_URL") or "").strip()
    SK = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    _r = supabase.get_session()
    H = {"apikey": SK, "Authorization": f"Bearer {SK}"}
    shares = _r.get(
        f"{SUPA}/rest/v1/generated_script_shares?script_id=eq.{sid}"
        f"&select=id,shared_with_id,shared_by,permission,created_at"
        f"&order=created_at.desc",
        headers=H, timeout=10,
    ).json() or []
    if shares:
        ids = list({s["shared_with_id"] for s in shares} | {s["shared_by"] for s in shares})
        ids_csv = ",".join(f'"{x}"' for x in ids)
        profiles = _r.get(
            f"{SUPA}/rest/v1/profiles?id=in.({ids_csv})&select=id,email,display_name",
            headers=H, timeout=10,
        ).json() or []
        by_id = {p["id"]: p for p in profiles}
        for s in shares:
            s["shared_with_email"] = (by_id.get(s["shared_with_id"]) or {}).get("email", "")
            s["shared_with_name"] = (by_id.get(s["shared_with_id"]) or {}).get("display_name", "")
            s["shared_by_email"] = (by_id.get(s["shared_by"]) or {}).get("email", "")
    return shares


@app.post("/api/my-products/{pid}/scripts/{sid}/shares")
def add_script_share(pid: int, sid: str, body: GenScriptShareIn, request: Request):
    me = auth_svc.require_user(request)
    row = _check_script_access(pid, sid, me, edit=False)
    # 작성자 또는 admin만 공유 추가 가능
    if me.get("role") != "admin" and row.get("created_by") != me["id"]:
        raise HTTPException(403, "공유 권한은 작성자만 부여할 수 있습니다")
    perm = body.permission if body.permission in ("view", "edit") else "view"
    SUPA = (os.getenv("SUPABASE_URL") or "").strip()
    SK = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    _r = supabase.get_session()
    H = {"apikey": SK, "Authorization": f"Bearer {SK}"}
    target_id = (body.shared_with_id or "").strip()
    if not target_id and body.email:
        email = body.email.strip().lower()
        target = _r.get(
            f"{SUPA}/rest/v1/profiles?email=eq.{email}&select=id&limit=1",
            headers=H, timeout=10,
        ).json() or []
        if not target:
            raise HTTPException(404, f"사용자 없음: {email}")
        target_id = target[0]["id"]
    if not target_id:
        raise HTTPException(400, "shared_with_id 또는 email 필요")
    if target_id == me["id"]:
        raise HTTPException(400, "본인에게는 공유할 수 없습니다")
    r = _r.post(
        f"{SUPA}/rest/v1/generated_script_shares?on_conflict=script_id,shared_with_id",
        headers={**H, "Content-Type": "application/json",
                 "Prefer": "resolution=merge-duplicates,return=representation"},
        json={
            "script_id": sid, "shared_with_id": target_id, "shared_by": me["id"],
            "permission": perm,
        }, timeout=10,
    )
    if r.status_code not in (200, 201):
        raise HTTPException(r.status_code, r.text[:300])
    _invalidate_my_scripts_cache()
    return r.json()[0] if r.json() else {}


@app.delete("/api/my-products/{pid}/scripts/{sid}/shares/{share_id}")
def delete_script_share(pid: int, sid: str, share_id: str, request: Request):
    me = auth_svc.require_user(request)
    row = _check_script_access(pid, sid, me, edit=False)
    if me.get("role") != "admin" and row.get("created_by") != me["id"]:
        raise HTTPException(403, "작성자만 공유를 제거할 수 있습니다")
    SUPA = (os.getenv("SUPABASE_URL") or "").strip()
    SK = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    _r = supabase.get_session()
    _r.delete(
        f"{SUPA}/rest/v1/generated_script_shares?id=eq.{share_id}&script_id=eq.{sid}",
        headers={"apikey": SK, "Authorization": f"Bearer {SK}", "Prefer": "return=minimal"},
        timeout=10,
    )
    _invalidate_my_scripts_cache()
    return {"deleted": True}


@app.get("/api/my-products/{pid}/scripts")
def list_gen_scripts(pid: int, request: Request):
    me = auth_svc.require_user(request)
    _check_product_access(pid, me, edit=False)
    SUPA = (os.getenv("SUPABASE_URL") or "").strip()
    SK = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    _r = supabase.get_session()
    H = {"apikey": SK, "Authorization": f"Bearer {SK}"}
    # 본인 created_by + 공유받은 대본 (해당 product에 한정)
    shares = _r.get(
        f"{SUPA}/rest/v1/generated_script_shares?shared_with_id=eq.{me['id']}&select=script_id",
        headers=H, timeout=10,
    ).json() or []
    shared_ids = [s["script_id"] for s in shares]
    if shared_ids:
        sids_csv = ",".join(f'"{x}"' for x in shared_ids)
        or_filter = f"or=(created_by.eq.{me['id']},id.in.({sids_csv}))"
    else:
        or_filter = f"created_by=eq.{me['id']}"
    r = _r.get(
        f"{SUPA}/rest/v1/generated_scripts?product_id=eq.{pid}&archived_at=is.null"
        f"&{or_filter}"
        f"&select=id,ref_shortcode,source_type,persona_name,title,meta,created_at,created_by"
        f"&order=created_at.desc",
        headers=H, timeout=10,
    )
    scripts = r.json() if r.status_code == 200 else []
    creator_ids = list({s["created_by"] for s in scripts if s.get("created_by")})
    if creator_ids:
        cids_csv = ",".join(f'"{x}"' for x in creator_ids)
        prof = _r.get(
            f"{SUPA}/rest/v1/profiles?id=in.({cids_csv})&select=id,email,display_name",
            headers=H, timeout=10,
        ).json() or []
        by_id = {p["id"]: p for p in prof}
        share_perm_by_sid = {x["script_id"]: x["permission"] for x in (shares or []) if isinstance(x, dict)}
        for s in scripts:
            cb = s.get("created_by")
            if cb in by_id:
                s["_creator_name"] = by_id[cb].get("display_name") or ""
                s["_creator_email"] = by_id[cb].get("email") or ""
            if cb != me["id"]:
                s["_shared"] = True
                s["_permission"] = share_perm_by_sid.get(s["id"], "view")
    return scripts


@app.get("/api/my-scripts")
def list_all_my_scripts(request: Request):
    """내가 owner이거나 공유받은 모든 상품의 저장 대본 통합."""
    me = auth_svc.require_user(request)
    cached = _cache_get(_my_scripts_cache, me["id"], _MY_SCRIPTS_CACHE_TTL)
    if cached is not None:
        return cached
    SUPA = (os.getenv("SUPABASE_URL") or "").strip()
    SK = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    _r = supabase.get_session()
    H = {"apikey": SK, "Authorization": f"Bearer {SK}"}

    # ── Phase 1: 독립 호출 병렬 ──
    # admin: my_products(전체) + generated_script_shares
    # 일반: my_products(own) + my_product_shares + generated_script_shares
    if me.get("role") == "admin":
        with ThreadPoolExecutor(max_workers=2) as ex:
            f_prod = ex.submit(
                _r.get,
                f"{SUPA}/rest/v1/my_products?select=id,name",
                headers=H, timeout=10,
            )
            f_script_shares = ex.submit(
                _r.get,
                f"{SUPA}/rest/v1/generated_script_shares?shared_with_id=eq.{me['id']}&select=script_id,permission",
                headers=H, timeout=10,
            )
        prod = f_prod.result().json() or []
        shares = f_script_shares.result().json() or []
    else:
        with ThreadPoolExecutor(max_workers=3) as ex:
            f_own = ex.submit(
                _r.get,
                f"{SUPA}/rest/v1/my_products?owner_id=eq.{me['id']}&select=id,name",
                headers=H, timeout=10,
            )
            f_prod_shares = ex.submit(
                _r.get,
                f"{SUPA}/rest/v1/my_product_shares?shared_with_id=eq.{me['id']}&select=product_id",
                headers=H, timeout=10,
            )
            f_script_shares = ex.submit(
                _r.get,
                f"{SUPA}/rest/v1/generated_script_shares?shared_with_id=eq.{me['id']}&select=script_id,permission",
                headers=H, timeout=10,
            )
        own = f_own.result().json() or []
        shared = f_prod_shares.result().json() or []
        shares = f_script_shares.result().json() or []
        shared_pids = [s["product_id"] for s in shared]
        extras = []
        if shared_pids:
            ids_csv = ",".join(str(x) for x in shared_pids)
            extras = _r.get(
                f"{SUPA}/rest/v1/my_products?id=in.({ids_csv})&select=id,name",
                headers=H, timeout=10,
            ).json() or []
        prod = list({p["id"]: p for p in (own + extras)}.values())

    shared_ids = [s["script_id"] for s in shares]
    perm_by_sid = {s["script_id"]: s["permission"] for s in shares}

    ids_csv = ",".join(str(p["id"]) for p in prod) if prod else "0"
    # 본인 (자기 prod 안) + 공유받은 (어느 prod든)
    if shared_ids:
        sids_csv = ",".join(f'"{x}"' for x in shared_ids)
        or_filter = f"or=(and(product_id.in.({ids_csv}),created_by.eq.{me['id']}),id.in.({sids_csv}))"
    else:
        or_filter = f"product_id=in.({ids_csv})&created_by=eq.{me['id']}"
    # 리스트 카드에서 실제 쓰는 meta 키는 status/group_name 둘뿐.
    # meta JSONB 전체(caption/pinned_comment/_cost/생성로그) 대신 필요한 키만 PostgREST JSON path로 뽑아 응답 크기 축소.
    scripts = _r.get(
        f"{SUPA}/rest/v1/generated_scripts?archived_at=is.null&{or_filter}"
        f"&select=id,product_id,ref_shortcode,source_type,persona_name,title,"
        f"_status:meta->>status,_group_name:meta->>group_name,"
        f"created_at,created_by"
        f"&order=created_at.desc",
        headers=H, timeout=15,
    ).json() or []
    # 클라이언트 호환 위해 meta 객체 재조립
    for s in scripts:
        s["meta"] = {"status": s.pop("_status", None), "group_name": s.pop("_group_name", None)}

    # ── Phase 3: 보충 호출 병렬 (extra products + creator profiles) ──
    prod_id_set = {p["id"] for p in prod}
    extra_pids = list({s["product_id"] for s in scripts if s["product_id"] not in prod_id_set})
    creator_ids = list({s["created_by"] for s in scripts if s.get("created_by")})

    extra_prod: list = []
    creator_by_id: dict[str, dict] = {}

    if extra_pids or creator_ids:
        with ThreadPoolExecutor(max_workers=2) as ex:
            f_extra = ex.submit(
                _r.get,
                f"{SUPA}/rest/v1/my_products?id=in.({','.join(str(x) for x in extra_pids)})&select=id,name",
                headers=H, timeout=10,
            ) if extra_pids else None
            f_prof = ex.submit(
                _r.get,
                f"{SUPA}/rest/v1/profiles?id=in.({','.join(chr(34)+x+chr(34) for x in creator_ids)})&select=id,email,display_name",
                headers=H, timeout=10,
            ) if creator_ids else None
        if f_extra is not None:
            extra_prod = f_extra.result().json() or []
        if f_prof is not None:
            creator_by_id = {p["id"]: p for p in (f_prof.result().json() or [])}

    if extra_prod:
        prod = list(prod) + extra_prod
    for s in scripts:
        cb = s.get("created_by")
        if cb and cb in creator_by_id:
            p = creator_by_id[cb]
            s["_creator_name"] = p.get("display_name") or ""
            s["_creator_email"] = p.get("email") or ""
        if cb != me["id"]:
            s["_shared"] = True
            s["_permission"] = perm_by_sid.get(s["id"], "view")
    result = {"products": prod, "scripts": scripts}
    return _cache_set(_my_scripts_cache, me["id"], result)


@app.get("/api/my-products/{pid}/scripts/{sid}")
def get_gen_script(pid: int, sid: str, request: Request):
    me = auth_svc.require_user(request)
    # 본인 created_by + 공유받은 사용자 + admin 허용
    row = _check_script_access(pid, sid, me, edit=False)
    cb = row.get("created_by")
    if cb:
        SUPA = (os.getenv("SUPABASE_URL") or "").strip()
        SK = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
        _r = supabase.get_session()
        prof = _r.get(
            f"{SUPA}/rest/v1/profiles?id=eq.{cb}&select=email,display_name&limit=1",
            headers={"apikey": SK, "Authorization": f"Bearer {SK}"}, timeout=10,
        ).json() or []
        if prof:
            row["_creator_name"] = prof[0].get("display_name") or ""
            row["_creator_email"] = prof[0].get("email") or ""
    return row


@app.delete("/api/my-products/{pid}/scripts/{sid}")
def delete_gen_script(pid: int, sid: str, request: Request):
    me = auth_svc.require_user(request)
    _check_product_access(pid, me, edit=True)
    SUPA = (os.getenv("SUPABASE_URL") or "").strip()
    SK = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    _r = supabase.get_session()
    # soft delete via archived_at — 본인이 만든 대본만 삭제 가능
    r = _r.patch(
        f"{SUPA}/rest/v1/generated_scripts?id=eq.{sid}&product_id=eq.{pid}"
        f"&created_by=eq.{me['id']}",
        headers={"apikey": SK, "Authorization": f"Bearer {SK}",
                 "Content-Type": "application/json", "Prefer": "return=minimal"},
        json={"archived_at": "now()"}, timeout=10,
    )
    if r.status_code not in (200, 204):
        raise HTTPException(r.status_code, r.text[:300])
    _invalidate_my_scripts_cache()
    return {"deleted": True}


@app.delete("/api/my-products/{pid}")
def delete_my_product(pid: int, request: Request):
    me = auth_svc.require_user(request)
    SUPA = (os.getenv("SUPABASE_URL") or "").strip()
    SK = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    _r = supabase.get_session()
    r = _r.delete(
        f"{SUPA}/rest/v1/my_products?id=eq.{pid}&owner_id=eq.{me['id']}",
        headers={"apikey": SK, "Authorization": f"Bearer {SK}", "Prefer": "return=minimal"},
        timeout=10,
    )
    return {"message": "삭제 완료"}


# ── My Products: 공유 ──

class ShareCreateRequest(BaseModel):
    user_ids: list[str]
    permission: str = "view"  # 'view' | 'edit'


def _assert_product_owner(pid: int, me_id: str) -> None:
    SUPA = (os.getenv("SUPABASE_URL") or "").strip()
    SK = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    _r = supabase.get_session()
    rows = _r.get(
        f"{SUPA}/rest/v1/my_products?id=eq.{pid}&select=owner_id",
        headers={"apikey": SK, "Authorization": f"Bearer {SK}"},
        timeout=10,
    ).json()
    if not rows:
        raise HTTPException(404, "상품 없음")
    if rows[0]["owner_id"] != me_id:
        raise HTTPException(403, "공유 관리는 소유자만 가능")


@app.get("/api/my-products/{pid}/shares")
def list_product_shares(pid: int, request: Request):
    """소유자: 이 상품을 누구에게 공유했는지 + 권한."""
    me = auth_svc.require_user(request)
    _assert_product_owner(pid, me["id"])
    SUPA = (os.getenv("SUPABASE_URL") or "").strip()
    SK = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    _r = supabase.get_session()
    H = {"apikey": SK, "Authorization": f"Bearer {SK}"}

    shares = _r.get(
        f"{SUPA}/rest/v1/my_product_shares?product_id=eq.{pid}"
        f"&select=shared_with_id,permission,created_at&order=created_at.desc",
        headers=H, timeout=10,
    ).json() or []

    if not shares:
        return []

    user_ids = [s["shared_with_id"] for s in shares]
    prof = _r.get(
        f"{SUPA}/rest/v1/profiles?id=in.({','.join(user_ids)})&select=id,email,display_name",
        headers=H, timeout=10,
    ).json() or []
    pmap = {p["id"]: p for p in prof}
    for s in shares:
        p = pmap.get(s["shared_with_id"]) or {}
        s["display_name"] = p.get("display_name") or (p.get("email") or "").split("@")[0]
        s["email"] = p.get("email")
    return shares


@app.post("/api/my-products/{pid}/shares")
def create_product_shares(pid: int, req: ShareCreateRequest, request: Request):
    me = auth_svc.require_user(request)
    _assert_product_owner(pid, me["id"])
    if req.permission not in ("view", "edit"):
        raise HTTPException(400, "permission must be view or edit")

    rows = [
        {"product_id": pid, "shared_with_id": uid, "permission": req.permission, "created_by": me["id"]}
        for uid in req.user_ids if uid and uid != me["id"]
    ]
    if not rows:
        return {"message": "변경 없음", "count": 0}

    SUPA = (os.getenv("SUPABASE_URL") or "").strip()
    SK = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    _r = supabase.get_session()
    r = _r.post(
        f"{SUPA}/rest/v1/my_product_shares?on_conflict=product_id,shared_with_id",
        headers={"apikey": SK, "Authorization": f"Bearer {SK}",
                 "Content-Type": "application/json",
                 "Prefer": "resolution=merge-duplicates,return=representation"},
        json=rows, timeout=10,
    )
    if r.status_code not in (200, 201):
        raise HTTPException(r.status_code, r.text[:200])
    _invalidate_my_products_cache()
    return {"message": f"{len(rows)}명에게 공유", "count": len(rows)}


@app.delete("/api/my-products/{pid}/shares/{user_id}")
def delete_product_share(pid: int, user_id: str, request: Request):
    me = auth_svc.require_user(request)
    _assert_product_owner(pid, me["id"])
    SUPA = (os.getenv("SUPABASE_URL") or "").strip()
    SK = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    _r = supabase.get_session()
    _r.delete(
        f"{SUPA}/rest/v1/my_product_shares?product_id=eq.{pid}&shared_with_id=eq.{user_id}",
        headers={"apikey": SK, "Authorization": f"Bearer {SK}", "Prefer": "return=minimal"},
        timeout=10,
    )
    return {"message": "공유 해제 완료"}


class UspGroupIn(BaseModel):
    name: str | None = None  # PATCH 부분 업데이트 허용
    color: str | None = None
    order_idx: int | None = None
    capability_out: str | None = None  # 이 그룹이 안 하는 것 (콤마 구분)


class UspGroupMembersIn(BaseModel):
    usp_indexes: list[int] = []  # 1-based, my_products.usps[]에서의 위치


@app.get("/api/my-products/{pid}/usp-groups")
def list_usp_groups(pid: int, request: Request):
    me = auth_svc.require_user(request)
    _check_product_access(pid, me, edit=False)
    SUPA = (os.getenv("SUPABASE_URL") or "").strip()
    SK = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    _r = supabase.get_session()
    H = {"apikey": SK, "Authorization": f"Bearer {SK}"}
    groups = _r.get(
        f"{SUPA}/rest/v1/usp_groups?product_id=eq.{pid}&select=*&order=order_idx.asc,created_at.asc",
        headers=H, timeout=10,
    ).json() or []
    members = _r.get(
        f"{SUPA}/rest/v1/usp_group_members?product_id=eq.{pid}&select=group_id,usp_index",
        headers=H, timeout=10,
    ).json() or []
    by_group: dict[str, list[int]] = {}
    for m in members:
        by_group.setdefault(m["group_id"], []).append(m["usp_index"])
    for g in groups:
        g["usp_indexes"] = sorted(by_group.get(g["id"], []))
    return groups


@app.post("/api/my-products/{pid}/usp-groups")
def create_usp_group(pid: int, body: UspGroupIn, request: Request):
    me = auth_svc.require_user(request)
    _check_product_access(pid, me, edit=True)
    SUPA = (os.getenv("SUPABASE_URL") or "").strip()
    SK = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    _r = supabase.get_session()
    name = (body.name or "").strip()
    if not name:
        raise HTTPException(400, "그룹 이름 필수")
    r = _r.post(
        f"{SUPA}/rest/v1/usp_groups",
        headers={"apikey": SK, "Authorization": f"Bearer {SK}",
                 "Content-Type": "application/json", "Prefer": "return=representation"},
        json={"product_id": pid, "name": name, "color": body.color,
              "order_idx": body.order_idx or 0, "created_by": me["id"],
              "capability_out": body.capability_out or None},
        timeout=10,
    )
    if r.status_code not in (200, 201):
        raise HTTPException(r.status_code, r.text[:300])
    return r.json()[0] if r.json() else {}


@app.patch("/api/my-products/{pid}/usp-groups/{gid}")
def update_usp_group(pid: int, gid: str, body: UspGroupIn, request: Request):
    me = auth_svc.require_user(request)
    _check_product_access(pid, me, edit=True)
    SUPA = (os.getenv("SUPABASE_URL") or "").strip()
    SK = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    _r = supabase.get_session()
    payload: dict = {}
    if body.name:
        payload["name"] = body.name.strip()
    if body.color is not None:
        payload["color"] = body.color or None
    if body.order_idx is not None:
        payload["order_idx"] = body.order_idx
    if body.capability_out is not None:
        payload["capability_out"] = body.capability_out.strip() or None
    if not payload:
        return {"updated": False}
    r = _r.patch(
        f"{SUPA}/rest/v1/usp_groups?id=eq.{gid}&product_id=eq.{pid}",
        headers={"apikey": SK, "Authorization": f"Bearer {SK}",
                 "Content-Type": "application/json", "Prefer": "return=minimal"},
        json=payload, timeout=10,
    )
    if r.status_code not in (200, 204):
        raise HTTPException(r.status_code, r.text[:300])
    return {"updated": True}


@app.delete("/api/my-products/{pid}/usp-groups/{gid}")
def delete_usp_group(pid: int, gid: str, request: Request):
    me = auth_svc.require_user(request)
    _check_product_access(pid, me, edit=True)
    SUPA = (os.getenv("SUPABASE_URL") or "").strip()
    SK = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    _r = supabase.get_session()
    _r.delete(
        f"{SUPA}/rest/v1/usp_groups?id=eq.{gid}&product_id=eq.{pid}",
        headers={"apikey": SK, "Authorization": f"Bearer {SK}", "Prefer": "return=minimal"},
        timeout=10,
    )
    return {"deleted": True}


@app.put("/api/my-products/{pid}/usp-groups/{gid}/members")
def set_usp_group_members(pid: int, gid: str, body: UspGroupMembersIn, request: Request):
    """그룹의 멤버 USP indexes를 통째 교체 (idempotent set)."""
    me = auth_svc.require_user(request)
    _check_product_access(pid, me, edit=True)
    SUPA = (os.getenv("SUPABASE_URL") or "").strip()
    SK = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    _r = supabase.get_session()
    H = {"apikey": SK, "Authorization": f"Bearer {SK}"}
    # 기존 멤버 모두 제거
    _r.delete(
        f"{SUPA}/rest/v1/usp_group_members?group_id=eq.{gid}&product_id=eq.{pid}",
        headers={**H, "Prefer": "return=minimal"}, timeout=10,
    )
    # 새 멤버 추가 (dedupe)
    unique_idxs = sorted({int(i) for i in body.usp_indexes if isinstance(i, int) and i >= 1})
    if unique_idxs:
        rows = [{"group_id": gid, "product_id": pid, "usp_index": i} for i in unique_idxs]
        _r.post(
            f"{SUPA}/rest/v1/usp_group_members",
            headers={**H, "Content-Type": "application/json", "Prefer": "return=minimal"},
            json=rows, timeout=10,
        )
    return {"count": len(unique_idxs)}


@app.get("/api/users/shareable")
def list_shareable_users(request: Request):
    """공유 대상 picker용 — 활성 사용자 (자기 제외). 일반 직원도 호출 가능."""
    me = auth_svc.require_user(request)
    cached = _cache_get(_shareable_users_cache, me["id"], 60)
    if cached is not None:
        return cached
    SUPA = (os.getenv("SUPABASE_URL") or "").strip()
    SK = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    _r = supabase.get_session()
    rows = _r.get(
        f"{SUPA}/rest/v1/profiles?active=eq.true"
        f"&select=id,email,display_name&order=display_name.asc.nullslast",
        headers={"apikey": SK, "Authorization": f"Bearer {SK}"},
        timeout=10,
    ).json() or []
    return _cache_set(_shareable_users_cache, me["id"], [u for u in rows if u["id"] != me["id"]])


# ── Auth ──

def _update_last_login(user_id: str) -> None:
    """응답을 막지 않도록 background에서 실행."""
    try:
        SUPA = (os.getenv("SUPABASE_URL") or "").strip()
        KEY = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_ANON_KEY") or "").strip()
        _r = supabase.get_session()
        _r.patch(
            f"{SUPA}/rest/v1/profiles?id=eq.{user_id}",
            headers={"apikey": KEY, "Authorization": f"Bearer {KEY}",
                     "Content-Type": "application/json", "Prefer": "return=minimal"},
            json={"last_login_at": datetime.now(timezone.utc).isoformat()},
            timeout=3,
        )
    except Exception:
        pass


@app.get("/api/me")
def get_me(request: Request, background_tasks: BackgroundTasks):
    """현재 로그인한 사용자 profile. last_login_at은 응답 후 background로 갱신."""
    profile = auth_svc.require_user(request)
    background_tasks.add_task(_update_last_login, profile["id"])
    return profile


@app.get("/api/admin/script-stats")
def admin_script_stats(request: Request, days: int = 30, metric: str = "saved"):
    """admin 전용: 사용자별 날짜별 대본 카운트.

    metric:
      - "saved" (default) — generated_scripts에 저장된 대본 (archived 제외)
      - "completed" — script_gen_events에 기록된 성공 generation (저장 안 해도 포함)

    Returns:
      [{user_id, display_name, email, total, by_date: {YYYY-MM-DD: N}}],
      date_range: [YYYY-MM-DD ...]
      metric: "saved" | "completed"
    """
    auth_svc.require_admin(request)
    days = max(1, min(int(days or 30), 180))
    metric = metric if metric in ("saved", "completed") else "saved"
    SUPA = (os.getenv("SUPABASE_URL") or "").strip()
    KEY = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    _r = supabase.get_session()
    H = {"apikey": KEY, "Authorization": f"Bearer {KEY}"}

    from datetime import datetime, timedelta, timezone
    from urllib.parse import quote
    now_kst = datetime.now(timezone.utc) + timedelta(hours=9)
    start_kst = (now_kst - timedelta(days=days - 1)).replace(hour=0, minute=0, second=0, microsecond=0)
    start_utc = (start_kst - timedelta(hours=9)).replace(tzinfo=None)
    # PostgREST는 timestamp의 + 부호를 URL에서 정확히 받으려면 encode 필요
    start_str = quote(start_utc.strftime("%Y-%m-%dT%H:%M:%S"), safe="")

    if metric == "completed":
        # script_gen_events 테이블 — success=true만 집계
        resp = _r.get(
            f"{SUPA}/rest/v1/script_gen_events?success=eq.true"
            f"&created_at=gte.{start_str}"
            f"&select=user_id,created_at"
            f"&order=created_at.asc",
            headers=H, timeout=15,
        )
    else:
        resp = _r.get(
            f"{SUPA}/rest/v1/generated_scripts?archived_at=is.null"
            f"&created_at=gte.{start_str}"
            f"&select=created_by,created_at"
            f"&order=created_at.asc",
            headers=H, timeout=15,
        )
    try:
        rows = resp.json()
    except Exception:
        rows = []
    if not isinstance(rows, list):
        logger.warning("[admin-script-stats] unexpected response: %s", str(rows)[:200])
        rows = []

    # 사용자별 + 날짜별 집계 (KST 기준)
    # metric=completed면 user_id 필드, saved면 created_by 필드
    user_field = "user_id" if metric == "completed" else "created_by"
    by_user: dict[str, dict] = {}
    for r in rows:
        cb = r.get(user_field)
        if not cb:
            continue
        ts = r.get("created_at") or ""
        try:
            t = datetime.fromisoformat(ts.replace("Z", "+00:00"))
            t_kst = t.astimezone(timezone(timedelta(hours=9)))
            date_key = t_kst.strftime("%Y-%m-%d")
        except Exception:
            continue
        u = by_user.setdefault(cb, {"user_id": cb, "total": 0, "by_date": {}})
        u["total"] += 1
        u["by_date"][date_key] = u["by_date"].get(date_key, 0) + 1

    # 사용자 프로필 join
    if by_user:
        ids_csv = ",".join(f'"{x}"' for x in by_user.keys())
        prof = _r.get(
            f"{SUPA}/rest/v1/profiles?id=in.({ids_csv})&select=id,display_name,email",
            headers=H, timeout=10,
        ).json() or []
        for p in prof:
            u = by_user.get(p["id"])
            if u:
                u["display_name"] = p.get("display_name") or ""
                u["email"] = p.get("email") or ""

    # 날짜 range (오늘부터 N일)
    date_range = []
    for i in range(days):
        d = (now_kst - timedelta(days=days - 1 - i)).strftime("%Y-%m-%d")
        date_range.append(d)

    users = sorted(by_user.values(), key=lambda u: u.get("total", 0), reverse=True)
    return {"date_range": date_range, "users": users, "metric": metric}


@app.get("/api/users/colleagues")
def list_colleagues(request: Request):
    """인증된 모든 사용자가 호출 가능 — 본인 제외 다른 사용자 minimal info (공유 등 dropdown용)."""
    me = auth_svc.require_user(request)
    SUPA = (os.getenv("SUPABASE_URL") or "").strip()
    KEY = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_ANON_KEY") or "").strip()
    _r = supabase.get_session()
    r = _r.get(
        f"{SUPA}/rest/v1/profiles?active=eq.true&select=id,display_name,email&order=display_name.asc",
        headers={"apikey": KEY, "Authorization": f"Bearer {KEY}"}, timeout=10,
    )
    rows = r.json() if r.status_code == 200 else []
    return [p for p in rows if p.get("id") != me["id"]]


@app.get("/api/users")
def list_users(request: Request):
    """admin: 전체 직원 목록."""
    auth_svc.require_admin(request)
    cached = _cache_get(_users_cache, "all", _USERS_CACHE_TTL)
    if cached is not None:
        return cached
    SUPA = (os.getenv("SUPABASE_URL") or "").strip()
    KEY = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_ANON_KEY") or "").strip()
    _r = supabase.get_session()
    r = _r.get(
        f"{SUPA}/rest/v1/profiles?select=id,email,display_name,role,active,can_delete_reels,created_at,last_login_at&order=created_at.desc",
        headers={"apikey": KEY, "Authorization": f"Bearer {KEY}"},
        timeout=15,
    )
    return _cache_set(_users_cache, "all", r.json() if r.status_code == 200 else [])


class UserInviteRequest(BaseModel):
    email: str
    display_name: str | None = None
    role: str = "employee"
    password: str | None = None  # 미입력 시 임시 비밀번호 자동 생성


@app.post("/api/users")
def invite_user(req: UserInviteRequest, request: Request):
    """admin: 신규 직원 계정 생성. Supabase Admin API로 사용자 생성 + email_confirmed=true."""
    inviter = auth_svc.require_admin(request)
    if req.role not in ("admin", "employee"):
        raise HTTPException(400, "role must be admin or employee")

    SUPA = (os.getenv("SUPABASE_URL") or "").strip()
    SK = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    if not SK:
        raise HTTPException(500, "SUPABASE_SERVICE_ROLE_KEY 필요")

    import secrets
    _r = supabase.get_session()
    pw = req.password or ("Tmp_" + secrets.token_urlsafe(12))

    # 1. auth user 생성 (admin API)
    create = _r.post(
        f"{SUPA}/auth/v1/admin/users",
        headers={"apikey": SK, "Authorization": f"Bearer {SK}", "Content-Type": "application/json"},
        json={"email": req.email, "password": pw, "email_confirm": True},
        timeout=15,
    )
    if create.status_code not in (200, 201):
        raise HTTPException(create.status_code, f"auth create failed: {create.text[:200]}")
    new_user = create.json()
    new_id = new_user.get("id")

    # 2. trigger가 profiles row를 만들었을 것 → role/display_name/created_by 업데이트
    patch = _r.patch(
        f"{SUPA}/rest/v1/profiles?id=eq.{new_id}",
        headers={"apikey": SK, "Authorization": f"Bearer {SK}",
                 "Content-Type": "application/json", "Prefer": "return=representation"},
        json={
            "role": req.role,
            "display_name": req.display_name,
            "created_by": inviter["id"],
        },
        timeout=10,
    )
    profile = patch.json()[0] if patch.status_code in (200, 201) and patch.json() else None
    _users_cache.clear()
    return {
        "message": f"{req.email} 초대 완료. 임시 비밀번호: {pw}",
        "profile": profile,
        "temp_password": pw,
    }


class UserUpdateRequest(BaseModel):
    role: str | None = None
    active: bool | None = None
    display_name: str | None = None
    can_delete_reels: bool | None = None


@app.patch("/api/users/{user_id}")
def update_user(user_id: str, req: UserUpdateRequest, request: Request):
    auth_svc.require_admin(request)
    payload: dict = {}
    if req.role is not None:
        if req.role not in ("admin", "employee"):
            raise HTTPException(400, "invalid role")
        payload["role"] = req.role
    if req.active is not None:
        payload["active"] = req.active
    if req.display_name is not None:
        payload["display_name"] = req.display_name
    if req.can_delete_reels is not None:
        payload["can_delete_reels"] = req.can_delete_reels
    if not payload:
        raise HTTPException(400, "nothing to update")

    SUPA = (os.getenv("SUPABASE_URL") or "").strip()
    SK = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_ANON_KEY") or "").strip()
    _r = supabase.get_session()
    r = _r.patch(
        f"{SUPA}/rest/v1/profiles?id=eq.{user_id}",
        headers={"apikey": SK, "Authorization": f"Bearer {SK}",
                 "Content-Type": "application/json", "Prefer": "return=representation"},
        json=payload, timeout=10,
    )
    if r.status_code not in (200, 204):
        raise HTTPException(r.status_code, r.text[:200])
    _users_cache.clear()
    return r.json()[0] if r.json() else {}


@app.delete("/api/users/{user_id}")
def delete_user(user_id: str, request: Request):
    """admin: auth.users 삭제 → trigger로 profiles도 cascade."""
    admin = auth_svc.require_admin(request)
    if user_id == admin["id"]:
        raise HTTPException(400, "자기 자신은 삭제할 수 없습니다")
    SUPA = (os.getenv("SUPABASE_URL") or "").strip()
    SK = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    if not SK:
        raise HTTPException(500, "SUPABASE_SERVICE_ROLE_KEY 필요")
    _r = supabase.get_session()
    r = _r.delete(
        f"{SUPA}/auth/v1/admin/users/{user_id}",
        headers={"apikey": SK, "Authorization": f"Bearer {SK}"},
        timeout=15,
    )
    if r.status_code not in (200, 204):
        raise HTTPException(r.status_code, r.text[:200])
    return {"message": "삭제 완료"}


# ── Data Endpoints ──

def _infer_frame_count(shortcode: str) -> int:
    """Return expected frame count, falling back to frame analysis timestamps."""
    meta = supabase.sb_get("reels_metadata", f"shortcode=eq.{shortcode}&select=video_duration&limit=1")
    duration = int(meta[0].get("video_duration") or 0) if meta else 0
    if duration > 0:
        return duration

    rows = supabase.sb_get("opus_analyses", f"shortcode=eq.{shortcode}&select=analysis&limit=1")
    analysis = rows[0].get("analysis") if rows else ""
    if not analysis:
        return 0

    secs = [
        int(match.group(1))
        for match in re.finditer(r"\[(\d+)\s*(?:sec|\uCD08)?\]", analysis, flags=re.IGNORECASE)
    ]
    if not secs:
        return 0
    return max(secs) + 1


def _storage_frame_images(shortcode: str) -> dict:
    rows = supabase.storage_list("frames", shortcode)
    frames = {}
    base = f"{supabase.SUPABASE_URL}/storage/v1/object/public/frames/{shortcode}"
    for row in rows:
        name = str(row.get("name") or "")
        stem = name.rsplit(".", 1)[0]
        if not (name.lower().endswith(".webp") or name.lower().endswith(".jpg")) or not stem.isdigit():
            continue
        sec = int(stem)
        # webp 우선
        if sec not in frames or name.lower().endswith(".webp"):
            frames[sec] = f"{base}/{name}"
    return dict(sorted(frames.items()))


def _frame_image_urls(shortcode: str) -> dict:
    storage_frames = _storage_frame_images(shortcode)
    if storage_frames:
        return storage_frames

    count = _infer_frame_count(shortcode)
    if count <= 0:
        return {}
    base = f"{supabase.SUPABASE_URL}/storage/v1/object/public/frames/{shortcode}"
    return {sec: f"{base}/{sec}.webp" for sec in range(1, count + 1)}


@app.get("/api/reels")
def get_reels():
    rows = supabase.sb_get("reels", "select=shortcode,url,account_category,collected_at&order=collected_at.desc&limit=100")
    return Response(
        content=__import__("json").dumps(rows),
        media_type="application/json",
        headers={"Cache-Control": "private, max-age=30"},  # private: CDN cache X, 인증 우회 방지
    )


@app.get("/api/metadata")
def get_all_metadata(page: int = 1, limit: int = 200):
    """페이징 지원. limit 최대 1000."""
    limit = min(max(1, limit), 1000)
    page = max(1, page)
    offset = (page - 1) * limit
    rows = supabase.sb_get(
        "reels_metadata",
        f"select=shortcode,play_count,like_count,comment_count,video_duration,"
        f"thumbnail_url,video_url,caption_text,author_username,author_full_name,"
        f"music_artist,music_title,taken_at"
        f"&order=taken_at.desc.nullslast&limit={limit}&offset={offset}",
    )
    return Response(
        content=__import__("json").dumps(rows),
        media_type="application/json",
        headers={
            "Cache-Control": "private, max-age=60",
            "X-Page": str(page),
            "X-Limit": str(limit),
            "X-Count": str(len(rows)),
        },
    )


@app.get("/api/metadata/{shortcode}")
def get_metadata(shortcode: str):
    rows = supabase.sb_get("reels_metadata", f"shortcode=eq.{shortcode}&limit=1")
    if rows:
        return rows[0]
    raise HTTPException(404, "Not found")


@app.get("/api/transcripts")
def get_all_transcripts():
    return supabase.sb_get("reels_transcripts", "select=shortcode,transcript,language&limit=10000")


@app.get("/api/transcripts/{shortcode}")
def get_transcript(shortcode: str):
    rows = supabase.sb_get("reels_transcripts", f"shortcode=eq.{shortcode}&limit=1")
    if rows:
        return rows[0]
    raise HTTPException(404, "Not found")


@app.get("/api/analyses")
def get_all_analyses():
    db = supabase.sb_get("opus_analyses", "select=shortcode,analysis,analyzed_at&limit=10000")
    db_codes = {r["shortcode"] for r in db}
    for sc, data in pipeline.analysis_cache.items():
        if sc not in db_codes:
            db.append(data)
    return db


@app.get("/api/analyses/{shortcode}")
def get_analysis(shortcode: str):
    rows = supabase.sb_get("opus_analyses", f"shortcode=eq.{shortcode}&limit=1")
    if rows:
        return rows[0]
    if shortcode in pipeline.analysis_cache:
        return pipeline.analysis_cache[shortcode]
    raise HTTPException(404, "Not found")


@app.get("/api/comments/{shortcode}")
def get_comments(shortcode: str):
    return supabase.sb_get("reels_comments", f"shortcode=eq.{shortcode}&limit=500")


_detail_cache: dict[str, tuple[float, dict]] = {}
_DETAIL_CACHE_TTL = 60


@app.get("/api/extra/{shortcode}")
def get_extra(shortcode: str, request: Request):
    # ?_t=... 또는 ?fresh=1 → 캐시 무시 + 응답 캐시 헤더 no-store
    qp = dict(request.query_params)
    fresh = bool(qp.get("_t") or qp.get("fresh"))
    data = {} if fresh else (pipeline.extra_cache.get(shortcode, {}) or {})
    # 캐시에 없는 항목들을 병렬 DB 조회 (5개 → ~0.5s)
    need_category = not data.get("category")
    # script_structure가 있어도 overall.section_chunks 누락이면 re-fetch (구 캐시 파일 보정)
    _ss = data.get("script_structure") or {}
    _ov = (_ss.get("overall") if isinstance(_ss, dict) else None) or {}
    _has_chunks_in_cache = bool(_ov.get("section_chunks"))
    need_script = not data.get("script_structure") or not _has_chunks_in_cache
    need_comments = not data.get("comment_triggers")
    need_audio = not data.get("pro_audio") and not data.get("audio_emotions")
    need_sentences = not data.get("sentences")
    need_frames = not data.get("frame_images")

    tasks = {}
    with ThreadPoolExecutor(max_workers=6) as ex:
        if need_category:
            tasks["category"] = ex.submit(supabase.sb_get, "reels_category",
                f"shortcode=eq.{shortcode}&limit=1")
        if need_script:
            tasks["script"] = ex.submit(supabase.sb_get, "reels_script_structure",
                f"shortcode=eq.{shortcode}&limit=1")
        if need_comments:
            tasks["comments"] = ex.submit(supabase.sb_get, "reels_comment_analysis",
                f"shortcode=eq.{shortcode}&limit=1")
        if need_audio:
            tasks["audio"] = ex.submit(supabase.sb_get, "reels_pro_audio",
                f"shortcode=eq.{shortcode}&select=audio_emotions,pro_audio,bgm_changes&limit=1")
        if need_sentences:
            tasks["sentences"] = ex.submit(supabase.sb_get, "reels_transcripts",
                f"shortcode=eq.{shortcode}&select=segments&limit=1")
        if need_frames:
            tasks["meta_dur"] = ex.submit(supabase.sb_get, "reels_metadata",
                f"shortcode=eq.{shortcode}&select=video_duration&limit=1")

    if "category" in tasks:
        rows = tasks["category"].result()
        if rows:
            r = rows[0]
            data["category"] = {"topic": r.get("topic"), "topic_detail": r.get("topic_detail"),
                                "style": r.get("style"), "tags": r.get("tags")}
    if "script" in tasks:
        rows = tasks["script"].result()
        if rows:
            r = rows[0]
            data["script_structure"] = {"hook": r.get("hook"), "intro": r.get("intro"),
                                        "body": r.get("body"), "cta": r.get("cta"), "overall": r.get("overall")}
    if "comments" in tasks:
        rows = tasks["comments"].result()
        if rows:
            data["comment_triggers"] = {"triggers": rows[0].get("triggers"), "summary": rows[0].get("summary")}
    if "audio" in tasks:
        rows = tasks["audio"].result()
        if rows:
            r = rows[0]
            if r.get("pro_audio"):
                data["pro_audio"] = r["pro_audio"]
            if r.get("audio_emotions"):
                data["audio_emotions"] = r["audio_emotions"]
            if r.get("bgm_changes"):
                data["bgm_changes"] = r["bgm_changes"]
    if "sentences" in tasks:
        rows = tasks["sentences"].result()
        if rows and rows[0].get("segments"):
            segs = rows[0]["segments"]
            data["sentences"] = segs
            sc_by_sec = {}
            for seg in segs:
                start = int(seg.get("start", 0))
                end = int(seg.get("end", start + 1))
                text = seg.get("text", "")
                for s in range(start + 1, end + 2):
                    if s not in sc_by_sec:
                        sc_by_sec[s] = text
            data["script_by_sec"] = sc_by_sec
    if "meta_dur" in tasks:
        frame_images = _frame_image_urls(shortcode)
        if frame_images:
            data["frame_images"] = frame_images
    return Response(
        content=__import__("json").dumps(data),
        media_type="application/json",
        headers={"Cache-Control": "no-store" if fresh else "private, max-age=300"},
    )


@app.get("/api/detail/{shortcode}")
def get_detail(shortcode: str):
    cached = _cache_get(_detail_cache, shortcode, _DETAIL_CACHE_TTL)
    if cached is not None:
        return cached
    result: dict = {}
    with ThreadPoolExecutor(max_workers=3) as ex:
        tasks = {
            "metadata": ex.submit(supabase.sb_get, "reels_metadata", f"shortcode=eq.{shortcode}&limit=1"),
            "transcript": ex.submit(supabase.sb_get, "reels_transcripts", f"shortcode=eq.{shortcode}&limit=1"),
            "analysis": ex.submit(supabase.sb_get, "opus_analyses", f"shortcode=eq.{shortcode}&limit=1"),
        }
    meta = tasks["metadata"].result() or []
    transcript = tasks["transcript"].result() or []
    analysis = tasks["analysis"].result() or []
    result["metadata"] = meta[0] if meta else None
    result["transcript"] = transcript[0] if transcript else None
    result["analysis"] = (analysis[0] if analysis else pipeline.analysis_cache.get(shortcode))
    result["comments"] = []
    result["extra"] = {}
    result["frame_images"] = {}
    return _cache_set(_detail_cache, shortcode, result)


@app.get("/api/frame-images/{shortcode}")
def get_frame_images(shortcode: str):
    """Return frame images as {sec: url} from Supabase Storage. HEAD 체크 없이 URL만 구성 (브라우저가 404 처리)."""
    result = _frame_image_urls(shortcode)
    # video_duration만 조회해서 URL 일괄 생성 (HEAD 생략)
    if result:
        return Response(
            content=__import__("json").dumps(result),
            media_type="application/json",
            headers={"Cache-Control": "private, max-age=3600"},
        )
    # 로컬 / in-memory 폴백 (분석 중인 경우)
    from pathlib import Path
    frames_dir = Path(__file__).parent.parent / "frames" / shortcode
    if frames_dir.exists():
        import base64
        result = {}
        for f in sorted(frames_dir.glob("*.jpg")):
            sec = int(f.stem)
            result[sec] = base64.b64encode(f.read_bytes()).decode()
        if result:
            return result
    status = pipeline.analysis_status.get(shortcode, {})
    if status.get("status") == "done" and "frame_images" in status:
        return status["frame_images"]
    return {}


# ── Bench cache (in-memory, background refresh) ──


_BENCH_CACHE_TTL = 120  # seconds
_bench_mem: dict = {"data": None, "ts": 0.0}
_bench_lock = threading.Lock()
_bench_refreshing = False
_phrases_cache: dict[str, tuple[float, dict]] = {}
_PHRASES_CACHE_TTL = 60


def _refresh_bench():
    """Fetch from Supabase, build merged list, store in module-level dict."""
    global _bench_refreshing
    try:
        with ThreadPoolExecutor(max_workers=6) as ex:
            f_reels = ex.submit(supabase.sb_get, "reels",
                "select=shortcode,url,account_category,collected_at&order=collected_at.desc&limit=50000")
            f_meta = ex.submit(supabase.sb_get, "reels_metadata",
                "select=shortcode,play_count,like_count,comment_count,video_duration,thumbnail_url,author_username,taken_at&limit=50000")
            f_opus = ex.submit(supabase.sb_get, "opus_analyses",
                "select=shortcode&limit=50000")
            f_class = ex.submit(supabase.sb_get, "reels_pro_audio",
                "select=shortcode,classification&limit=50000")
            f_cat = ex.submit(supabase.sb_get, "reels_category",
                "select=shortcode,topic,topic_detail,style,tags&limit=50000")
            f_ss = ex.submit(supabase.sb_get, "reels_script_structure",
                "select=shortcode,overall&limit=50000")

        reels = f_reels.result()
        meta_map = {m["shortcode"]: m for m in f_meta.result()}
        analysis_scs = {a["shortcode"] for a in f_opus.result()}
        class_map = {r["shortcode"]: (r.get("classification") or {}) for r in f_class.result()}
        cat_map = {c["shortcode"]: c for c in f_cat.result()}
        ss_map = {s["shortcode"]: (s.get("overall") or {}) for s in f_ss.result()}

        items = []
        total_plays = total_likes = 0
        for r in reels:
            sc = r["shortcode"]
            if sc.startswith("fb_"):
                continue
            m = meta_map.get(sc, {})
            plays = m.get("play_count") or 0
            likes = m.get("like_count") or 0
            total_plays += plays
            total_likes += likes
            cls = class_map.get(r["shortcode"]) or {}
            cat = cat_map.get(r["shortcode"]) or {}
            ss = ss_map.get(r["shortcode"]) or {}
            items.append({
                "shortcode": r["shortcode"],
                "author": m.get("author_username") or "",
                "play_count": plays,
                "like_count": likes,
                "comment_count": m.get("comment_count") or 0,
                "thumbnail_url": m.get("thumbnail_url") or "",
                "collected_at": r.get("collected_at") or "",
                "analyzed": r["shortcode"] in analysis_scs,
                "ad_suitability": cls.get("ad_suitability") or None,
                "usp_count": cls.get("usp_count") or None,
                "body_structure": cls.get("body_structure") or None,
                "hook_type": cls.get("hook_type") or None,
                "cta_type": cls.get("cta_type") or None,
                # 카테고리 (reels_category 조인)
                "topic": cat.get("topic"),
                "topic_detail": cat.get("topic_detail"),
                "style": cat.get("style"),
                "tags": cat.get("tags") or [],
                # 광고 포맷 + 적합성 (script_structure.overall)
                "ad_format": ss.get("ad_format"),
                "ad_suitability_score": ss.get("ad_suitability_score"),
            })

        with _bench_lock:
            _bench_mem["data"] = {
                "items": items,
                "stats": {
                    "total_reels": len(items),
                    "total_plays": total_plays,
                    "total_likes": total_likes,
                    "analyzed_count": len(analysis_scs),
                },
            }
            _bench_mem["ts"] = time.time()
        logger.info(f"[BenchCache] refreshed {len(items)} items")
        # trigger thumbnail download for missing ones
        thumb_items = [(i["shortcode"], i["thumbnail_url"]) for i in items if i["thumbnail_url"]]
        threading.Thread(target=thumb.download_batch, args=(thumb_items,), daemon=True).start()
    except Exception as e:
        logger.error(f"[BenchCache] refresh failed: {e}")
    finally:
        _bench_refreshing = False


def _get_bench() -> dict:
    global _bench_refreshing
    now = time.time()
    if _bench_mem["data"] is None:
        _refresh_bench()
    elif now - _bench_mem["ts"] > _BENCH_CACHE_TTL and not _bench_refreshing:
        _bench_refreshing = True
        threading.Thread(target=_refresh_bench, daemon=True).start()
    with _bench_lock:
        return _bench_mem["data"]


# Warm on module import (works with --reload)
threading.Thread(target=_refresh_bench, daemon=True).start()


def _er(i: dict) -> float:
    return round(i["like_count"] / i["play_count"] * 100, 2) if i["play_count"] else 0


def _filter_and_sort_bench(
    items: list, *,
    sort: str = "plays",
    q: str = "", plays_min: int = 0, plays_max: int = 0,
    er_min: float = 0, er_max: float = 0,
    date_from: str = "", date_to: str = "",
    ad_suitability: str = "", usp_count: str = "",
    body_structure: str = "", hook_type: str = "", cta_type: str = "",
) -> list:
    """벤치 캐시에서 가져온 items에 필터·정렬 일괄 적용."""
    if q:
        ql = q.lower()
        items = [i for i in items if ql in i["shortcode"].lower() or ql in i["author"].lower()]
    if plays_min > 0:
        items = [i for i in items if i["play_count"] >= plays_min]
    if plays_max > 0:
        items = [i for i in items if i["play_count"] <= plays_max]
    if er_min > 0:
        items = [i for i in items if _er(i) >= er_min]
    if er_max > 0:
        items = [i for i in items if _er(i) <= er_max]
    if date_from:
        items = [i for i in items if i["collected_at"][:10] >= date_from]
    if date_to:
        items = [i for i in items if i["collected_at"][:10] <= date_to]

    def _multi(field: str, val: str, current: list):
        opts = [v.strip() for v in val.split(",") if v.strip()]
        return [i for i in current if i.get(field) in opts]
    if ad_suitability:
        items = _multi("ad_suitability", ad_suitability, items)
    if usp_count:
        opts = [int(v) for v in usp_count.split(",") if v.strip().isdigit()]
        items = [i for i in items if i.get("usp_count") in opts]
    if body_structure:
        items = _multi("body_structure", body_structure, items)
    if hook_type:
        items = _multi("hook_type", hook_type, items)
    if cta_type:
        items = _multi("cta_type", cta_type, items)

    if sort == "plays":
        items = sorted(items, key=lambda i: i["play_count"], reverse=True)
    elif sort == "likes":
        items = sorted(items, key=lambda i: i["like_count"], reverse=True)
    elif sort == "er":
        items = sorted(items, key=lambda i: _er(i), reverse=True)
    elif sort == "recent":
        items = sorted(items, key=lambda i: i["collected_at"], reverse=True)
    return items


@app.get("/api/bench")
def get_bench(
    page: int = Query(1, ge=1),
    limit: int = Query(30, ge=1, le=100),
    sort: str = Query("plays"),
    q: str = Query(""),
    plays_min: int = Query(0, ge=0),
    plays_max: int = Query(0, ge=0),
    er_min: float = Query(0, ge=0),
    er_max: float = Query(0, ge=0),
    date_from: str = Query(""),
    date_to: str = Query(""),
    ad_suitability: str = Query(""),
    usp_count: str = Query(""),
    body_structure: str = Query(""),
    hook_type: str = Query(""),
    cta_type: str = Query(""),
):
    cache = _get_bench()
    if not cache:
        return {"items": [], "stats": {}, "total": 0, "page": 1, "has_more": False}
    stats = cache["stats"]
    items = _filter_and_sort_bench(
        list(cache["items"]),
        sort=sort, q=q,
        plays_min=plays_min, plays_max=plays_max,
        er_min=er_min, er_max=er_max,
        date_from=date_from, date_to=date_to,
        ad_suitability=ad_suitability, usp_count=usp_count,
        body_structure=body_structure, hook_type=hook_type, cta_type=cta_type,
    )

    total = len(items)
    start = (page - 1) * limit
    page_items = items[start:start + limit]

    return Response(
        content=__import__("json").dumps({
            "items": page_items,
            "stats": stats,
            "total": total,
            "page": page,
            "has_more": start + limit < total,
        }),
        media_type="application/json",
        headers={"Cache-Control": "private, max-age=30"},
    )


@app.get("/api/phrases")
def get_phrases(
    part: str = Query("hook_intro"),  # 'hook_intro' | 'cta'
    page: int = Query(1, ge=1),
    limit: int = Query(30, ge=1, le=100),
    sort: str = Query("plays"),
    q: str = Query(""),
    plays_min: int = Query(0, ge=0),
    plays_max: int = Query(0, ge=0),
    er_min: float = Query(0, ge=0),
    er_max: float = Query(0, ge=0),
    date_from: str = Query(""),
    date_to: str = Query(""),
    ad_suitability: str = Query(""),
    usp_count: str = Query(""),
    body_structure: str = Query(""),
    hook_type: str = Query(""),
    cta_type: str = Query(""),
):
    """문구별 보기 — bench와 동일 필터 + part(hook_intro|cta)별 텍스트."""
    if part not in ("hook_intro", "cta"):
        raise HTTPException(400, "part must be hook_intro or cta")
    cache_key = "|".join(map(str, [
        part, page, limit, sort, q, plays_min, plays_max, er_min, er_max,
        date_from, date_to, ad_suitability, usp_count, body_structure, hook_type, cta_type,
    ]))
    cached = _cache_get(_phrases_cache, cache_key, _PHRASES_CACHE_TTL)
    if cached is not None:
        return cached

    cache = _get_bench()
    if not cache:
        return {"items": [], "total": 0, "page": 1, "has_more": False}

    items = _filter_and_sort_bench(
        list(cache["items"]),
        sort=sort, q=q,
        plays_min=plays_min, plays_max=plays_max,
        er_min=er_min, er_max=er_max,
        date_from=date_from, date_to=date_to,
        ad_suitability=ad_suitability, usp_count=usp_count,
        body_structure=body_structure, hook_type=hook_type, cta_type=cta_type,
    )
    # 분석된 릴스만 (script_structure가 있을 수 있는 후보)
    items = [i for i in items if i.get("analyzed")]

    total_pre = len(items)
    # 페이지 단위로 잘라서 script_structure 조회 (효율)
    start = (page - 1) * limit
    page_items = items[start:start + limit]
    if not page_items:
        return {"items": [], "total": 0, "page": page, "has_more": False}

    scs = [i["shortcode"] for i in page_items]
    select = "shortcode," + ("hook,intro" if part == "hook_intro" else "cta")
    rows = supabase.sb_get(
        "reels_script_structure",
        f"shortcode=in.({','.join(scs)})&select={select}",
    ) or []
    by_sc = {r["shortcode"]: r for r in rows}

    out = []
    for i in page_items:
        rec = by_sc.get(i["shortcode"]) or {}
        if part == "hook_intro":
            hook = rec.get("hook") or {}
            intro = rec.get("intro") or {}
            hook_text = (hook.get("text") or "").strip()
            intro_text = (intro.get("text") or "").strip()
            if not hook_text and not intro_text:
                continue
            out.append({
                "shortcode": i["shortcode"],
                "author": i["author"],
                "play_count": i["play_count"],
                "like_count": i["like_count"],
                "thumbnail_url": i.get("thumbnail_url") or "",
                "hook_text": hook_text,
                "hook_type": hook.get("type") or "",
                "hook_seconds": hook.get("seconds") or "",
                "intro_text": intro_text,
                "intro_seconds": intro.get("seconds") or "",
            })
        else:
            cta = rec.get("cta") or {}
            cta_text = (cta.get("text") or "").strip()
            if not cta_text:
                continue
            out.append({
                "shortcode": i["shortcode"],
                "author": i["author"],
                "play_count": i["play_count"],
                "like_count": i["like_count"],
                "thumbnail_url": i.get("thumbnail_url") or "",
                "cta_text": cta_text,
                "cta_type": cta.get("type") or "",
                "cta_seconds": cta.get("seconds") or "",
            })

    result = {
        "items": out,
        "total": total_pre,
        "page": page,
        "has_more": start + limit < total_pre,
    }
    return _cache_set(_phrases_cache, cache_key, result)


@app.get("/api/ads")
def get_ads(
    page: int = Query(1, ge=1),
    limit: int = Query(30, ge=1, le=100),
    q: str = Query(""),
    date_from: str = Query(""),
    date_to: str = Query(""),
    sort: str = Query("recent"),  # 'recent' | 'oldest'
):
    """페이스북 라이브러리에서 수집된 광고 — reels(source=fb_ad) + reels_metadata 머지."""
    SUPA = (os.getenv("SUPABASE_URL") or "").strip()
    SK = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    H = {"apikey": SK, "Authorization": f"Bearer {SK}"}
    _r = supabase.get_session()

    with ThreadPoolExecutor(max_workers=2) as ex:
        f_reels = ex.submit(
            _r.get,
            f"{SUPA}/rest/v1/reels?source=eq.fb_ad"
            f"&select=shortcode,url,collected_at"
            f"&order=collected_at.desc&limit=2000",
            headers=H, timeout=10,
        )
        f_meta = ex.submit(
            _r.get,
            f"{SUPA}/rest/v1/reels_metadata?shortcode=like.fb_*"
            f"&select=shortcode,video_url,video_duration,thumbnail_url,caption_text,author_username"
            f"&limit=2000",
            headers=H, timeout=10,
        )

    reels = f_reels.result().json() or []
    meta_map = {m["shortcode"]: m for m in (f_meta.result().json() or [])}

    items = []
    for r in reels:
        sc = r["shortcode"]
        m = meta_map.get(sc, {})
        video_url = m.get("video_url") or ""
        if not video_url:
            continue  # 영상 광고만
        items.append({
            "shortcode": sc,
            "url": r.get("url") or "",
            "page_name": m.get("author_username") or "",
            "caption": m.get("caption_text") or "",
            "video_url": video_url,
            "video_duration": m.get("video_duration") or 0,
            "thumbnail_url": m.get("thumbnail_url") or "",
            "collected_at": r.get("collected_at") or "",
            # 향후 facebook ads 프로젝트 ads 테이블 연결 시 채워질 필드
            "start_date": "",
            "media_type": "video",
            "platforms": [],
        })

    # 검색 (광고주 또는 caption)
    if q:
        ql = q.lower()
        items = [i for i in items
                 if ql in (i["page_name"] or "").lower() or ql in (i["caption"] or "").lower()]

    # 기간 필터 (collected_at 기준 — start_date가 없으니)
    if date_from:
        items = [i for i in items if (i["collected_at"] or "")[:10] >= date_from]
    if date_to:
        items = [i for i in items if (i["collected_at"] or "")[:10] <= date_to]

    # 정렬
    items.sort(key=lambda i: i["collected_at"] or "", reverse=(sort != "oldest"))

    total = len(items)
    start = (page - 1) * limit
    page_items = items[start:start + limit]

    return {
        "items": page_items,
        "total": total,
        "page": page,
        "has_more": start + limit < total,
    }


_REEL_CHILD_TABLES = [
    "reels_pro_audio",
    "reels_comment_analysis",
    "reels_script_structure",
    "reels_category",
    "reels_comments",
    "reels_transcripts",
    "reels_metadata",
    "opus_analyses",
]


def _is_valid_shortcode(sc: str) -> bool:
    return bool(sc) and sc.replace("_", "").replace("-", "").isalnum()


def _delete_one_reel(shortcode: str) -> bool:
    """자식 8개 테이블 병렬 삭제 → 모두 끝나면 부모 삭제."""
    with ThreadPoolExecutor(max_workers=len(_REEL_CHILD_TABLES)) as ex:
        futures = [ex.submit(supabase.sb_delete, t, f"shortcode=eq.{shortcode}") for t in _REEL_CHILD_TABLES]
        for fut, t in zip(futures, _REEL_CHILD_TABLES):
            try:
                fut.result()
            except Exception as e:
                logger.warning(f"[DeleteReel] {t} for {shortcode}: {e}")
    return supabase.sb_delete("reels", f"shortcode=eq.{shortcode}")


@app.delete("/api/reels/{shortcode}")
def delete_reel(shortcode: str, request: Request):
    """admin 또는 can_delete_reels 권한자: 릴스 + 모든 자식 테이블 정리."""
    auth_svc.require_can_delete_reels(request)
    if not _is_valid_shortcode(shortcode):
        raise HTTPException(400, "invalid shortcode")
    if not _delete_one_reel(shortcode):
        raise HTTPException(500, "릴스 삭제 실패")
    _bench_mem["ts"] = 0
    return {"message": f"{shortcode} 삭제 완료"}


class BulkDeleteRequest(BaseModel):
    shortcodes: list[str]


@app.post("/api/reels/bulk-delete")
def bulk_delete_reels(req: BulkDeleteRequest, request: Request):
    """다량 삭제 — admin OR can_delete_reels. 릴스 단위로 병렬 처리."""
    auth_svc.require_can_delete_reels(request)
    valid = [sc for sc in (req.shortcodes or []) if _is_valid_shortcode(sc)]
    if not valid:
        raise HTTPException(400, "삭제할 shortcode가 없습니다")
    if len(valid) > 100:
        raise HTTPException(400, "한 번에 100개 이하로 요청하세요")

    deleted: list[str] = []
    failed: list[str] = []
    # 동시 8개씩 — Vercel 타임아웃 방지
    with ThreadPoolExecutor(max_workers=8) as ex:
        future_map = {ex.submit(_delete_one_reel, sc): sc for sc in valid}
        for fut, sc in future_map.items():
            try:
                ok = fut.result()
                (deleted if ok else failed).append(sc)
            except Exception as e:
                logger.warning(f"[BulkDelete] {sc}: {e}")
                failed.append(sc)
    _bench_mem["ts"] = 0
    return {"deleted": deleted, "failed": failed, "deleted_count": len(deleted), "failed_count": len(failed)}


# ── Dashboard (legacy, kept for other pages) ──

_dashboard_cache: dict = {"data": None, "ts": 0}
_DASHBOARD_TTL = 120

@app.get("/api/dashboard")
def get_dashboard():
    now = time.time()
    if _dashboard_cache["data"] and now - _dashboard_cache["ts"] < _DASHBOARD_TTL:
        return _dashboard_cache["data"]

    with ThreadPoolExecutor(max_workers=4) as ex:
        f_reels = ex.submit(supabase.sb_get, "reels", "select=shortcode,url,account_category,collected_at&order=collected_at.desc&limit=100")
        f_meta = ex.submit(supabase.sb_get, "reels_metadata", "select=shortcode,play_count,like_count,comment_count,video_duration,thumbnail_url,video_url,caption_text,author_username,music_artist,music_title,taken_at&limit=10000")
        f_trans = ex.submit(supabase.sb_get, "reels_transcripts", "select=shortcode,transcript,language&limit=10000")
        f_opus = ex.submit(supabase.sb_get, "opus_analyses", "select=shortcode,analysis,analyzed_at&limit=10000")

    reels = f_reels.result()
    meta = f_meta.result()
    analyses = f_opus.result()
    meta_map = {m["shortcode"]: m for m in meta}
    analysis_map = {a["shortcode"]: a for a in analyses}

    total_plays = sum(meta_map.get(r["shortcode"], {}).get("play_count") or 0 for r in reels)
    total_likes = sum(meta_map.get(r["shortcode"], {}).get("like_count") or 0 for r in reels)

    result = {
        "reels": reels, "metadata": meta,
        "transcripts": f_trans.result(), "analyses": analyses,
        "stats": {
            "total_reels": len(reels), "total_plays": total_plays,
            "total_likes": total_likes,
            "analyzed_count": sum(1 for r in reels if r["shortcode"] in analysis_map),
        },
    }
    _dashboard_cache["data"] = result
    _dashboard_cache["ts"] = now
    return result


# ── Thumbnails (local disk) ──

@app.get("/api/thumb/{shortcode}")
def get_thumb(shortcode: str):
    """Storage 308 redirect만. CDN 프록시 폴백 없음 — 영구화 강제."""
    from fastapi.responses import RedirectResponse
    if thumb.exists_in_storage(shortcode):
        return RedirectResponse(
            url=thumb.storage_url(shortcode),
            status_code=308,
            headers={"Cache-Control": "public, max-age=2592000, immutable"},
        )
    raise HTTPException(404, "Thumbnail not found in storage")


@app.post("/api/thumbs/download")
def download_thumbs(background_tasks: BackgroundTasks):
    """Trigger background download of all missing thumbnails from DB URLs."""
    background_tasks.add_task(_download_missing_thumbs)
    on_disk = thumb.count()
    return {"message": "다운로드 시작", "on_disk": on_disk}


def _download_missing_thumbs():
    """Fetch thumbnail URLs from DB and download missing ones."""
    meta = supabase.sb_get("reels_metadata", "select=shortcode,thumbnail_url&limit=50000")
    items = [(m["shortcode"], m.get("thumbnail_url", "")) for m in meta]
    thumb.download_batch(items)


# ── Analysis ──

class AnalyzeRequest(BaseModel):
    shortcode: str

@app.post("/api/analyze")
def start_analysis(req: AnalyzeRequest, background_tasks: BackgroundTasks):
    if pipeline.analysis_status.get(req.shortcode, {}).get("status") == "running":
        return {"message": "이미 분석 중"}
    # Vercel Lambda는 응답 후 종료라 background_tasks 실행 X → auto_worker가 처리하도록 위임
    if os.getenv("VERCEL") or os.getenv("VERCEL_ENV"):
        pipeline.analysis_status[req.shortcode] = {"status": "queued", "step": "auto_worker 대기 중", "progress": 0,
                                                    "message": "분석은 PC의 auto_worker가 처리합니다 (보통 1-5분)"}
        return {"message": "분석 큐 등록 — auto_worker가 처리", "shortcode": req.shortcode, "queued": True}
    # 로컬 환경 (uvicorn) — background task 정상 동작
    background_tasks.add_task(pipeline.run, req.shortcode)
    pipeline.analysis_status[req.shortcode] = {"status": "running", "step": "시작", "progress": 0}
    return {"message": "분석 시작", "shortcode": req.shortcode}

@app.get("/api/analysis-status/{shortcode}")
def get_analysis_status(shortcode: str):
    cached = pipeline.analysis_status.get(shortcode, {"status": "idle"})
    # Vercel — DB 체크로 실제 완료 여부 확인 (auto_worker가 다른 머신에서 처리하니 in-memory 상태 못 봄)
    if os.getenv("VERCEL") or os.getenv("VERCEL_ENV"):
        if cached.get("status") in ("queued", "running"):
            # opus_analyses에 row 있으면 완료로 판정 (pipeline 마지막에 저장)
            try:
                rows = supabase.sb_get("opus_analyses", f"shortcode=eq.{shortcode}&select=shortcode&limit=1")
                if rows:
                    return {"status": "done", "step": "완료", "progress": 100, "shortcode": shortcode}
            except Exception:
                pass
    return cached


# ── Single Reel Intake ──

def _normalize_shortcode(value: str) -> str:
    raw = (value or "").strip()
    if not raw:
        return ""
    raw = raw.split("?")[0].split("#")[0].rstrip("/")
    match = re.search(r"instagram\.com/(?:reel|p|tv)/([^/?#]+)", raw, re.I)
    if match:
        return re.sub(r"[^A-Za-z0-9_-]", "", match.group(1))
    parts = [p for p in raw.split("/") if p]
    candidate = parts[-1] if parts else raw
    return re.sub(r"[^A-Za-z0-9_-]", "", candidate)


def _fetch_hiker_metadata(shortcode: str) -> dict:
    key = os.getenv("HIKER_API_KEY")
    if not key:
        return {}
    _r = supabase.get_session()
    try:
        r = _r.get(
            "https://api.hikerapi.com/v1/media/by/code",
            params={"code": shortcode},
            headers={"accept": "application/json", "x-access-key": key},
            timeout=20,
        )
        if r.status_code != 200:
            return {}
        d = r.json()
    except Exception:
        return {}

    return {
        "shortcode": shortcode,
        "thumbnail_url": d.get("thumbnail_url"),
        "video_url": d.get("video_url"),
        "play_count": d.get("play_count"),
        "like_count": d.get("like_count"),
        "comment_count": d.get("comment_count"),
        "video_duration": d.get("video_duration"),
        "caption_text": (
            d.get("caption", {}).get("text") if isinstance(d.get("caption"), dict)
            else d.get("caption_text")
        ),
        "author_username": (
            d.get("user", {}).get("username") if isinstance(d.get("user"), dict)
            else d.get("author_username")
        ),
        "author_full_name": (
            d.get("user", {}).get("full_name") if isinstance(d.get("user"), dict)
            else d.get("author_full_name")
        ),
        "music_title": (
            ((d.get("clips_metadata") or {}).get("music_info") or {})
            .get("music_asset_info", {}).get("title")
            if isinstance(d.get("clips_metadata"), dict) else None
        ),
        "taken_at": d.get("taken_at_date"),
    }


class ReelAddRequest(BaseModel):
    url: str
    analyze: bool = False


@app.post("/api/reels")
def add_reel(req: ReelAddRequest, background_tasks: BackgroundTasks):
    shortcode = _normalize_shortcode(req.url)
    if not shortcode:
        raise HTTPException(400, "릴스 URL 또는 shortcode가 필요합니다")

    existing_meta = supabase.sb_get("reels_metadata", f"shortcode=eq.{shortcode}&limit=1")
    metadata = existing_meta[0] if existing_meta else _fetch_hiker_metadata(shortcode)
    author = metadata.get("author_username") or ""
    reel_url = f"https://www.instagram.com/reel/{shortcode}/"

    existing_reel = supabase.sb_get("reels", f"shortcode=eq.{shortcode}&select=shortcode&limit=1")
    if not existing_reel:
        ok = supabase.sb_post("reels", {
            "shortcode": shortcode,
            "url": reel_url,
            "source": "manual",
            "collected_at": datetime.now(timezone.utc).isoformat(),
        })
        if not ok:
            raise HTTPException(500, "릴스 저장 실패")

    if metadata:
        clean_meta = {k: v for k, v in metadata.items() if v is not None or k == "shortcode"}
        # CDN URL은 DB에 저장하지 않음 — storage 업로드 후 storage URL로만 저장
        cdn_url = clean_meta.pop("thumbnail_url", None)
        supabase.sb_post("reels_metadata", clean_meta)
        if cdn_url:
            try:
                thumb.download(shortcode, cdn_url)  # 성공 시 _update_db_url로 storage URL 저장
            except Exception as e:
                logger.warning("thumb download error: %s", e)

    if req.analyze and pipeline.analysis_status.get(shortcode, {}).get("status") != "running":
        # Vercel은 background task 실행 X → auto_worker 위임
        if os.getenv("VERCEL") or os.getenv("VERCEL_ENV"):
            pipeline.analysis_status[shortcode] = {"status": "queued", "step": "auto_worker 대기 중", "progress": 0}
        else:
            background_tasks.add_task(pipeline.run, shortcode)
            pipeline.analysis_status[shortcode] = {"status": "running", "step": "시작", "progress": 0}

    threading.Thread(target=_refresh_bench, daemon=True).start()
    return {
        "message": "릴스 추가 완료",
        "shortcode": shortcode,
        "url": reel_url,
        "author": author,
        "has_metadata": bool(metadata),
        "analysis_started": bool(req.analyze),
    }


# ── FB Ad Single Import ──

class FbAdImportRequest(BaseModel):
    url: str
    analyze: bool = True


def _parse_fb_ad_id(url_or_id: str) -> str:
    """FB Ads Library URL 또는 ad_id 문자열에서 ad_id 추출."""
    s = (url_or_id or "").strip()
    if not s:
        return ""
    if s.isdigit():
        return s
    import re as _re
    m = _re.search(r"[?&]id=(\d+)", s)
    if m:
        return m.group(1)
    return ""


@app.post("/api/fb-ad/import")
def import_fb_ad(req: FbAdImportRequest, background_tasks: BackgroundTasks, request: Request):
    """단일 FB Ads Library URL → reels DB로 import + (선택) 분석 파이프라인 실행."""
    auth_svc.require_user(request)
    ad_id = _parse_fb_ad_id(req.url)
    if not ad_id:
        raise HTTPException(400, "URL에서 ad_id 추출 실패 (예: facebook.com/ads/library/?id=1234567890)")
    shortcode = f"fb_{ad_id}"

    # 이미 import된 경우 — 분석만 다시
    existing = supabase.sb_get("reels", f"shortcode=eq.{shortcode}&select=shortcode&limit=1")
    if existing:
        if req.analyze and pipeline.analysis_status.get(shortcode, {}).get("status") != "running":
            if os.getenv("VERCEL") or os.getenv("VERCEL_ENV"):
                pipeline.analysis_status[shortcode] = {"status": "queued", "step": "auto_worker 대기 중", "progress": 0}
            else:
                background_tasks.add_task(pipeline.run, shortcode)
                pipeline.analysis_status[shortcode] = {"status": "running", "step": "시작", "progress": 0}
        return {"shortcode": shortcode, "imported": False, "message": "이미 import됨 — 분석 재실행"}

    # Playwright로 ad fetch
    try:
        from api.services.fb_ads_scraper import AdLibraryScraper
        scraper = AdLibraryScraper(headless=True)
        import asyncio as _asyncio
        ad_data = _asyncio.run(scraper.scrape_single_by_id(ad_id))
    except Exception as e:
        logger.exception("[fb-ad-import] scrape failed")
        raise HTTPException(500, f"FB ad fetch 실패: {e}")
    if not ad_data:
        raise HTTPException(404, f"ad_id {ad_id}에서 광고 찾을 수 없음")
    video_url = ad_data.get("video_url") or ""
    if not video_url:
        raise HTTPException(400, f"광고에 video URL 없음 (이미지 광고이거나 영상 추출 실패). page_name={ad_data.get('page_name','')}")

    # reels + reels_metadata 저장
    page_name = (ad_data.get("page_name") or "").strip() or "FB광고"
    caption = (ad_data.get("caption") or "")[:1000]
    supabase.sb_post("reels", {
        "shortcode": shortcode,
        "url": req.url,
        "source": "fb_ad",
        "collected_at": datetime.now(timezone.utc).isoformat(),
    })
    supabase.sb_post("reels_metadata", {
        "shortcode": shortcode,
        "author_username": page_name,
        "video_url": video_url,
        "caption_text": caption,
    })

    # 분석 트리거
    if req.analyze:
        if os.getenv("VERCEL") or os.getenv("VERCEL_ENV"):
            pipeline.analysis_status[shortcode] = {"status": "queued", "step": "auto_worker 대기 중", "progress": 0}
        else:
            background_tasks.add_task(pipeline.run, shortcode)
            pipeline.analysis_status[shortcode] = {"status": "running", "step": "시작", "progress": 0}

    return {
        "shortcode": shortcode,
        "imported": True,
        "ad_id": ad_id,
        "page_name": page_name,
        "video_url": video_url,
        "analysis_started": bool(req.analyze),
    }


# ── Text Analysis (for Claude Code to submit results) ──

class TextAnalysisResult(BaseModel):
    shortcode: str
    script_structure: dict | None = None
    category: dict | None = None

@app.get("/api/pending-text-analysis")
def get_pending_text_analysis(limit: int = Query(10, ge=1, le=100)):
    """Return reels that need script_structure or category analysis."""
    analyzed = supabase.sb_get("opus_analyses", "select=shortcode&limit=50000")
    pending = []
    for a in analyzed:
        sc = a["shortcode"]
        extra = pipeline.extra_cache.get(sc, {})
        if not extra.get("script_structure") or not extra.get("category"):
            pending.append(sc)
        if len(pending) >= limit:
            break
    return {"pending": pending, "count": len(pending)}


@app.get("/api/text-analysis-data/{shortcode}")
def get_text_analysis_data(shortcode: str):
    """Return transcript + frame_analysis + caption for Claude Code to analyze."""
    trans = supabase.sb_get("reels_transcripts", f"shortcode=eq.{shortcode}&limit=1")
    meta = supabase.sb_get("reels_metadata", f"shortcode=eq.{shortcode}&select=caption_text&limit=1")
    analysis = supabase.sb_get("opus_analyses", f"shortcode=eq.{shortcode}&limit=1")
    extra = pipeline.extra_cache.get(shortcode, {})
    return {
        "shortcode": shortcode,
        "transcript": trans[0]["transcript"] if trans else "",
        "caption": meta[0].get("caption_text", "") if meta else "",
        "frame_analysis": analysis[0].get("analysis", "") if analysis else "",
        "has_script_structure": bool(extra.get("script_structure")),
        "has_category": bool(extra.get("category")),
    }


@app.post("/api/text-analysis")
def save_text_analysis(req: TextAnalysisResult):
    """Save script_structure and category from Claude Code."""
    sc = req.shortcode
    data = {}
    if req.script_structure:
        data["script_structure"] = req.script_structure
    if req.category:
        data["category"] = req.category
    if data:
        pipeline.extra_cache[sc] = data
    return {"message": "저장 완료", "shortcode": sc}


class ExtraUpdateRequest(BaseModel):
    shortcode: str
    script_structure: dict | None = None
    category: dict | None = None
    sentences: list[dict] | None = None

@app.patch("/api/extra/{shortcode}")
def update_extra(shortcode: str, req: ExtraUpdateRequest):
    """Update script_structure / category / sentences (user edit)."""
    data = pipeline.extra_cache.get(shortcode, {}) or {}
    if req.script_structure is not None:
        data["script_structure"] = req.script_structure
    if req.category is not None:
        data["category"] = req.category
    if req.sentences is not None:
        data["sentences"] = req.sentences
        # script_by_sec 재계산
        sc_by_sec = {}
        for seg in req.sentences:
            try:
                start = int(seg.get("start", 0))
                end = int(seg.get("end", start + 1))
                text = (seg.get("text") or "").strip()
                for s in range(start + 1, end + 2):
                    if s not in sc_by_sec:
                        sc_by_sec[s] = text
            except Exception:
                continue
        data["script_by_sec"] = sc_by_sec
        # DB의 reels_transcripts.segments도 업데이트 (UPSERT)
        try:
            _r = supabase.get_session()
            transcript_text = " ".join((s.get("text") or "").strip() for s in req.sentences if (s.get("text") or "").strip())
            _r.post(
                f"{supabase.SUPABASE_URL}/rest/v1/reels_transcripts?on_conflict=shortcode",
                headers={**supabase.SUPABASE_HEADERS, "Prefer": "resolution=merge-duplicates,return=minimal"},
                json={"shortcode": shortcode, "transcript": transcript_text, "language": "ko", "segments": req.sentences},
                timeout=15,
            )
        except Exception as e:
            logger.warning("transcripts upsert failed: %s", e)
        # ⭐ chunks DB도 sentences edit 반영 — chunks_as_source_of_truth가 다음 gen에 revert 못 하도록 sync
        # chunks의 sentences[i].text를 새 sentences의 same start time + (가능하면) text 매칭으로 갱신
        try:
            SUPA = (os.getenv("SUPABASE_URL") or "").strip()
            SK = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
            _r2 = supabase.get_session()
            H = {"apikey": SK, "Authorization": f"Bearer {SK}"}
            ss_rows = _r2.get(
                f"{SUPA}/rest/v1/reels_script_structure?shortcode=eq.{shortcode}&select=overall&limit=1",
                headers=H, timeout=10,
            ).json()
            if ss_rows:
                overall = ss_rows[0].get("overall") or {}
                chunks = overall.get("section_chunks") or []
                if chunks:
                    # start time 기준 새 text 매칭 lookup
                    new_by_start = {round(float(s.get("start", 0) or 0), 2): (s.get("text") or "").strip() for s in req.sentences}
                    changed = 0
                    for c in chunks:
                        for cs in (c.get("sentences") or []):
                            cs_start = round(float(cs.get("start", 0) or 0), 2)
                            new_text = new_by_start.get(cs_start)
                            if new_text and new_text != (cs.get("text") or "").strip():
                                cs["text"] = new_text
                                changed += 1
                    if changed > 0:
                        overall["section_chunks"] = chunks
                        # body_chunks도 동기화
                        overall["body_chunks"] = [
                            {**c, "body_n": c.get("section")} for c in chunks if (c.get("section") or "").startswith("body")
                        ]
                        _r2.patch(
                            f"{SUPA}/rest/v1/reels_script_structure?shortcode=eq.{shortcode}",
                            headers={**H, "Prefer": "return=minimal"},
                            json={"overall": overall}, timeout=15,
                        )
                        logger.info("[update-extra] chunks.sentences.text synced — %d sentences", changed)
        except Exception as e:
            logger.warning("[update-extra] chunks sync failed: %s", e)
    pipeline.extra_cache[shortcode] = data
    return {"message": "수정 완료", "shortcode": shortcode}


# ── Comments ──

@app.post("/api/comments/{shortcode}/fetch")
def fetch_and_save_comments(shortcode: str):
    cmts = comments.fetch_playwright(shortcode)
    if cmts:
        _r = supabase.get_session()
        _r.post(
            f"{supabase.SUPABASE_URL}/rest/v1/reels_comments",
            headers={**supabase.SUPABASE_HEADERS, "Prefer": "resolution=merge-duplicates"},
            json=cmts,
        )
    return {"count": len(cmts), "comments": cmts}


# ── Channels (monitored_channels) ──

_channels_cache: dict[str, tuple[float, list]] = {}
_user_analysis_cache: dict[str, tuple[float, dict]] = {}
_fb_advertisers_cache: dict[str, tuple[float, dict]] = {}
_fb_search_ads_cache: dict[str, tuple[float, dict]] = {}
_CHANNELS_CACHE_TTL = 60
_USER_ANALYSIS_CACHE_TTL = 60
_FB_CACHE_TTL = 60


def _normalize_instagram_username(value: str) -> str:
    raw = (value or "").strip()
    if not raw:
        return ""
    raw = raw.split("?")[0].split("#")[0].rstrip("/")
    parts = [p for p in raw.split("/") if p]
    username = parts[-1] if parts else raw
    if username in {"instagram.com", "www.instagram.com"} and len(parts) >= 2:
        username = parts[-1]
    username = username.lstrip("@").strip()
    if username.lower() in {"reel", "p", "stories", "explore"}:
        return ""
    return re.sub(r"[^A-Za-z0-9._]", "", username)


@app.get("/api/channels")
def get_channels():
    cached = _cache_get(_channels_cache, "all", _CHANNELS_CACHE_TTL)
    if cached is not None:
        return cached
    return _cache_set(_channels_cache, "all", supabase.sb_get("monitored_channels", "select=*&order=created_at.desc&limit=500"))


@app.get("/api/fb/advertisers")
def get_fb_advertisers(
    sort: str = Query("ad_count"),
    q: str = Query(""),
):
    cache_key = f"{sort}:{q}"
    cached = _cache_get(_fb_advertisers_cache, cache_key, _FB_CACHE_TTL)
    if cached is not None:
        return cached
    """페북 라이브러리 광고주 — fb_advertisers 테이블 + 광고 카운트 조인."""
    SUPA = (os.getenv("SUPABASE_URL") or "").strip()
    SK = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    H = {"apikey": SK, "Authorization": f"Bearer {SK}"}
    _r = supabase.get_session()
    # 등록된 광고주
    advs = _r.get(
        f"{SUPA}/rest/v1/fb_advertisers?select=*&limit=2000",
        headers=H, timeout=15,
    ).json() or []
    # 광고 메타 (author_username 기준 광고 수)
    rows = _r.get(
        f"{SUPA}/rest/v1/reels_metadata?shortcode=like.fb_*"
        f"&select=shortcode,author_username,caption_text&limit=5000",
        headers=H, timeout=15,
    ).json() or []
    from collections import defaultdict
    counts: dict[str, dict] = defaultdict(lambda: {"ad_count": 0, "sample_caption": ""})
    for m in rows:
        author = (m.get("author_username") or "").strip()
        if not author:
            continue
        c = counts[author]
        c["ad_count"] += 1
        if not c["sample_caption"] and m.get("caption_text"):
            c["sample_caption"] = (m["caption_text"] or "")[:120]

    # 등록된 광고주 + 자동 감지 (광고는 있지만 fb_advertisers 미등록)
    registered_names = {a["page_name"] for a in advs}
    items = []
    for a in advs:
        pn = a["page_name"]
        c = counts.get(pn) or {}
        items.append({
            "id": a.get("id"),
            "page_name": pn,
            "page_url": a.get("page_url"),
            "logo_url": a.get("logo_url"),
            "description": a.get("description"),
            "is_active": a.get("is_active"),
            "ad_count": c.get("ad_count", 0),
            "sample_caption": c.get("sample_caption", ""),
            "registered": True,
        })
    for author, c in counts.items():
        if author in registered_names:
            continue
        items.append({
            "id": None,
            "page_name": author,
            "page_url": None,
            "logo_url": None,
            "description": None,
            "is_active": None,
            "ad_count": c["ad_count"],
            "sample_caption": c["sample_caption"],
            "registered": False,
        })

    if q:
        ql = q.lower()
        items = [it for it in items if ql in (it.get("page_name") or "").lower()]
    if sort == "ad_count":
        items.sort(key=lambda i: i["ad_count"], reverse=True)
    elif sort == "name":
        items.sort(key=lambda i: i["page_name"].lower())
    return _cache_set(_fb_advertisers_cache, cache_key, {"items": items, "total": len(items)})


class FbAdvertiserAddRequest(BaseModel):
    page_url: str
    page_name: str | None = None
    logo_url: str | None = None
    description: str | None = None


def _fetch_fb_page_meta(page_url: str) -> dict:
    """FB 페이지 URL → og:title + og:image 추출."""
    import re as _re
    out: dict = {"page_name": None, "logo_url": None}
    try:
        import requests as _req
        r = _req.get(
            page_url,
            headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"},
            timeout=15, allow_redirects=True,
        )
        if r.status_code != 200:
            return out
        html = r.text
        m_title = _re.search(r'<meta property="og:title" content="([^"]+)"', html)
        m_image = _re.search(r'<meta property="og:image" content="([^"]+)"', html)
        if m_title:
            out["page_name"] = m_title.group(1).strip()
        if m_image:
            out["logo_url"] = m_image.group(1).replace("&amp;", "&").strip()
    except Exception as e:
        logger.warning("fetch_fb_page_meta failed: %s", e)
    return out


@app.post("/api/fb/advertisers")
def add_fb_advertiser(req: FbAdvertiserAddRequest, request: Request):
    auth_svc.require_user(request)
    page_url = (req.page_url or "").strip()
    if not page_url.startswith(("http://", "https://")):
        raise HTTPException(400, "유효한 페이지 URL이 필요합니다 (https://www.facebook.com/...)")
    # 자동으로 og:title + og:image 추출 (사용자가 수동 입력 안 했을 때만)
    page_name = (req.page_name or "").strip()
    logo_url = (req.logo_url or "").strip()
    if not page_name or not logo_url:
        meta = _fetch_fb_page_meta(page_url)
        if not page_name:
            page_name = meta.get("page_name") or ""
        if not logo_url:
            logo_url = meta.get("logo_url") or ""
    if not page_name:
        # URL slug fallback
        from urllib.parse import urlparse
        slug = urlparse(page_url).path.strip("/").split("/")[0]
        page_name = slug or page_url
    payload = {
        "page_name": page_name,
        "page_url": page_url,
        "logo_url": logo_url or None,
        "description": (req.description or "").strip() or None,
    }
    SUPA = (os.getenv("SUPABASE_URL") or "").strip()
    SK = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    H = {"apikey": SK, "Authorization": f"Bearer {SK}", "Content-Type": "application/json", "Prefer": "return=representation"}
    _r = supabase.get_session()
    r = _r.post(f"{SUPA}/rest/v1/fb_advertisers", headers=H, json=payload, timeout=15)
    if r.status_code in (201, 200):
        _trigger_render_scraper()
        return r.json()[0] if r.json() else payload
    raise HTTPException(r.status_code, r.text[:300])


@app.delete("/api/fb/advertisers/{adv_id}")
def delete_fb_advertiser(adv_id: int, request: Request):
    auth_svc.require_user(request)
    SUPA = (os.getenv("SUPABASE_URL") or "").strip()
    SK = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    H = {"apikey": SK, "Authorization": f"Bearer {SK}", "Prefer": "return=minimal"}
    _r = supabase.get_session()
    r = _r.delete(f"{SUPA}/rest/v1/fb_advertisers?id=eq.{adv_id}", headers=H, timeout=15)
    if r.status_code in (200, 204):
        return {"ok": True}
    raise HTTPException(r.status_code, r.text[:300])


@app.get("/api/fb/search/advertisers")
def fb_search_advertisers(q: str = Query(""), limit: int = Query(50, ge=1, le=200)):
    """캐시된 fb_* reels_metadata에서 키워드 매칭 광고주 그룹."""
    SUPA = (os.getenv("SUPABASE_URL") or "").strip()
    SK = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    H = {"apikey": SK, "Authorization": f"Bearer {SK}"}
    _r = supabase.get_session()
    rows = _r.get(
        f"{SUPA}/rest/v1/reels_metadata?shortcode=like.fb_*"
        f"&select=shortcode,author_username,caption_text,thumbnail_url&limit=5000",
        headers=H, timeout=15,
    ).json() or []
    if q:
        ql = q.lower()
        rows = [m for m in rows if
                ql in (m.get("caption_text") or "").lower() or
                ql in (m.get("author_username") or "").lower()]
    from collections import defaultdict
    agg: dict[str, dict] = defaultdict(lambda: {"ad_count": 0, "thumbnails": [], "sample_caption": ""})
    for m in rows:
        author = (m.get("author_username") or "").strip()
        if not author:
            continue
        a = agg[author]
        a["ad_count"] += 1
        if m.get("thumbnail_url") and len(a["thumbnails"]) < 3:
            a["thumbnails"].append(m["thumbnail_url"])
        if not a["sample_caption"] and m.get("caption_text"):
            a["sample_caption"] = (m["caption_text"] or "")[:120]
    advs = _r.get(f"{SUPA}/rest/v1/fb_advertisers?select=page_name,id,logo_url", headers=H, timeout=10).json() or []
    reg_map = {a["page_name"]: a for a in advs}
    items = []
    for k, v in agg.items():
        reg = reg_map.get(k)
        items.append({
            "page_name": k,
            "ad_count": v["ad_count"],
            "thumbnails": v["thumbnails"],
            "sample_caption": v["sample_caption"],
            "registered": reg is not None,
            "advertiser_id": reg["id"] if reg else None,
            "logo_url": reg.get("logo_url") if reg else None,
        })
    items.sort(key=lambda i: i["ad_count"], reverse=True)
    return {"items": items[:limit], "total": len(items), "query": q}


@app.get("/api/fb/search/ads")
def fb_search_ads(
    q: str = Query(""),
    min_age_days: int = Query(7, description="광고 게재 시작일 기준 N일 이상 운영된 광고만 (0=전체)"),
    duration_max: int = Query(0, description="영상 길이 최대 초 (0=전체)"),
    duration_min: int = Query(0, description="영상 길이 최소 초"),
    sort: str = Query("recent", description="recent|started|duration_short|duration_long"),
    limit: int = Query(50, ge=1, le=200),
):
    cache_key = f"{q}:{min_age_days}:{duration_min}:{duration_max}:{sort}:{limit}"
    cached = _cache_get(_fb_search_ads_cache, cache_key, _FB_CACHE_TTL)
    if cached is not None:
        return cached
    """캐시된 fb_* reels에서 키워드 + 필터 매칭 광고."""
    SUPA = (os.getenv("SUPABASE_URL") or "").strip()
    SK = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    H = {"apikey": SK, "Authorization": f"Bearer {SK}"}
    _r = supabase.get_session()
    rows = _r.get(
        f"{SUPA}/rest/v1/reels_metadata?shortcode=like.fb_*"
        f"&select=shortcode,author_username,caption_text,thumbnail_url,video_duration,video_url,taken_at"
        f"&limit=2000",
        headers=H, timeout=15,
    ).json() or []
    rows = [m for m in rows if m.get("video_url")]
    if q:
        ql = q.lower()
        rows = [m for m in rows if
                ql in (m.get("caption_text") or "").lower() or
                ql in (m.get("author_username") or "").lower()]
    # 광고 게재 시작일 필터 — N일 이상 운영 중인 광고만 (= taken_at <= now - N일)
    if min_age_days and min_age_days > 0:
        from datetime import timedelta
        cutoff = (datetime.now(timezone.utc) - timedelta(days=min_age_days)).isoformat()
        rows = [m for m in rows if (m.get("taken_at") or "") and (m.get("taken_at") or "") <= cutoff]
    # 영상 길이 필터
    if duration_min and duration_min > 0:
        rows = [m for m in rows if (m.get("video_duration") or 0) >= duration_min]
    if duration_max and duration_max > 0:
        rows = [m for m in rows if 0 < (m.get("video_duration") or 0) <= duration_max]
    # 정렬
    if sort == "started":
        rows.sort(key=lambda r: (r.get("taken_at") or ""), reverse=True)
    elif sort == "duration_short":
        rows.sort(key=lambda r: r.get("video_duration") or 99999)
    elif sort == "duration_long":
        rows.sort(key=lambda r: r.get("video_duration") or 0, reverse=True)
    else:  # recent (기본 — 수집 순서 = shortcode 역순)
        rows.sort(key=lambda r: r.get("shortcode") or "", reverse=True)
    return _cache_set(_fb_search_ads_cache, cache_key, {"items": rows[:limit], "total": len(rows), "query": q})


@app.post("/api/fb/scrape")
def fb_scrape_keyword(request: Request, keyword: str = Query(...), country: str = Query("KR")):
    """키워드 라이브 스크래핑 trigger — fb_advertisers 큐에 추가, worker가 처리."""
    auth_svc.require_user(request)
    if not keyword.strip():
        raise HTTPException(400, "keyword 필요")
    SUPA = (os.getenv("SUPABASE_URL") or "").strip()
    SK = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    H = {"apikey": SK, "Authorization": f"Bearer {SK}", "Content-Type": "application/json", "Prefer": "return=minimal"}
    _r = supabase.get_session()
    payload = {
        "page_name": f"[검색] {keyword.strip()}",
        "page_url": f"https://www.facebook.com/ads/library/?q={keyword.strip()}",
        "description": f"키워드 검색: {keyword.strip()}",
        "is_active": True,
    }
    _r.post(f"{SUPA}/rest/v1/fb_advertisers", headers=H, json=payload, timeout=15)
    _trigger_render_scraper()
    return {"ok": True, "queued": True, "keyword": keyword.strip(), "message": "스크래핑 시작 (1-2분 소요)"}


def _trigger_render_scraper():
    """Render fb-ads-web /trigger 호출 — Vercel Lambda는 thread freeze되니 sync로."""
    fb_web = os.getenv("FB_ADS_WEB_URL", "https://fb-ads-web.onrender.com")
    secret = os.getenv("TRIGGER_SECRET", "")
    url = f"{fb_web}/trigger" + (f"?key={secret}" if secret else "")
    try:
        requests.get(url, timeout=5)
        logger.info("[render-trigger] sent: %s", url[:80])
    except Exception as e:
        logger.warning("[render-trigger] failed: %s", e)


@app.get("/api/youtubers")
def get_youtubers(
    sort: str = Query("subscribers"),
    q: str = Query(""),
    category: str = Query(""),
):
    """유튜버 리스트 (구독자 / 일일 조회수 / 카테고리)."""
    rows = supabase.sb_get(
        "youtubers",
        "select=youtube_handle,channel_name,category,subscribers,daily_views,subscriber_growth_rate,avatar_url,description,country_code,is_verified,engagement_rate&limit=2000",
    ) or []
    if q:
        ql = q.lower()
        rows = [r for r in rows if ql in (r.get("channel_name") or "").lower() or ql in (r.get("youtube_handle") or "").lower()]
    if category:
        cats = [c.strip() for c in category.split(",") if c.strip()]
        rows = [r for r in rows if r.get("category") in cats]
    if sort == "subscribers":
        rows.sort(key=lambda r: r.get("subscribers") or 0, reverse=True)
    elif sort == "daily_views":
        rows.sort(key=lambda r: r.get("daily_views") or 0, reverse=True)
    elif sort == "growth":
        rows.sort(key=lambda r: r.get("subscriber_growth_rate") or 0, reverse=True)
    return {"items": rows, "total": len(rows)}


class YtIntakeRequest(BaseModel):
    video_ids: list[str]


@app.post("/api/yt/intake")
def yt_intake(req: YtIntakeRequest, request: Request):
    """유튜브 쇼츠 video_id 큐 등록 — auto_yt_worker가 polling해서 분석."""
    auth_svc.require_user(request)
    SUPA = (os.getenv("SUPABASE_URL") or "").strip()
    SK = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    H = {"apikey": SK, "Authorization": f"Bearer {SK}",
         "Content-Type": "application/json",
         "Prefer": "resolution=merge-duplicates,return=minimal"}
    _r = supabase.get_session()

    valid_ids = [v.strip() for v in req.video_ids if v and len(v.strip()) >= 6]
    if not valid_ids:
        raise HTTPException(400, "video_ids 비어있음")

    now_iso = datetime.now(timezone.utc).isoformat()
    payload = [
        {
            "shortcode": vid,
            "url": f"https://www.youtube.com/shorts/{vid}",
            "source": "youtube_short",
            "collected_at": now_iso,
        }
        for vid in valid_ids
    ]
    rr = _r.post(
        f"{SUPA}/rest/v1/youtube_shorts?on_conflict=shortcode",
        headers=H, json=payload, timeout=15,
    )
    if rr.status_code not in (200, 201, 204):
        raise HTTPException(rr.status_code, rr.text[:200])
    return {"queued": len(valid_ids), "video_ids": valid_ids}


@app.get("/api/yt/intake/status")
def yt_intake_status(request: Request):
    """미분석 (pro_audio 없음) 큐 상태 조회 — 프론트에서 'X개 대기 중' 표시용."""
    auth_svc.require_user(request)
    SUPA = (os.getenv("SUPABASE_URL") or "").strip()
    SK = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    H = {"apikey": SK, "Authorization": f"Bearer {SK}"}
    _r = supabase.get_session()

    core = _r.get(
        f"{SUPA}/rest/v1/youtube_shorts?select=shortcode,collected_at&order=collected_at.desc&limit=200",
        headers=H, timeout=10,
    ).json()
    audio = _r.get(
        f"{SUPA}/rest/v1/youtube_shorts_pro_audio?select=shortcode&limit=2000",
        headers=H, timeout=10,
    ).json()
    analyzed = {row["shortcode"] for row in (audio or []) if row.get("shortcode")}
    pending = [
        {"shortcode": r["shortcode"], "collected_at": r.get("collected_at")}
        for r in (core or []) if r.get("shortcode") and r["shortcode"] not in analyzed
    ]
    return {"pending": pending, "pending_count": len(pending), "analyzed_count": len(analyzed)}


@app.get("/api/yt/bench")
def get_yt_bench(
    page: int = Query(1, ge=1),
    limit: int = Query(30, ge=1, le=100),
    sort: str = Query("recent"),
    q: str = Query(""),
):
    """유튜브 쇼츠 벤치마크 — youtube_shorts + youtube_shorts_metadata 머지."""
    SUPA = (os.getenv("SUPABASE_URL") or "").strip()
    SK = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    H = {"apikey": SK, "Authorization": f"Bearer {SK}"}
    _r = supabase.get_session()
    with ThreadPoolExecutor(max_workers=3) as ex:
        f_core = ex.submit(_r.get,
            f"{SUPA}/rest/v1/youtube_shorts?select=shortcode,url,collected_at&order=collected_at.desc&limit=2000",
            headers=H, timeout=15)
        f_meta = ex.submit(_r.get,
            f"{SUPA}/rest/v1/youtube_shorts_metadata?select=shortcode,view_count,like_count,comment_count,video_duration,thumbnail_url,caption_text,author_username,author_full_name,taken_at&limit=2000",
            headers=H, timeout=15)
        f_an = ex.submit(_r.get,
            f"{SUPA}/rest/v1/youtube_shorts_pro_audio?select=shortcode&limit=2000",
            headers=H, timeout=15)
    core = f_core.result().json() or []
    meta_map = {m["shortcode"]: m for m in (f_meta.result().json() or [])}
    analyzed = {a["shortcode"] for a in (f_an.result().json() or [])}

    items = []
    total_views = total_likes = 0
    for c in core:
        sc = c["shortcode"]
        m = meta_map.get(sc, {})
        views = m.get("view_count") or 0
        likes = m.get("like_count") or 0
        total_views += views
        total_likes += likes
        items.append({
            "shortcode": sc,
            "url": c.get("url") or f"https://www.youtube.com/shorts/{sc}",
            "author": m.get("author_full_name") or m.get("author_username") or "",
            "author_handle": m.get("author_username") or "",
            "play_count": views,
            "like_count": likes,
            "comment_count": m.get("comment_count") or 0,
            "video_duration": m.get("video_duration") or 0,
            "thumbnail_url": m.get("thumbnail_url") or f"https://i.ytimg.com/vi/{sc}/hqdefault.jpg",
            "caption": (m.get("caption_text") or "")[:200],
            "collected_at": c.get("collected_at") or "",
            "taken_at": m.get("taken_at") or "",
            "analyzed": sc in analyzed,
        })
    if q:
        ql = q.lower()
        items = [i for i in items if
                 ql in i["author"].lower() or ql in i["author_handle"].lower() or
                 ql in (i["caption"] or "").lower() or ql in i["shortcode"].lower()]
    if sort == "plays":
        items.sort(key=lambda i: i["play_count"], reverse=True)
    elif sort == "likes":
        items.sort(key=lambda i: i["like_count"], reverse=True)
    elif sort == "er":
        items.sort(key=lambda i: (i["like_count"] / i["play_count"]) if i["play_count"] else 0, reverse=True)
    else:  # recent
        items.sort(key=lambda i: i["collected_at"], reverse=True)
    total = len(items)
    start = (page - 1) * limit
    return {
        "items": items[start:start + limit],
        "stats": {
            "total_shorts": len(core),
            "total_views": total_views,
            "total_likes": total_likes,
            "analyzed_count": len(analyzed),
        },
        "total": total,
        "page": page,
        "has_more": start + limit < total,
    }


@app.get("/api/yt/bench/{vid}")
def get_yt_bench_detail(vid: str):
    """유튜브 쇼츠 단일 상세 — 메타 + audio/video 분석 + 자막."""
    SUPA = (os.getenv("SUPABASE_URL") or "").strip()
    SK = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    H = {"apikey": SK, "Authorization": f"Bearer {SK}"}
    _r = supabase.get_session()

    def _g(table: str, sel: str = "*"):
        rr = _r.get(
            f"{SUPA}/rest/v1/{table}?shortcode=eq.{vid}&select={sel}&limit=1",
            headers=H, timeout=10,
        )
        rows = rr.json() if rr.status_code == 200 else []
        return rows[0] if rows else None

    core = _g("youtube_shorts")
    meta = _g("youtube_shorts_metadata")
    audio = _g("youtube_shorts_pro_audio")
    ss = _g("youtube_shorts_script_structure")
    cat = _g("youtube_shorts_category")
    if not core:
        raise HTTPException(404, f"shortcode {vid} not found")

    pa = (audio or {}).get("pro_audio") or {}
    raw_emos = (audio or {}).get("audio_emotions") or []
    raw_bgm = (audio or {}).get("bgm_changes") or []
    duration = int(round(pa.get("duration_sec") or (meta or {}).get("video_duration") or 0))

    def _to_sec(v):
        if v is None:
            return 0.0
        if isinstance(v, (int, float)):
            return float(v)
        s = str(v).strip()
        if ":" in s:
            try:
                m, ss_ = s.split(":")
                return int(m) * 60 + float(ss_)
            except Exception:
                return 0.0
        try:
            return float(s)
        except Exception:
            return 0.0

    # audio_emotions list -> Record<sec_int, EmotionData> (1-indexed, IG-호환)
    audio_emotions: dict[int, dict] = {}
    if isinstance(raw_emos, list):
        for sec in range(1, max(duration, 1) + 1):
            t = sec - 0.5
            for e in raw_emos:
                eS = _to_sec(e.get("start"))
                eE = _to_sec(e.get("end"))
                if eS <= t < eE:
                    audio_emotions[sec] = {
                        "pitch": 0,
                        "volume": int(round((e.get("intensity") or 0) * 100)),
                        "silence": False,
                        "emotion": e.get("emotion") or "",
                        "label": e.get("emotion") or "",
                        "confidence": float(e.get("intensity") or 0),
                    }
                    break
    elif isinstance(raw_emos, dict):
        audio_emotions = raw_emos

    # bgm_changes list of bands -> [{sec, score}] for FrameTimeline 마커 (각 band 시작점 + 1.0)
    bgm_changes_compat = []
    seen_sec = set()
    if isinstance(raw_bgm, list):
        for b in raw_bgm:
            sec = int(round(_to_sec(b.get("start"))))
            if sec not in seen_sec:
                bgm_changes_compat.append({"sec": sec, "score": 1.0})
                seen_sec.add(sec)

    # tts_script -> script_by_sec (Record<sec, text>)
    script_by_sec: dict[int, str] = {}
    for s in (pa.get("tts_script") or []):
        sS = _to_sec(s.get("start"))
        sE = _to_sec(s.get("end"))
        text = (s.get("text") or "").strip()
        if not text:
            continue
        a = max(0, int(sS))
        b = max(a, int(sE) + (1 if sE > int(sE) else 0))
        for sec in range(a, b + 1):
            script_by_sec[sec + 1] = text  # IG는 1-indexed (currentSec + 1)

    # frame_images: Storage 'frames' 버킷에서 조회
    frame_images: dict[int, str] = {}
    try:
        rows = supabase.storage_list("frames", vid)
        base = f"{SUPA}/storage/v1/object/public/frames/{vid}"
        for row in rows:
            name = str(row.get("name") or "")
            stem = name.rsplit(".", 1)[0]
            if not (name.lower().endswith(".webp") or name.lower().endswith(".jpg")) or not stem.isdigit():
                continue
            sec = int(stem)
            if sec not in frame_images or name.lower().endswith(".webp"):
                frame_images[sec] = f"{base}/{name}"
    except Exception:
        pass

    return {
        "shortcode": vid,
        "url": (core or {}).get("url"),
        "metadata": meta or {},
        "pro_audio": pa,
        "audio_emotions": audio_emotions,
        "audio_emotions_raw": raw_emos,
        "bgm_changes": bgm_changes_compat,
        "bgm_changes_raw": raw_bgm,
        "tts": pa.get("tts_script") or [],
        "frame_analysis": pa.get("frame_analysis") or "",
        "frame_ocr": pa.get("frame_ocr") or {},
        "script_by_sec": script_by_sec,
        "frame_images": dict(sorted(frame_images.items())),
        "script_structure": ss or None,
        "category": cat or None,
    }


class YoutuberAddRequest(BaseModel):
    handle: str  # @channel 또는 https://youtube.com/@channel


def _normalize_yt_handle(value: str) -> str:
    raw = (value or "").strip()
    if not raw:
        return ""
    # URL → handle 추출
    import re
    m = re.search(r"youtube\.com/(@[A-Za-z0-9._-]+)", raw, re.IGNORECASE)
    if m:
        h = m.group(1)
    elif raw.startswith("@"):
        h = raw
    else:
        h = "@" + raw
    return h.replace(" ", "")


@app.post("/api/youtubers")
def add_youtuber(req: YoutuberAddRequest, request: Request):
    auth_svc.require_user(request)
    handle = _normalize_yt_handle(req.handle)
    if not handle or len(handle) < 2:
        raise HTTPException(400, "핸들이 필요합니다 (@channel 형식)")
    SUPA = (os.getenv("SUPABASE_URL") or "").strip()
    SK = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    H = {"apikey": SK, "Authorization": f"Bearer {SK}"}
    _r = supabase.get_session()
    # 중복 체크
    exists = _r.get(
        f"{SUPA}/rest/v1/youtubers?youtube_handle=eq.{handle}&select=youtube_handle",
        headers=H, timeout=10,
    ).json() or []
    if exists:
        return {"ok": True, "duplicate": True, "handle": handle}
    payload = {
        "youtube_handle": handle,
        "channel_name": handle.lstrip("@"),  # 메타데이터 fetch 전 임시
    }
    rr = _r.post(
        f"{SUPA}/rest/v1/youtubers",
        headers={**H, "Content-Type": "application/json", "Prefer": "return=minimal"},
        json=payload, timeout=15,
    )
    if rr.status_code not in (200, 201, 204):
        raise HTTPException(500, f"저장 실패: {rr.status_code} {rr.text[:120]}")
    return {"ok": True, "handle": handle}


@app.delete("/api/youtubers/{handle}")
def delete_youtuber(handle: str, request: Request):
    auth_svc.require_user(request)
    h = _normalize_yt_handle(handle)
    SUPA = (os.getenv("SUPABASE_URL") or "").strip()
    SK = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    H = {"apikey": SK, "Authorization": f"Bearer {SK}"}
    _r = supabase.get_session()
    rr = _r.delete(
        f"{SUPA}/rest/v1/youtubers?youtube_handle=eq.{h}",
        headers=H, timeout=15,
    )
    if rr.status_code not in (200, 204):
        raise HTTPException(500, f"삭제 실패: {rr.status_code}")
    return {"ok": True, "handle": h}


class ChannelAddRequest(BaseModel):
    username: str

@app.post("/api/channels")
def add_channel(req: ChannelAddRequest):
    username = _normalize_instagram_username(req.username)
    if not username:
        raise HTTPException(400, "username이 필요합니다")
    ok = supabase.sb_post("monitored_channels", {"username": username, "is_active": True})
    if ok:
        _channels_cache.clear()
        return {"message": f"@{username} 추가 완료", "username": username}
    raise HTTPException(500, "추가 실패")


class ChannelUpdateRequest(BaseModel):
    is_active: bool | None = None

@app.patch("/api/channels/{username}")
def update_channel(username: str, req: ChannelUpdateRequest):
    data = {}
    if req.is_active is not None:
        data["is_active"] = req.is_active
    if data:
        supabase.sb_patch("monitored_channels", f"username=eq.{username}", data)
        _channels_cache.clear()
    return {"message": "수정 완료", "username": username}


@app.delete("/api/channels/{username}")
def delete_channel(username: str):
    username = _normalize_instagram_username(username)
    if not username:
        raise HTTPException(400, "username이 필요합니다")

    ok = supabase.sb_delete("monitored_channels", f"username=eq.{username}")
    if ok:
        _channels_cache.clear()
        return {"message": f"@{username} 삭제 완료"}
    raise HTTPException(500, "삭제 실패 (DB 오류)")


@app.delete("/api/channels/by-id/{channel_id}")
def delete_channel_by_id(channel_id: int):
    ok = supabase.sb_delete("monitored_channels", f"id=eq.{channel_id}")
    if ok:
        _channels_cache.clear()
        return {"message": "삭제 완료", "id": channel_id}
    raise HTTPException(500, "삭제 실패 (DB 오류)")


@app.get("/api/users/{username}/analysis")
def get_user_analysis(username: str, limit: int = Query(24, ge=1, le=100)):
    username = _normalize_instagram_username(username)
    if not username:
        raise HTTPException(400, "username이 필요합니다")
    cache_key = f"{username}:{limit}"
    cached = _cache_get(_user_analysis_cache, cache_key, _USER_ANALYSIS_CACHE_TTL)
    if cached is not None:
        return cached

    # 1. metadata에서 author 필터로 한 번에 모든 필드 (이전: shortcode만 조회 후 재조회)
    meta = supabase.sb_get(
        "reels_metadata",
        f"author_username=eq.{username}"
        f"&select=shortcode,play_count,like_count,comment_count,video_duration,thumbnail_url,caption_text,author_username,taken_at"
        f"&limit=500",
    )
    if not meta:
        return {
            "username": username,
            "stats": {
                "total_reels": 0,
                "analyzed_count": 0,
                "total_plays": 0,
                "total_likes": 0,
                "avg_er": 0,
                "best_shortcode": None,
            },
            "items": [],
            "insights": {
                "top_reel": None,
                "top_tags": [],
                "latest_analyzed_at": None,
                "summary": "아직 이 계정에서 수집된 릴스가 없습니다.",
            },
        }

    shortcodes = [m["shortcode"] for m in meta if m.get("shortcode")]
    sc_filter = ",".join(shortcodes)

    # 2. reels / analyses / categories 병렬 조회
    with ThreadPoolExecutor(max_workers=3) as ex:
        f_reels = ex.submit(
            supabase.sb_get, "reels",
            f"shortcode=in.({sc_filter})&select=shortcode,url,account_category,collected_at&order=collected_at.desc&limit=500",
        )
        f_analyses = ex.submit(
            supabase.sb_get, "opus_analyses",
            f"shortcode=in.({sc_filter})&select=shortcode,analysis,analyzed_at&limit=500",
        )
        f_categories = ex.submit(
            supabase.sb_get, "reels_category",
            f"shortcode=in.({sc_filter})&select=shortcode,topic,style,tags&limit=500",
        )
    reels = f_reels.result() or []
    analyses = f_analyses.result() or []
    categories = f_categories.result() or []

    meta_map = {m["shortcode"]: m for m in meta}
    analysis_map = {a["shortcode"]: a for a in analyses}
    category_map = {c["shortcode"]: c for c in categories}

    def excerpt(text: str) -> str:
        cleaned = re.sub(r"[#*_>`\-\[\]]", "", text or "")
        cleaned = re.sub(r"\s+", " ", cleaned).strip()
        return cleaned[:220] + ("..." if len(cleaned) > 220 else "")

    items = []
    total_plays = total_likes = 0
    top_tags: dict[str, int] = {}
    for r in reels:
        sc = r.get("shortcode")
        m = meta_map.get(sc, {})
        a = analysis_map.get(sc)
        c = category_map.get(sc, {})
        plays = m.get("play_count") or 0
        likes = m.get("like_count") or 0
        total_plays += plays
        total_likes += likes
        for tag in c.get("tags") or []:
            if isinstance(tag, str) and tag.strip():
                top_tags[tag.strip()] = top_tags.get(tag.strip(), 0) + 1
        items.append({
            "shortcode": sc,
            "url": r.get("url") or f"https://www.instagram.com/reel/{sc}/",
            "author": m.get("author_username") or username,
            "play_count": plays,
            "like_count": likes,
            "comment_count": m.get("comment_count") or 0,
            "thumbnail_url": m.get("thumbnail_url") or "",
            "collected_at": r.get("collected_at") or "",
            "taken_at": m.get("taken_at"),
            "analyzed": bool(a),
            "analysis_excerpt": excerpt(a.get("analysis", "")) if a else "",
            "analyzed_at": a.get("analyzed_at") if a else None,
            "topic": c.get("topic"),
            "style": c.get("style"),
            "tags": c.get("tags") or [],
        })

    items = sorted(items, key=lambda i: i["play_count"], reverse=True)
    analyzed_count = sum(1 for i in items if i["analyzed"])
    best = items[0] if items else None
    avg_er = round(total_likes / total_plays * 100, 2) if total_plays else 0
    latest_analyzed_at = max([i["analyzed_at"] for i in items if i["analyzed_at"]] or [None])
    sorted_tags = sorted(top_tags.items(), key=lambda kv: kv[1], reverse=True)[:8]

    summary = "분석된 릴스가 아직 없습니다."
    if best and analyzed_count:
        summary = f"가장 강한 릴스는 {best['play_count']:,} 조회의 {best['shortcode']}이며, 평균 ER은 {avg_er}%입니다."

    result = {
        "username": username,
        "stats": {
            "total_reels": len(items),
            "analyzed_count": analyzed_count,
            "total_plays": total_plays,
            "total_likes": total_likes,
            "avg_er": avg_er,
            "best_shortcode": best["shortcode"] if best else None,
        },
        "items": items[:limit],
        "insights": {
            "top_reel": best,
            "top_tags": [{"tag": tag, "count": count} for tag, count in sorted_tags],
            "latest_analyzed_at": latest_analyzed_at,
            "summary": summary,
        },
    }
    return _cache_set(_user_analysis_cache, cache_key, result)


@app.get("/api/_debug/auth")
def debug_auth(request: Request):
    """API key 디버그용 — env + verify 결과 노출."""
    import hashlib
    _r = supabase.get_session()
    api_key = request.headers.get("X-API-Key") or request.headers.get("x-api-key")
    info = {
        "has_supabase_url": bool((os.getenv("SUPABASE_URL") or "").strip()),
        "has_service_key": bool(os.getenv("SUPABASE_SERVICE_ROLE_KEY")),
        "service_key_prefix": (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "")[:20],
        "has_anon_key": bool(os.getenv("SUPABASE_ANON_KEY")),
        "api_key_received": api_key[:11] + "..." if api_key else None,
    }
    if api_key:
        h = hashlib.sha256(api_key.encode()).hexdigest()
        info["expected_hash"] = h
        SUPA = (os.getenv("SUPABASE_URL") or "").strip()
        SK = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
        try:
            r = _r.get(
                f"{SUPA}/rest/v1/api_keys?key_hash=eq.{h}&select=*",
                headers={"apikey": SK, "Authorization": f"Bearer {SK}"},
                timeout=10,
            )
            info["lookup_status"] = r.status_code
            info["lookup_body"] = r.text[:500]
        except Exception as e:
            info["lookup_error"] = str(e)
    return info


@app.get("/api/_debug/fs")
def debug_fs():
    import os
    here = Path(__file__).parent
    root = here.parent
    return {
        "cwd": os.getcwd(),
        "__file__": str(Path(__file__)),
        "api_dir_contents": sorted(p.name for p in here.iterdir()) if here.is_dir() else None,
        "root_dir_contents": sorted(p.name for p in root.iterdir()) if root.is_dir() else None,
        "api_public_exists": (here / "public").is_dir(),
        "root_public_exists": (root / "public").is_dir(),
        "api_public_files": sorted(p.name for p in (here / "public").iterdir()) if (here / "public").is_dir() else None,
    }


# ── ElevenLabs TTS 합성 ──

class TtsSynthRequest(BaseModel):
    sentences: list[dict]
    voice_name: str = "joonpark"
    model_id: str = "eleven_v3"
    emotion_strength: float = 0.5  # 0.0~1.0 (전체 base)
    persona: dict | None = None  # name, gender → 인라인 cue로 voice 톤 시프트
    speed_factor: float = 1.0  # atempo 후처리 (1.0=자연, >1.0=가속)
    target_duration: float | None = None  # 주어지면 자동 speed_factor 계산 (REF 길이 매칭)
    segment_match: bool = False  # segment별 atempo로 REF 정밀 매칭 (음질 트레이드오프)


class TtsSegmentRequest(BaseModel):
    job_id: str
    idx: int
    strength_level: int  # -2 (매우 약) ~ +2 (매우 강)


class TtsAutoEmotionRequest(BaseModel):
    sentences: list[dict]
    intensity: str = "medium"  # low / medium / high


@app.get("/api/tts/voices")
def tts_voices():
    return {
        "presets": [
            {"value": k, "label": v["label"], "accepts": v.get("accepts", "any")}
            for k, v in tts_svc.PRESETS.items()
        ],
        "ttl_sec": tts_svc.DEFAULT_TTL_SEC,
    }


@app.post("/api/tts/auto-emotion")
def tts_auto_emotion(req: TtsAutoEmotionRequest):
    """입력 문장들에 LLM으로 어절 감정 자동 할당 (TTS 합성 전 단계)."""
    if not req.sentences:
        raise HTTPException(400, "sentences 비어있음")
    try:
        result = tts_svc.analyze_phrase_emotion(req.sentences, req.intensity)
        logger.info("[tts/auto-emotion] OK count=%d intensity=%s", len(result), req.intensity)
        return {"sentences": result}
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        logger.error("[tts/auto-emotion] FAILED: %s", e)
        raise HTTPException(500, f"감정 분석 실패: {e}")


@app.post("/api/tts/synthesize")
def tts_synthesize(req: TtsSynthRequest):
    if not req.sentences:
        raise HTTPException(400, "sentences 비어있음")
    if req.voice_name not in tts_svc.PRESETS:
        raise HTTPException(400, f"unknown voice preset: {req.voice_name}")
    try:
        tts_svc.cleanup_old_files()
        result = tts_svc.synthesize_script(
            sentences=req.sentences,
            voice_name=req.voice_name,
            model_id=req.model_id,
            emotion_strength=req.emotion_strength,
            persona=req.persona,
            speed_factor=req.speed_factor,
            target_duration=req.target_duration,
            segment_match=req.segment_match,
        )
        logger.info("[tts/synth] OK job=%s voice=%s segs=%d chars=%d dur=%.1fs",
                    result["job_id"], req.voice_name, result["segment_count"],
                    result["char_count"], result["total_duration"])
        return result
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        logger.error("[tts/synth] FAILED: %s", e)
        raise HTTPException(500, f"TTS 합성 실패: {e}")


@app.post("/api/tts/segment")
def tts_regenerate_segment(req: TtsSegmentRequest):
    if not isinstance(req.strength_level, int) or req.strength_level < -2 or req.strength_level > 2:
        raise HTTPException(400, "strength_level은 -2 ~ +2 정수")
    try:
        result = tts_svc.regenerate_segment(req.job_id, req.idx, req.strength_level)
        logger.info("[tts/segment] OK job=%s idx=%d level=%+d",
                    req.job_id, req.idx, req.strength_level)
        return result
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        logger.error("[tts/segment] FAILED: %s", e)
        raise HTTPException(500, f"문장 재합성 실패: {e}")


class TtsUpdatePersonaCueRequest(BaseModel):
    job_id: str
    persona_cue: str


@app.post("/api/tts/update-persona-cue")
def tts_update_persona_cue(req: TtsUpdatePersonaCueRequest):
    """persona cue 변경 → 기존 sentences로 전체 v3 재합성. ElevenLabs 비용 발생 (재합성)."""
    try:
        result = tts_svc.update_persona_cue(req.job_id, req.persona_cue)
        logger.info("[tts/update-persona-cue] OK job=%s cue=%r", req.job_id, req.persona_cue[:50])
        return result
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        logger.error("[tts/update-persona-cue] FAILED: %s", e)
        raise HTTPException(500, f"cue 변경 실패: {e}")


class TtsApplySpeedsRequest(BaseModel):
    job_id: str
    speeds: dict[str, float]  # {idx_string: speed_factor} — JSON 안전한 str key


@app.post("/api/tts/apply-speeds")
def tts_apply_speeds(req: TtsApplySpeedsRequest):
    """post-synth sentence별 speed 조절. 재합성 없이 ffmpeg atempo만 적용."""
    try:
        # str key → int 변환 (frontend가 str로 보냄)
        speeds_int = {int(k): float(v) for k, v in (req.speeds or {}).items()}
        result = tts_svc.apply_segment_speeds(req.job_id, speeds_int)
        logger.info("[tts/apply-speeds] OK job=%s n=%d", req.job_id, len(speeds_int))
        return result
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        logger.error("[tts/apply-speeds] FAILED: %s", e)
        raise HTTPException(500, f"속도 적용 실패: {e}")


@app.get("/api/tts/job/{job_id}")
def tts_job_state(job_id: str):
    try:
        return tts_svc.get_job(job_id)
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))


@app.get("/api/tts/files/{job_id}/{filename}")
def tts_download_job(job_id: str, filename: str):
    p = tts_svc.file_path(job_id, filename)
    if not p:
        raise HTTPException(404, "file not found or expired")
    from fastapi.responses import FileResponse
    return FileResponse(str(p), media_type="audio/mpeg", filename=filename)


# 구버전 호환 (job 폴더 없는 단일 mp3)
@app.get("/api/tts/files/{filename}")
def tts_download_legacy(filename: str):
    p = tts_svc.file_path(filename)
    if not p:
        raise HTTPException(404, "file not found or expired")
    from fastapi.responses import FileResponse
    return FileResponse(str(p), media_type="audio/mpeg", filename=filename)


# ── Seedance 2.0 (fal.ai image→video) ──
_SEEDANCE_MODEL = "bytedance/seedance-2.0/image-to-video"


def _fal_key() -> str:
    k = (os.getenv("SEEDANCE_API_KEY") or os.getenv("FAL_KEY") or "").strip()
    if not k:
        raise HTTPException(500, "SEEDANCE_API_KEY 미설정")
    return k


def _fal_headers(json: bool = True) -> dict:
    h = {"Authorization": f"Key {_fal_key()}"}
    if json:
        h["Content-Type"] = "application/json"
    return h


@app.post("/api/seedance/upload")
async def seedance_upload(request: Request):
    """이미지 파일을 fal storage 에 업로드 → 공개 URL 반환.

    multipart/form-data 로 'file' 필드 수신. fal-client SDK 가 가장 단순해서 그걸 사용.
    """
    auth_svc.require_user(request)
    from fastapi import UploadFile
    form = await request.form()
    file = form.get("file")
    if not file or not hasattr(file, "read"):
        raise HTTPException(400, "file 필수 (multipart)")
    try:
        import fal_client
        os.environ["FAL_KEY"] = _fal_key()
        # 임시 파일로 떨군 뒤 upload_file 호출 (SDK가 path 받음)
        import tempfile
        suffix = Path(getattr(file, "filename", "img.jpg")).suffix or ".jpg"
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tf:
            tf.write(await file.read())
            tmp_path = tf.name
        try:
            url = fal_client.upload_file(tmp_path)
        finally:
            try: os.unlink(tmp_path)
            except: pass
        return {"image_url": url}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("[seedance/upload] failed")
        raise HTTPException(500, f"upload 실패: {e}")


class SeedanceSubmitReq(BaseModel):
    prompt: str
    image_url: str
    resolution: str = "720p"  # 480p / 720p / 1080p
    duration: str = "4"  # 4 ~ 15 (str) 또는 'auto'
    aspect_ratio: str = "9:16"  # 9:16 / 16:9 / 1:1 / 4:3 / 3:4 / 21:9 / auto
    generate_audio: bool = False
    end_image_url: str | None = None
    seed: int | None = None


@app.post("/api/seedance/submit")
def seedance_submit(body: SeedanceSubmitReq, request: Request):
    auth_svc.require_user(request)
    if not body.prompt.strip() or not body.image_url.strip():
        raise HTTPException(400, "prompt + image_url 필수")
    args = {
        "prompt": body.prompt.strip(),
        "image_url": body.image_url,
        "resolution": body.resolution,
        "duration": body.duration,
        "aspect_ratio": body.aspect_ratio,
        "generate_audio": body.generate_audio,
    }
    if body.end_image_url:
        args["end_image_url"] = body.end_image_url
    if body.seed is not None:
        args["seed"] = body.seed
    r = requests.post(
        f"https://queue.fal.run/{_SEEDANCE_MODEL}",
        headers=_fal_headers(json=True),
        json=args, timeout=30,
    )
    if r.status_code not in (200, 202):
        logger.warning("[seedance/submit] HTTP %s: %s", r.status_code, r.text[:300])
        raise HTTPException(r.status_code, r.text[:300])
    data = r.json()
    return {
        "request_id": data.get("request_id"),
        "status_url": data.get("status_url"),
        "response_url": data.get("response_url"),
        "queue_position": data.get("queue_position"),
    }


@app.get("/api/seedance/status")
def seedance_status(request_id: str, request: Request):
    """fal 상태 조회. COMPLETED 면 result 도 같이 fetch 해서 video_url 반환."""
    auth_svc.require_user(request)
    if not request_id:
        raise HTTPException(400, "request_id 필수")
    # status URL — queue 응답 포맷 그대로 재구성 (모델별 prefix 포함)
    status_url = f"https://queue.fal.run/{_SEEDANCE_MODEL}/requests/{request_id}/status"
    result_url = f"https://queue.fal.run/{_SEEDANCE_MODEL}/requests/{request_id}"
    sr = requests.get(status_url, headers=_fal_headers(json=False), timeout=10)
    if sr.status_code != 200:
        # fal queue 가 모델 prefix 없이 응답하는 경우도 있음 — fallback
        logger.warning("[seedance/status] %s: %s", sr.status_code, sr.text[:200])
        raise HTTPException(sr.status_code, sr.text[:200])
    st = sr.json()
    status = st.get("status")
    out = {
        "status": status,
        "queue_position": st.get("queue_position"),
        "logs": st.get("logs") or [],
        "metrics": st.get("metrics") or {},
    }
    if status == "COMPLETED":
        rr = requests.get(result_url, headers=_fal_headers(json=False), timeout=15)
        if rr.status_code == 200:
            res = rr.json()
            out["result"] = res
            v = (res.get("video") or {}) if isinstance(res, dict) else {}
            out["video_url"] = v.get("url")
            out["seed"] = res.get("seed") if isinstance(res, dict) else None
        else:
            out["result_error"] = rr.text[:200]
    return out


# ── Serve built frontend (must be last: catches all non-API routes) ──
_PUBLIC_DIR = Path(__file__).parent.parent / "web" / "dist"


@app.get("/{full_path:path}")
def spa_fallback(full_path: str):
    """정적 자원이 있으면 그걸, 없으면 SPA index.html (React Router 호환).

    Cache 정책:
      - assets/* (Vite content-hashed) → 1년 immutable (해시 바뀌면 자동 새 URL)
      - index.html → no-cache (must-revalidate) — 새 배포 즉시 반영, hash mismatch로 인한 흰화면 방지
      - 기타 (favicon 등) → 1시간 short cache
    """
    from fastapi.responses import FileResponse
    if not _PUBLIC_DIR.is_dir():
        raise HTTPException(503, "frontend not deployed")
    # 정적 파일 (assets/app.js, favicon.svg 등)
    if full_path:
        file = _PUBLIC_DIR / full_path
        if file.is_file() and _PUBLIC_DIR in file.resolve().parents:
            if full_path.startswith("assets/"):
                # content-hash가 박혀 있어서 영구 캐시 안전
                cc = "public, max-age=31536000, immutable"
            else:
                cc = "public, max-age=3600"
            return FileResponse(str(file), headers={"Cache-Control": cc})
    # SPA fallback — React Router가 client-side routing
    # index.html은 무조건 revalidate (옛 asset 참조로 인한 흰화면 방지)
    index = _PUBLIC_DIR / "index.html"
    if index.is_file():
        return FileResponse(
            str(index),
            media_type="text/html",
            headers={"Cache-Control": "no-cache, must-revalidate"},
        )
    raise HTTPException(404, "Not found")
