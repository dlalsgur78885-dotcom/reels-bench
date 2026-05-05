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
from datetime import datetime, timezone

logger = logging.getLogger("uvicorn.error")

from services import supabase, pipeline, thumb, comments, script_gen
from services import secrets as secrets_svc

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


@app.middleware("http")
async def api_key_middleware(request, call_next):
    path = request.url.path
    # /api/* 외 (정적 자원, SPA route)는 무관
    if not path.startswith("/api/"):
        return await call_next(request)
    # 공개 endpoint
    if path in _PUBLIC_API_PATHS:
        return await call_next(request)

    # same-origin (자체 사이트) → skip
    origin = request.headers.get("origin", "")
    referer = request.headers.get("referer", "")
    if any(d in origin for d in _OUR_DOMAINS) or any(d in referer for d in _OUR_DOMAINS):
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
    refine: bool = True  # False = 1차만 (draft), True = 1차+2차
    target_persona: dict | None = None  # { name, scenario, signals, tone_hint }
    usp_mapping_override: dict[str, int] | None = None  # ref_usp_id(str)→user_usp_id (wizard 수동 매핑)


@app.post("/api/script/generate")
def gen_script(req: ScriptGenRequest):
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
    try:
        script_gen.reset_cost_meter()
        # str→int 변환 (JSON dict key는 string)
        override = None
        if req.usp_mapping_override:
            override = {int(k): v for k, v in req.usp_mapping_override.items() if v is not None}
        result = script_gen.generate(
            product_name=req.product_name,
            pain=req.pain,
            desire=req.desire,
            usps=req.usps or [],
            reference_shortcodes=req.reference_shortcodes,
            refine=req.refine,
            target_persona=req.target_persona,
            usp_mapping_override=override,
        )
        n_sentences = len(result.get("sentences") or [])
        cost = script_gen.summarize_cost()
        result["_cost"] = cost
        logger.info(
            "[script/gen] DONE sentences=%d duration=%s refined=%s cost=$%.4f (%d calls, in=%d out=%d)",
            n_sentences, result.get("duration_target_sec"), result.get("_refined", False),
            cost["total_cost_usd"], cost["total_calls"], cost["total_in_tokens"], cost["total_out_tokens"],
        )
        return result
    except Exception as e:
        logger.error("[script/gen] FAILED: %s", e)
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
    # 보존: 누적된 분석 필드들
    for k in ("usp_layout", "ad_format", "ad_suitability_score", "ad_format_reason",
              "section_roles", "body_chunks"):
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


@app.post("/api/script/reanalyze-usp-layout/{shortcode}")
def reanalyze_usp_layout_for_reel(shortcode: str, request: Request):
    """analyze_usp_layout 강화된 룰(1 USP = 1 차원)로 재실행 → overall.usp_layout 갱신.
    body_chunks도 함께 재분석해 정합성 유지.
    """
    auth_svc.require_user(request)
    ref = script_gen.fetch_reference(shortcode)
    if not ref:
        raise HTTPException(404, "참고 릴스 없음")
    sentences = ref.get("sentences") or []
    if not sentences or not any(s.get("section") for s in sentences):
        raise HTTPException(400, "section 라벨된 sentences 필요")

    layout = script_gen.analyze_usp_layout(sentences)
    if not layout:
        raise HTTPException(500, "usp_layout 재분석 실패")

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
    overall["usp_layout"] = layout["ref_usps"]
    if layout.get("ad_format"):
        overall["ad_format"] = layout["ad_format"]
    if layout.get("ad_suitability_score") is not None:
        overall["ad_suitability_score"] = layout["ad_suitability_score"]
    if layout.get("ad_format_reason"):
        overall["ad_format_reason"] = layout["ad_format_reason"]

    # body_chunks도 재분석 (새 layout에 맞춰 매핑 갱신)
    ref_updated = dict(ref)
    ref_updated["structure"] = dict(ref.get("structure") or {})
    ref_updated["structure"]["overall"] = overall
    chunks = script_gen.analyze_section_chunks(ref_updated)
    if chunks:
        overall["section_chunks"] = chunks
        overall["body_chunks"] = [
            {**c, "body_n": c["section"]} for c in chunks if c.get("section", "").startswith("body")
        ]

    _r.patch(
        f"{SUPA}/rest/v1/reels_script_structure?shortcode=eq.{shortcode}",
        headers={**H, "Prefer": "return=minimal"},
        json={"overall": overall}, timeout=15,
    )
    return {
        "shortcode": shortcode,
        "usp_layout": layout["ref_usps"],
        "usp_count": len(layout["ref_usps"]),
        "body_chunks": chunks if chunks else [],
    }


@app.post("/api/script/analyze-section-chunks/{shortcode}")
def analyze_section_chunks_for_reel(shortcode: str, request: Request):
    """모든 섹션(hook/intro/body_N/cta) chunk별 분석. overall.section_chunks에 저장 (+ body_chunks 호환 alias)."""
    auth_svc.require_user(request)
    ref = script_gen.fetch_reference(shortcode)
    if not ref:
        raise HTTPException(404, "참고 릴스 없음")
    sentences = ref.get("sentences") or []
    if not any(s.get("section") for s in sentences):
        raise HTTPException(400, "section 라벨된 sentences 필요")
    chunks = script_gen.analyze_section_chunks(ref)
    if not chunks:
        raise HTTPException(500, "section chunk 분석 실패")
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
    overall["section_chunks"] = chunks
    overall["body_chunks"] = [
        {**c, "body_n": c["section"]} for c in chunks if c.get("section", "").startswith("body")
    ]
    _r.patch(
        f"{SUPA}/rest/v1/reels_script_structure?shortcode=eq.{shortcode}",
        headers={**H, "Prefer": "return=minimal"},
        json={"overall": overall}, timeout=15,
    )
    return {"shortcode": shortcode, "chunks": chunks, "count": len(chunks)}


class PreviewMappingRequest(BaseModel):
    product_id: int


@app.post("/api/script/preview-mapping/{shortcode}")
def preview_mapping(shortcode: str, body: PreviewMappingRequest, request: Request):
    """대본 생성 wizard용 — pre-planner만 돌려서 ref USP ↔ user USP 매핑 미리보기.

    전체 생성을 안 돌리므로 빠름 (Gemini 1회). 매칭/미매칭 USP 분석 + chunk 컨텍스트 같이 반환.
    """
    auth_svc.require_user(request)
    SUPA = (os.getenv("SUPABASE_URL") or "").strip()
    SK = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    _r = supabase.get_session()
    H = {"apikey": SK, "Authorization": f"Bearer {SK}"}

    # 1. ref + section_chunks + usp_layout 로드
    ref = script_gen.fetch_reference(shortcode)
    if not ref:
        raise HTTPException(404, "참고 릴스 없음")
    overall = ((ref.get("structure") or {}).get("overall") or {})
    ref_usps = overall.get("usp_layout") or []
    section_chunks = overall.get("section_chunks") or []
    if not section_chunks:
        section_chunks = script_gen.analyze_section_chunks(ref) or []
    if not ref_usps:
        raise HTTPException(400, "usp_layout 없음 — 먼저 reanalyze-usp-layout 실행 필요")

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

    # 3. pre-planner 호출 (truncation 방지 — max_tokens 넉넉히)
    prompt = script_gen._build_pre_planner_prompt(user_usps, ref_usps, section_chunks)
    try:
        result = script_gen.call_gemini(prompt, model="gemini-3.1-pro-preview", max_tokens=4096)
        if isinstance(result, list) and result:
            result = result[0]
    except Exception as e:
        raise HTTPException(500, f"pre-planner 실패: {e}")

    # 4. mapping 보강 (ref/user 라벨 + reason)
    ref_by_id = {ru.get("id"): ru for ru in ref_usps if isinstance(ru.get("id"), int)}
    raw_map = result.get("usp_mapping") or []
    mapping_full: list[dict] = []
    for m in raw_map:
        rid = m.get("ref_usp_id")
        uid = m.get("user_usp_id")
        if not isinstance(rid, int):
            continue
        resolved_uid = uid if isinstance(uid, int) and 1 <= uid <= len(user_usps) else None
        ref_meta = ref_by_id.get(rid) or {}
        mapping_full.append({
            "ref_usp_id": rid,
            "ref_label": ref_meta.get("label", ""),
            "ref_description": ref_meta.get("description", ""),
            "ref_appears_in": ref_meta.get("appears_in") or [],
            "user_usp_id": resolved_uid,
            "user_usp_name": user_usps[resolved_uid - 1].get("usp", "") if resolved_uid else None,
            "reason": m.get("reason", ""),
        })

    # 5. gap 분석
    matched_user_ids = {m["user_usp_id"] for m in mapping_full if m["user_usp_id"]}
    unused_user = [
        {"user_usp_id": i + 1, "user_usp_name": u.get("usp", "")}
        for i, u in enumerate(user_usps) if (i + 1) not in matched_user_ids
    ]
    unmatched_ref = [m for m in mapping_full if m["user_usp_id"] is None]

    return {
        "shortcode": shortcode,
        "product": {"id": product["id"], "name": product.get("name", ""), "usps": user_usps},
        "ref_usps": ref_usps,
        "section_chunks": section_chunks,
        "usp_mapping": mapping_full,
        "unused_user_usps": unused_user,
        "unmatched_ref_usps": unmatched_ref,
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


@app.post("/api/script/classify-sentences/{shortcode}")
def classify_sentences_for_reel(
    shortcode: str, request: Request,
    resegment: bool = Query(True, description="다중 문장 segment를 문장 단위로 쪼갠 후 분류"),
):
    """기존 분석된 릴스에 sentence-level section 분류 backfill."""
    auth_svc.require_user(request)
    SUPA = (os.getenv("SUPABASE_URL") or "").strip()
    SK = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    _r = supabase.get_session()
    H = {"apikey": SK, "Authorization": f"Bearer {SK}"}
    # 1. transcripts + structure 가져오기
    trans = _r.get(
        f"{SUPA}/rest/v1/reels_transcripts?shortcode=eq.{shortcode}&select=transcript,segments&limit=1",
        headers=H, timeout=10,
    ).json()
    if not trans:
        raise HTTPException(404, "transcript 없음")
    sentences = trans[0].get("segments") or []
    transcript = trans[0].get("transcript", "")
    if not sentences:
        raise HTTPException(400, "sentences 없음")
    # 1.5. 옵션: 다중 문장 segment를 문장 단위로 분할 (script_gen 모듈에서 정본 helper 제공)
    if resegment:
        sentences = script_gen.resegment_to_sentences(sentences)
    struct = _r.get(
        f"{SUPA}/rest/v1/reels_script_structure?shortcode=eq.{shortcode}&select=hook,intro,body,cta&limit=1",
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
    # 3. 저장 (UPSERT)
    upsert_url = f"{SUPA}/rest/v1/reels_transcripts?on_conflict=shortcode"
    r = _r.post(upsert_url, headers={
        **H,
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates,return=minimal",
    }, json={
        "shortcode": shortcode,
        "transcript": transcript,
        "language": "ko",
        "segments": classified,
    }, timeout=15)
    if r.status_code not in (200, 201, 204):
        raise HTTPException(r.status_code, r.text[:200])
    # 캐시 무효화 — sentences override 즉시 반영
    cached = pipeline.extra_cache.get(shortcode)
    if isinstance(cached, dict):
        cached["sentences"] = classified
        pipeline.extra_cache[shortcode] = cached
    # 분류 통계
    from collections import Counter
    sec_counts = Counter(c.get("section", "?") for c in classified)
    return {
        "shortcode": shortcode,
        "total_sentences": len(classified),
        "sections": dict(sec_counts),
    }


@app.get("/api/script/reference-info/{shortcode}")
def reference_info(shortcode: str):
    """참고 릴스의 구조 정보 (분류·문장 수·body 슬롯 수) — UI 가이드용.

    recommended_usps는 분석 단계에서 결정된 usp_layout(구조화된 USP 분류)을 정본으로 사용.
    이게 분석 페이지(BenchDetail)에 표시되는 USP 개수와 일치한다.
    """
    try:
        ref = script_gen.fetch_reference(shortcode)
        if not ref:
            raise HTTPException(404, "참고 릴스 데이터 없음")
        props = script_gen.analyze_reference_proportions(ref)
        body_class = script_gen.classify_body_structure(ref)
        body_slot_count = len(props.get("body_slots") or [])
        # 정본: usp_layout 길이 (분석 결과). 없으면 body_class 기반 fallback
        overall = ((ref.get("structure") or {}).get("overall") or {})
        usp_layout = overall.get("usp_layout") or []
        if usp_layout:
            recommended = len(usp_layout)
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
            "usp_layout_count": len(usp_layout) if usp_layout else None,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"참고 분석 실패: {e}")


class ScriptRefineRequest(BaseModel):
    draft: dict
    usps: list[dict] = []  # 통일 도시 추출용
    reference_shortcode: str | None = None  # 참고 길이 매칭용


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
        prompt = script_gen.build_refine_prompt(req.draft, unified.get("city"), ref_info=ref_info, usps=req.usps, awkward_info=awkward_info)
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

class SecretUpsertRequest(BaseModel):
    name: str
    value: str
    description: str = ""


@app.get("/api/admin/secrets")
def list_secrets(request: Request):
    """admin: 등록된 시크릿 메타정보 (값 X)."""
    auth_svc.require_admin(request)
    try:
        items = secrets_svc.list_secrets()
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
        return {"id": sid, "name": req.name, "message": "갱신 완료"}
    except Exception as e:
        raise HTTPException(500, f"시크릿 저장 실패: {e}")


@app.delete("/api/admin/secrets/{name}")
def delete_secret(name: str, request: Request):
    """admin: 시크릿 삭제."""
    auth_svc.require_admin(request)
    try:
        ok = secrets_svc.delete_secret(name)
        return {"deleted": ok}
    except Exception as e:
        raise HTTPException(500, f"시크릿 삭제 실패: {e}")


# ── My Products ──

class MyProductIn(BaseModel):
    name: str
    persona: str | None = None
    usps: list[dict] = []


_MY_PRODUCTS_CACHE_TTL = 20
_my_products_cache: dict[str, tuple[float, list]] = {}
_shareable_users_cache: dict[str, tuple[float, list]] = {}


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
        json={"owner_id": me["id"], "name": req.name, "persona": req.persona, "usps": req.usps},
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
        json={"name": req.name, "persona": req.persona, "usps": req.usps},
        timeout=10,
    )
    if r.status_code not in (200, 204):
        raise HTTPException(r.status_code, r.text[:200])
    _invalidate_my_products_cache()
    return r.json()[0] if r.json() else {}


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


@app.get("/api/users")
def list_users(request: Request):
    """admin: 전체 직원 목록."""
    auth_svc.require_admin(request)
    SUPA = (os.getenv("SUPABASE_URL") or "").strip()
    KEY = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_ANON_KEY") or "").strip()
    _r = supabase.get_session()
    r = _r.get(
        f"{SUPA}/rest/v1/profiles?select=id,email,display_name,role,active,can_delete_reels,created_at,last_login_at&order=created_at.desc",
        headers={"apikey": KEY, "Authorization": f"Bearer {KEY}"},
        timeout=15,
    )
    return r.json() if r.status_code == 200 else []


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
    need_script = not data.get("script_structure")
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
        items.append({
            "shortcode": sc,
            "url": r.get("url") or "",
            "page_name": m.get("author_username") or "",
            "caption": m.get("caption_text") or "",
            "video_url": m.get("video_url") or "",
            "video_duration": m.get("video_duration") or 0,
            "thumbnail_url": m.get("thumbnail_url") or "",
            "collected_at": r.get("collected_at") or "",
            # 향후 facebook ads 프로젝트 ads 테이블 연결 시 채워질 필드
            "start_date": "",
            "media_type": "video" if m.get("video_url") else "image",
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
    background_tasks.add_task(pipeline.run, req.shortcode)
    pipeline.analysis_status[req.shortcode] = {"status": "running", "step": "시작", "progress": 0}
    return {"message": "분석 시작", "shortcode": req.shortcode}

@app.get("/api/analysis-status/{shortcode}")
def get_analysis_status(shortcode: str):
    return pipeline.analysis_status.get(shortcode, {"status": "idle"})


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
_CHANNELS_CACHE_TTL = 60
_USER_ANALYSIS_CACHE_TTL = 60


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
    return {"items": items, "total": len(items)}


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
def fb_search_ads(q: str = Query(""), limit: int = Query(50, ge=1, le=200)):
    """캐시된 fb_* reels에서 키워드 매칭 광고."""
    SUPA = (os.getenv("SUPABASE_URL") or "").strip()
    SK = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    H = {"apikey": SK, "Authorization": f"Bearer {SK}"}
    _r = supabase.get_session()
    rows = _r.get(
        f"{SUPA}/rest/v1/reels_metadata?shortcode=like.fb_*"
        f"&select=shortcode,author_username,caption_text,thumbnail_url,video_duration,video_url"
        f"&limit=2000",
        headers=H, timeout=15,
    ).json() or []
    if q:
        ql = q.lower()
        rows = [m for m in rows if
                ql in (m.get("caption_text") or "").lower() or
                ql in (m.get("author_username") or "").lower()]
    rows.sort(key=lambda r: r.get("shortcode") or "", reverse=True)
    return {"items": rows[:limit], "total": len(rows), "query": q}


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


# ── Serve built frontend (must be last: catches all non-API routes) ──
_PUBLIC_DIR = Path(__file__).parent.parent / "web" / "dist"


@app.get("/{full_path:path}")
def spa_fallback(full_path: str):
    """정적 자원이 있으면 그걸, 없으면 SPA index.html (React Router 호환)."""
    from fastapi.responses import FileResponse
    if not _PUBLIC_DIR.is_dir():
        raise HTTPException(503, "frontend not deployed")
    # 정적 파일 (assets/app.js, favicon.svg 등)
    if full_path:
        file = _PUBLIC_DIR / full_path
        if file.is_file() and _PUBLIC_DIR in file.resolve().parents:
            return FileResponse(str(file))
    # SPA fallback — React Router가 client-side routing
    index = _PUBLIC_DIR / "index.html"
    if index.is_file():
        return FileResponse(str(index), media_type="text/html")
    raise HTTPException(404, "Not found")
