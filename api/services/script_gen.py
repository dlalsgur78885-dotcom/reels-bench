"""경쟁사 릴스 분석 데이터 + 우리 제품/페르소나/USP+리뷰 → 새 대본 생성.

Gemini 3 Pro 사용 (이미 등록된 GEMINI_API_KEY 활용, 추가 비용 없음).
"""
from __future__ import annotations

import os
import json
import logging
from typing import Any
import requests

from . import supabase
from . import secrets as secrets_svc

logger = logging.getLogger(__name__)

MODEL = "gemini-3.1-pro-preview"

# 비용 추적 — call_gemini가 매 호출마다 토큰 사용량 추가, summarize_cost가 누적·합산
_cost_meter: list[dict] = []

# 단가 (USD per 1M tokens) — Gemini 3 Pro/Flash Preview
_PRICING = {
    "gemini-3.1-pro-preview": {"in": 2.0, "out": 12.0},
    "gemini-3-pro-preview": {"in": 2.0, "out": 12.0},
    "gemini-3-flash-preview": {"in": 0.30, "out": 2.50},
}


def reset_cost_meter() -> None:
    _cost_meter.clear()


def summarize_cost() -> dict:
    """현재까지 집계된 토큰·비용 합산."""
    by_model: dict[str, dict] = {}
    total_in = 0
    total_out = 0
    total_cost = 0.0
    for c in _cost_meter:
        m = c["model"]
        if m not in by_model:
            by_model[m] = {"calls": 0, "in": 0, "out": 0, "cost_usd": 0.0}
        p = _PRICING.get(m, {"in": 2.0, "out": 12.0})
        cost = (c["in_tokens"] * p["in"] + c["out_tokens"] * p["out"]) / 1_000_000
        by_model[m]["calls"] += 1
        by_model[m]["in"] += c["in_tokens"]
        by_model[m]["out"] += c["out_tokens"]
        by_model[m]["cost_usd"] += cost
        total_in += c["in_tokens"]
        total_out += c["out_tokens"]
        total_cost += cost
    return {
        "by_model": by_model,
        "total_calls": len(_cost_meter),
        "total_in_tokens": total_in,
        "total_out_tokens": total_out,
        "total_cost_usd": round(total_cost, 4),
    }


def _gemini_key() -> str:
    """매 호출마다 캐시된 키 조회 (env > Vault > '')."""
    return secrets_svc.get_secret("GEMINI_API_KEY", "")


_KOR_SYL_PER_SEC = 4.5  # 한국어 평균 발화 속도 (음절/초)


_INTERJECTION_TOKENS = {
    "호와", "와", "와우", "워", "워우", "어머", "어머나", "헐", "엥", "엣", "엠", "음",
    "오", "오오", "오우", "와아", "에이", "아", "아아", "아하", "이야", "이야아",
    "허", "헉", "핵", "쩐다", "찐", "진짜", "진심", "ㅋㅋ", "ㅎㅎ", "헤헤",
    "응", "아니", "어", "ㅇㅇ",
}

def _is_interjection_text(text: str) -> bool:
    """짧은 감탄어/호응어인지 판정. True면 LLM이 제품 기능을 채우지 않도록."""
    if not text:
        return False
    cleaned = text.strip().rstrip(".!?~ ").strip()
    if not cleaned:
        return False
    # 어절 수
    words = cleaned.split()
    if len(words) > 2:
        return False
    syl = _count_kor_syllables(cleaned)
    if syl > 4:
        return False
    # 알려진 감탄어 또는 짧은 단음절 + 감탄부호
    if cleaned in _INTERJECTION_TOKENS:
        return True
    # 매우 짧고 (3음절 이하) 마침표 없이 끝남
    if syl <= 3:
        return True
    return False


def _count_kor_syllables(text: str) -> int:
    """한국어 음절 수 (한글 + 라틴 단어 1단어=2음절 가산 근사)."""
    import re
    hangul = len(re.findall(r"[가-힣]", text))
    roman = len(re.findall(r"\b[A-Za-z]+\b", text)) * 2
    return hangul + roman


def _parse_section_seconds(s: str | None) -> tuple[float, float] | None:
    """'0-4초', '6.2~9.5s', '6:00-6:04' 등 → (start, end) seconds."""
    if not s: return None
    import re
    m = re.findall(r"\d+(?:\.\d+)?", str(s))
    if len(m) >= 2:
        return float(m[0]), float(m[1])
    return None


def extract_narrative_roles(ref: dict) -> dict:
    """Gemini Flash로 참고 릴스의 섹션별 narrative role 추출.

    각 섹션이 광고 흐름에서 수행하는 **역할**을 한 줄로 정리.
    이걸 build_prompt에 주입해 생성 LLM이 단순 반복이 아닌 흐름을 따라가게 강제.

    Returns: {"hook": {role, what_it_does, must_not_repeat}, "intro": {...}, "body_1": {...}, ...}
    """
    sentences = ref.get("sentences") or []
    if not sentences:
        return {}

    # section별 문장 묶기
    by_sec: dict[str, list[dict]] = {}
    for s in sentences:
        sec = (s.get("section") or "").lower()
        if not sec:
            continue
        by_sec.setdefault(sec, []).append(s)
    if not by_sec:
        return {}

    # body_N 시간순 정렬
    sec_order = ["hook", "intro"] + sorted([k for k in by_sec if k.startswith("body")]) + ["cta"]
    sec_lines: list[str] = []
    for sec in sec_order:
        if sec not in by_sec:
            continue
        sec_lines.append(f"\n[{sec.upper()}]")
        for s in by_sec[sec]:
            sec_lines.append(f"  ({float(s.get('start',0)):.1f}-{float(s.get('end',0)):.1f}s) \"{s.get('text','')}\"")

    prompt = f"""다음은 광고 릴스의 섹션별 문장입니다. 각 섹션이 **광고 흐름**에서 수행하는 narrative role을 분석하세요.

{chr(10).join(sec_lines)}

각 섹션마다:
- **role**: 한 문장. 이 섹션이 광고에서 수행하는 핵심 역할 (예: "혜택을 약속", "사용법 시연", "추가 꿀팁 제시", "차별점 입증", "행동 유도")
- **what_it_does**: 한 문장. 정보 전환의 구체 방향 (예: "Intro에서 약속한 '앱으로 자리 변경'을 실제 작동법으로 풀어냄")
- **must_not_repeat**: 한 문장. 다른 섹션에서 이미 다뤘으니 겹치면 안 되는 내용

⚠️ 룰:
- 같은 단어로 반복 금지 (각 섹션은 흐름의 다른 단계여야 함)
- 단순 묘사 X — 광고 카피 관점에서 정보 단계가 어떻게 advance하는지

JSON만 출력. 빈 섹션은 제외.
{{
  "hook": {{"role": "...", "what_it_does": "...", "must_not_repeat": "..."}},
  "intro": {{...}},
  "body_1": {{...}},
  "cta": {{...}}
}}"""
    try:
        result = call_gemini(prompt, model="gemini-3-flash-preview", max_tokens=2048)
        if isinstance(result, list) and result:
            result = result[0]
        return result if isinstance(result, dict) else {}
    except Exception as e:
        logger.warning("extract_narrative_roles failed: %s", e)
        return {}


def analyze_section_chunks(ref: dict) -> list[dict]:
    """섹션별 chunk 상세 분석 — hook/intro/body_N/cta 전부.

    각 chunk마다:
    - section: chunk 라벨 (hook / intro / body_1 / cta 등)
    - sentences: 이 chunk의 문장들
    - topic: 한 줄 요약
    - usp_ids: 다루는 USP id 배열 (engagement·promise만이면 빈 배열)
    - primary_usp_id: 가장 핵심 1개 (없으면 null)
    - role: chunk 역할 (engagement / promise / 시연 / proof / 전환 / 요약 / callback / 행동유도 / 감성 / 디테일)
    - relation_to_prev: 이전 chunk와의 관계 (start / 확장 / 대조 / 심화 / 새토픽 / 회수 / 요약)
    - summary: 한 줄 — chunk가 시청자에게 어떻게 작용하는지
    """
    sentences = ref.get("sentences") or []
    if not sentences:
        return []

    # 모든 섹션 grouping (시간순)
    body_groups: dict[str, list[dict]] = {}
    for s in sentences:
        sec = (s.get("section") or "").lower()
        if sec and sec != "?":
            body_groups.setdefault(sec, []).append(s)
    if not body_groups:
        return []
    # 섹션 순서: hook → intro → body_1..N → body → cta
    def _order_key(k: str) -> tuple:
        if k == "hook": return (0, 0)
        if k == "intro": return (1, 0)
        if k.startswith("body_"):
            try: return (2, int(k.split("_")[1]))
            except: return (2, 99)
        if k == "body": return (2, 999)
        if k == "cta": return (3, 0)
        return (9, 0)
    sorted_keys = sorted(body_groups.keys(), key=_order_key)

    # usp_layout 매핑 — body_N → usp_id
    structure = ref.get("structure") or {}
    overall = structure.get("overall") or {}
    usp_layout = overall.get("usp_layout") or []
    body_to_usp: dict[str, list[int]] = {}
    for u in usp_layout:
        for sec in (u.get("appears_in") or []):
            sec_l = sec.lower()
            body_to_usp.setdefault(sec_l, []).append(u.get("id"))

    # Gemini 프롬프트 — chunk별 분석 요청
    chunk_lines = []
    for k in sorted_keys:
        sents = body_groups[k]
        chunk_lines.append(f"\n[{k.upper()}]")
        for s in sents:
            chunk_lines.append(f"  ({float(s.get('start',0)):.1f}-{float(s.get('end',0)):.1f}s) \"{s.get('text','')}\"")

    usp_block = ""
    if usp_layout:
        usp_block = "\n## 분석된 USP layout (참고용 — 어느 chunk에 어느 USP가 배치됐는지 이미 알려져 있음)\n"
        for u in usp_layout:
            usp_block += f"- USP {u.get('id')} [{u.get('label')}]: {u.get('description', '')} (등장: {', '.join(u.get('appears_in') or [])})\n"

    # 모든 문장에 idx 부여 (section + sentence-index)
    enumerated_sents = []
    for k in sorted_keys:
        for s in body_groups[k]:
            enumerated_sents.append((k, s))

    sent_with_idx = []
    for i, (sec, s) in enumerate(enumerated_sents):
        sent_with_idx.append(f"  [{i}] {sec.upper()} ({float(s.get('start',0)):.1f}-{float(s.get('end',0)):.1f}s) \"{s.get('text','')}\"")

    prompt = f"""광고 릴스의 모든 섹션을 **chunk 단위로 분할 후 분석**.

⭐ 핵심: **한 섹션 안에서 design feature/mechanism이 바뀌면 sub-chunk로 분할** (body_1 안에 mechanism 2개 → body_1a / body_1b). 같은 mechanism의 여러 효과는 한 chunk로 묶음.

{usp_block}
## 모든 문장 (idx 0-based, 시간순)
{chr(10).join(sent_with_idx)}

## 분할 룰

### chunk 경계 = **다른 design feature/mechanism**이 새로 등장할 때
**한 chunk = 하나의 design feature(브이넥 / 셔링·절개 / 모달 안감 / 스트랩 / 단추 / 리본 등)가 만들어내는 효과들의 묶음.**

- **같은 mechanism의 여러 효과 = 같은 chunk** (예: "셔링·절개로 가슴 라인 예쁘게 + 부유방 커버까지" → 둘 다 셔링·절개의 효과 → 한 chunk)
- **다른 mechanism이 등장 = split** (예: 브이넥 라인 → 셔링·절개 → 모달 안감 = 3 chunk)

말로 mechanism이 명시되지 않더라도, 발언의 화제가 "어떤 디자인 요소"에서 "다른 디자인 요소"로 옮겨가면 split.
**"~로 / ~으로 / ~에 / ~까지" 같은 연결어에 주의**: "셔링으로 ~ + 부유방 커버까지"의 "까지"는 같은 mechanism의 추가 효과 → 묶음.

### 룰
1. **Hook/Intro/CTA**: 분할 X (engagement·promise·callback이면 그대로)
2. **Body_N**: 다른 mechanism 등장 시 split — 라벨은 body_1a, body_1b, body_1c...
3. 효과 나열로 인한 split은 금지 (방지+창출+보정이 한 mechanism에서 나오면 한 chunk)
4. usp_layout의 USP가 chunk angle과 정확히 맞지 않으면 가장 가까운 id 선택 + topic·summary로 명시

### 예시
- body_1 = "브이넥(가슴골 가림) + 셔링·절개(라인 예쁘게 + 부유방 커버)"
  → body_1a (브이넥) / body_1b (셔링·절개) — 2-way split
  → ❌ 3-way split 금지: 라인 미관과 부유방 커버는 같은 셔링·절개 mechanism이라 묶음
- body_1 = "스트랩 조절 + 모달 안감 촉감"
  → body_1a (스트랩) / body_1b (모달) — 다른 mechanism
- body_2 = "리본 + 단추" 둘 다 디자인 포인트, 화제가 옮겨감
  → body_2a (리본) / body_2b (단추) 가능하나 한 문장씩이면 묶어도 OK
- ❌ 같은 mechanism의 효과 나열을 split하지 말 것

## 각 chunk 출력
- section: 분할된 라벨 (hook / intro / body_1 / body_1a / body_2b / cta 등)
- sentence_idxs: 이 chunk가 포함하는 문장 idx 배열 (위 0-based)
- topic: 핵심 토픽 (15자 이내)
- usp_ids: 다루는 USP id 배열 (보통 1개, engagement/promise/callback이면 [])
- primary_usp_id: 가장 핵심 1개 (없으면 null)
- role: chunk 역할
  - Hook: engagement / pain제기 / tease / 직접소개
  - Intro: promise / 문제 정의 / 맥락 도입 / 직접 USP 도입
  - Body: 시연 / proof / 비교 / 디테일 / 전환 / 감성 / 요약
  - CTA: callback / 행동유도 / 인센티브 / 재강조
- relation_to_prev: start / 확장 / 대조 / 심화 / 새토픽 / 회수 / 요약
- summary: 한 줄

### ⭐ CTA primary_usp_id 룰
- **특정 USP의 기능·혜택을 직접 명시 / 재강조** → 그 USP id
- **"모든 정보 / 한 번에 / 통합 / 위 모든 ~ / 다 받고 싶다면"** 같이 **여러 USP 통합 호소** → **primary_usp_id = null** + usp_ids에 등장한 모든 id 배열로
- **"팔로우 / 저장 / 댓글 / 공유 / DM / 링크"** 같은 **generic 액션만** + 특정 USP 재언급 X → **primary_usp_id = null** + usp_ids = []
- 예시:
  - "다다의 팔로우하고 댓글에 일본 쿠폰 남겨줘 / DM으로 쏴줄게" → primary=null (generic action + "쿠폰"은 모든 USP 통칭)
  - "이 모든 정보를 한 번에" → primary=null, usp_ids=[1,2,3]
  - "이 잠옷 하나로 해결" (특정 제품 재강조) → primary=MAIN id

JSON만:
{{
  "chunks": [
    {{"section": "hook", "sentence_idxs": [0,1], "topic": "...", "usp_ids": [], "primary_usp_id": null, "role": "engagement", "relation_to_prev": "start", "summary": "..."}},
    {{"section": "body_1a", "sentence_idxs": [3,4], "topic": "브이넥 가림", "usp_ids": [2], "primary_usp_id": 2, "role": "디테일", "relation_to_prev": "새토픽", "summary": "브이넥 라인으로 가슴골 노출 방지"}},
    {{"section": "body_1b", "sentence_idxs": [5,6,7], "topic": "셔링·절개 효과", "usp_ids": [2,3], "primary_usp_id": 2, "role": "디테일", "relation_to_prev": "확장", "summary": "셔링·절개로 가슴라인 미관 + 부유방 커버"}},
    {{"section": "cta", "sentence_idxs": [12,13,14], "topic": "팔로우+DM 통합 호소", "usp_ids": [1,2,3], "primary_usp_id": null, "role": "행동유도", "relation_to_prev": "회수", "summary": "모든 USP를 통합 회수 + 팔로우/DM generic 액션"}}
  ]
}}"""

    try:
        result = call_gemini(prompt, model="gemini-3-flash-preview", max_tokens=4096)
        if isinstance(result, list) and result:
            result = result[0]
        chunks_raw = (result or {}).get("chunks") or []
    except Exception as e:
        logger.warning("analyze_section_chunks Gemini failed: %s", e)
        chunks_raw = []

    # 결과 처리: sentence_idxs로 chunk 구성 (split된 sub-chunk도 sentence 기반)
    out = []
    for c in chunks_raw:
        sec = (c.get("section") or c.get("body_n") or "").lower()
        idxs = c.get("sentence_idxs") or []
        # 정수 캐스트
        idxs = [int(i) for i in idxs if isinstance(i, (int, float)) or (isinstance(i, str) and str(i).isdigit())]
        # 유효 범위
        idxs = [i for i in idxs if 0 <= i < len(enumerated_sents)]
        if not idxs:
            continue
        chunk_sents = [enumerated_sents[i][1] for i in idxs]

        usp_ids = c.get("usp_ids") or []
        usp_ids = list({int(u) for u in usp_ids if isinstance(u, (int, float)) or (isinstance(u, str) and str(u).isdigit())})
        # 빈 배열인데 USP-bearing section이면 layout fallback
        base_sec = sec.rstrip("abcdefghij")  # body_1a → body_1
        if not usp_ids and base_sec in body_to_usp:
            usp_ids = list(dict.fromkeys(body_to_usp[base_sec]))
        primary = c.get("primary_usp_id")
        if primary is not None:
            try: primary = int(primary)
            except: primary = None
        if primary is None and usp_ids:
            primary = usp_ids[0]
        if primary is not None and primary not in usp_ids:
            usp_ids = [primary] + usp_ids

        out.append({
            "section": sec,
            "sentences": [{"start": s.get("start"), "end": s.get("end"), "text": s.get("text")} for s in chunk_sents],
            "topic": c.get("topic", ""),
            "usp_ids": usp_ids,
            "primary_usp_id": primary,
            "role": c.get("role", ""),
            "relation_to_prev": c.get("relation_to_prev", ""),
            "summary": c.get("summary", ""),
        })

    # 시간순 정렬 (chunk의 첫 문장 start 기준)
    out.sort(key=lambda c: (c["sentences"][0]["start"] if c["sentences"] else 0))
    # 첫 chunk relation_to_prev → start
    if out and not out[0]["relation_to_prev"]:
        out[0]["relation_to_prev"] = "start"
    return out


# 호환 alias — 기존 호출처가 사용
def analyze_body_chunks(ref: dict) -> list[dict]:
    """deprecated alias — analyze_section_chunks 호출. body_n 키로 변환해 backward compat."""
    chunks = analyze_section_chunks(ref)
    out = []
    for c in chunks:
        c2 = dict(c)
        c2["body_n"] = c2.pop("section")  # 구식 키
        out.append(c2)
    return out


def parse_frame_ocr_from_analysis(analysis_text: str) -> list[tuple[int, str]]:
    """opus_analyses.analysis에서 [N초] ... 화면텍스트: \"TEXT\" 형식 파싱.

    Returns: [(seconds, text), ...] 시간순.
    """
    import re as _re
    out: list[tuple[int, str]] = []
    for line in (analysis_text or "").split("\n"):
        m = _re.search(r"\[(\d+)\s*초?\][^\n]*?화면텍스트\s*[:\uff1a]\s*[\"\u201c\u201d]([^\"\u201c\u201d\n]*)[\"\u201c\u201d]", line)
        if not m:
            continue
        sec = int(m.group(1))
        text = m.group(2).strip()
        if text:
            out.append((sec, text))
    return out


def build_transcript_from_ocr(ocr_pairs: list[tuple[int, str]], video_dur: float) -> tuple[str, list[dict]]:
    """프레임별 OCR을 transcript + segments로 변환.

    연속된 동일 텍스트는 하나의 segment로 합침.
    Returns: (transcript_text, segments_list)
    """
    if not ocr_pairs:
        return "", []
    pairs = sorted(ocr_pairs, key=lambda p: p[0])
    groups: list[tuple[int, int, str]] = []
    cur_text: str | None = None
    cur_start = 0
    cur_end = 0
    for sec, text in pairs:
        if text == cur_text:
            cur_end = sec + 1
        else:
            if cur_text is not None:
                groups.append((cur_start, cur_end, cur_text))
            cur_text = text
            cur_start = sec
            cur_end = sec + 1
    if cur_text is not None:
        groups.append((cur_start, cur_end, cur_text))

    # 마지막 segment의 end가 video_dur보다 작으면 video_dur로 늘림
    if video_dur > 0 and groups and groups[-1][1] < video_dur:
        last = groups[-1]
        groups[-1] = (last[0], int(round(video_dur)), last[2])

    segments = [
        {"start": float(st), "end": float(en), "text": text}
        for st, en, text in groups
    ]
    transcript = " ".join(t for _, _, t in groups)
    return transcript, segments


def _word_jaccard(a: str, b: str) -> float:
    """텍스트 a, b의 단어 단위 Jaccard 유사도."""
    import re as _re
    wa = set(_re.findall(r"[\uac00-\ud7a3A-Za-z0-9]+", a or ""))
    wb = set(_re.findall(r"[\uac00-\ud7a3A-Za-z0-9]+", b or ""))
    if not wa or not wb:
        return 0.0
    return len(wa & wb) / len(wa | wb)


def detect_bgm_only_reel(transcript: str, ocr_pairs: list[tuple[int, str]],
                          jaccard_threshold: float = 0.15,
                          min_ocr_chars: int = 30) -> bool:
    """Whisper transcript가 BGM 가사를 잘못 잡은 케이스 감지.

    True 조건 (모두):
    - OCR 텍스트 총합이 충분 (>= min_ocr_chars) — 화면 텍스트 위주 광고
    - Whisper transcript와 OCR 텍스트의 단어 Jaccard < threshold (거의 무관)
    """
    if not transcript or not ocr_pairs:
        return False
    ocr_text = " ".join(t for _, t in ocr_pairs)
    if len(ocr_text) < min_ocr_chars:
        return False
    return _word_jaccard(transcript, ocr_text) < jaccard_threshold


def split_segment_by_sentences(seg: dict) -> list[dict]:
    """단일 segment를 문장 경계(.!?)로 쪼개고 시간을 글자수 비율로 분배."""
    import re as _re
    text = (seg.get("text") or "").strip()
    if not text:
        return [seg]
    start = float(seg.get("start", 0) or 0)
    end = float(seg.get("end", start) or start)
    parts = _re.split(r"(?<=[.!?])\s+", text)
    parts = [p.strip() for p in parts if p and p.strip()]
    if len(parts) <= 1:
        return [seg]
    total_chars = sum(len(p) for p in parts) or 1
    span = max(end - start, 0.1)
    out = []
    cur = start
    for i, p in enumerate(parts):
        piece_end = end if i == len(parts) - 1 else cur + span * len(p) / total_chars
        new_seg = dict(seg)
        new_seg["text"] = p
        new_seg["start"] = round(cur, 1)
        new_seg["end"] = round(piece_end, 1)
        new_seg.pop("section", None)
        out.append(new_seg)
        cur = piece_end
    return out


def resegment_to_sentences(segments: list[dict]) -> list[dict]:
    """모든 segment를 문장 단위로 재분할. 이미 단일 문장이면 그대로."""
    out = []
    for s in segments:
        out.extend(split_segment_by_sentences(s))
    return out


def get_canonical_tts(ref: dict) -> list[dict]:
    """참고 릴스의 sentence-level 분절을 단일 진입점으로 반환.

    `pro_audio.tts_script`(Gemini 3 Pro 결과)와 `sentences`(Whisper + resegment) 중
    더 세밀한 쪽을 정본으로 채택. tts_script의 direction/delivery 메타데이터는
    시간 overlap으로 매칭해 보존.

    호출 후 ref["tts_script"]도 정본으로 갱신 (다른 함수에서 재진입 시 일관성).
    """
    tts = ref.get("tts_script") or []
    sentences = ref.get("sentences") or []
    if len(sentences) <= len(tts):
        return tts

    def _to_sec(v):
        try:
            return _mmss_to_sec(v)
        except Exception:
            return 0.0

    # tts_script의 direction/delivery를 시간 매칭으로 가져오기
    tts_by_start = [(_to_sec(t.get("start", 0)), _to_sec(t.get("end", 0)), t) for t in tts]
    canonical: list[dict] = []
    for s in sentences:
        st = float(s.get("start", 0) or 0)
        en = float(s.get("end", st) or st)
        # overlap이 가장 큰 tts 항목 찾기
        best_overlap = 0.0
        best_tts: dict = {}
        for ts, te, t in tts_by_start:
            ov = max(0, min(en, te) - max(st, ts))
            if ov > best_overlap:
                best_overlap = ov
                best_tts = t
        canonical.append({
            "start": st,
            "end": en,
            "text": s.get("text", ""),
            "direction": best_tts.get("direction", ""),
            "delivery": best_tts.get("delivery", ""),
        })
    ref["tts_script"] = canonical
    return canonical


def analyze_reference_proportions(ref: dict) -> dict:
    """참고 릴스의 섹션 비율 + body의 분절(tip) 단위 추출.

    body 분절 수 = script_structure.body.key_points 개수 (없으면 1)
    body 분절 = body의 tts 문장들을 분절 수만큼 순차 균등 분할
    각 분절은 1+ 문장 보유 → 기능/설명/혜택 마이크로 패턴 형성
    """
    s = ref.get("structure") or {}
    total = ref.get("duration") or 0
    hook = _parse_section_seconds((s.get("hook") or {}).get("seconds"))
    intro = _parse_section_seconds((s.get("intro") or {}).get("seconds"))
    body = _parse_section_seconds((s.get("body") or {}).get("seconds"))
    cta = _parse_section_seconds((s.get("cta") or {}).get("seconds"))

    # body 시간 범위 정정 — structure가 잘못된 경우(예: '8-36초'이지만 영상은 28초) tts/cta 기준으로 보정
    # canonical helper로 sentences/tts_script 중 더 세밀한 쪽을 단일 진입점에서 받음
    tts = get_canonical_tts(ref)
    last_tts_end = max((_mmss_to_sec(t.get("end", 0)) for t in tts), default=0)
    # CTA 시작점 탐지 — structure의 cta 시간이 영상 길이 초과할 수 있어 tts에서 키워드 기반 검출
    cta_keywords = ["저장", "써먹", "클릭", "댓글", "공유", "팔로우", "링크", "구독", "DM", "가입", "다운로드", "프로필"]
    detected_cta_start = None
    for t in tts[-3:]:  # 마지막 3문장만
        text = t.get("text", "")
        if any(kw in text for kw in cta_keywords):
            detected_cta_start = _mmss_to_sec(t.get("start", 0))
            break
    if detected_cta_start is not None:
        body_end_eff = detected_cta_start
        cta_sec_real = last_tts_end - detected_cta_start
    elif total:
        body_end_eff = total
        cta_sec_real = (cta[1] - cta[0]) if cta else 0
    else:
        body_end_eff = last_tts_end
        cta_sec_real = (cta[1] - cta[0]) if cta else 0
    if body:
        b_start = body[0]
        b_end = min(body[1], body_end_eff)
    else:
        b_start = (intro[1] if intro else (hook[1] if hook else 0))
        b_end = body_end_eff

    # body에 속하는 tts 문장들 (overlap > 0.3 기준)
    body_sentences = []
    for t in tts:
        ts = _mmss_to_sec(t.get("start", 0))
        te = _mmss_to_sec(t.get("end", ts))
        if te <= b_start + 0.1 or ts >= b_end - 0.1:
            continue
        body_sentences.append((ts, te))

    # 분절 수 = key_points 길이 (없으면 휴리스틱)
    key_pts = ((s.get("body") or {}).get("key_points") or [])
    tip_count = len(key_pts) if key_pts else max(1, len(body_sentences) // 3)

    # body_sentences를 tip_count로 균등 분할 — 전환 키워드(그리고/마지막으로 등) 우선, 없으면 비율 분배
    body_slots: list[tuple[float, float, int]] = []
    if body_sentences and tip_count > 0:
        # 전환 키워드로 경계 탐지
        TRANS = ["마지막으로", "그리고", "또한", "다음으로", "게다가", "하지만", "또"]
        full_tts = get_canonical_tts(ref)
        boundaries = [0]
        for idx, (ts, te) in enumerate(body_sentences):
            if idx == 0: continue
            # 해당 시간의 tts text 찾기
            text = ""
            for t in full_tts:
                if abs(_mmss_to_sec(t.get("start", 0)) - ts) < 0.3:
                    text = t.get("text", ""); break
            if any(text.startswith(k) or f" {k}" in text[:6] for k in TRANS):
                boundaries.append(idx)
        boundaries.append(len(body_sentences))

        if len(boundaries) - 1 == tip_count:
            # 키워드로 정확히 N분절 검출
            for i in range(tip_count):
                grp = body_sentences[boundaries[i]:boundaries[i+1]]
                if grp:
                    body_slots.append((grp[0][0], grp[-1][1], len(grp)))
        else:
            # 비율 분배 (나머지를 앞쪽 그룹에 할당)
            n = len(body_sentences)
            base = n // tip_count
            rem = n % tip_count
            idx = 0
            for i in range(tip_count):
                size = base + (1 if i < rem else 0)
                grp = body_sentences[idx:idx+size]
                idx += size
                if grp:
                    body_slots.append((grp[0][0], grp[-1][1], len(grp)))
    else:
        body_slots.append((b_start, b_end, 1))

    # Hook/Intro/CTA의 대표 tts 문장 추출 (첫 문장 — 분류용)
    def _sent_in_range(start_t, end_t):
        for t in tts:
            ts = _mmss_to_sec(t.get("start", 0))
            te = _mmss_to_sec(t.get("end", ts))
            if ts >= start_t - 0.3 and te <= end_t + 0.3:
                pat = _extract_pattern(t.get("text", ""))
                end = _classify_ending(t.get("text", ""))
                return {**pat, "ending": end}
        return None

    # Hook/Intro/CTA 범위의 모든 문장 (1:1 scaffold용)
    def _all_sents_in_range(start_t, end_t) -> list[dict]:
        out = []
        all_in_range = []
        for t in tts:
            ts = _mmss_to_sec(t.get("start", 0))
            te = _mmss_to_sec(t.get("end", ts))
            if ts >= start_t - 0.3 and te <= end_t + 0.3:
                all_in_range.append((ts, te, t))
        n = len(all_in_range)
        for i, (ts, te, t) in enumerate(all_in_range):
            txt = t.get("text", "")
            end = _classify_ending(txt)
            role = _classify_sentence_role(txt, i, n)
            out.append({
                "start": ts, "end": te,
                "text": txt,
                "direction": t.get("direction", ""),
                "ending": end,
                "role": role,
            })
        return out

    hook_pattern = _sent_in_range(hook[0], hook[1]) if hook else None
    intro_pattern = _sent_in_range(intro[0], intro[1]) if intro else None
    cta_pattern = None
    hook_sents_all = _all_sents_in_range(hook[0], hook[1]) if hook else []
    intro_sents_all = _all_sents_in_range(intro[0], intro[1]) if intro else []
    cta_sents_all = []
    if detected_cta_start is not None:
        cta_pattern = _sent_in_range(detected_cta_start, last_tts_end + 0.5)
        cta_sents_all = _all_sents_in_range(detected_cta_start, last_tts_end + 0.5)

    # ── sentence.section 우선 적용 ──
    # 사용자가 자동 분류 또는 수동 지정한 section 라벨이 있으면 그것으로 그룹핑
    sentences_with_section = []
    for s in (ref.get("sentences") or []):
        if s.get("section"):
            sentences_with_section.append(s)
    if sentences_with_section and len(sentences_with_section) >= 3:
        by_section: dict[str, list[dict]] = {"hook": [], "intro": [], "body": [], "cta": []}
        for s in sentences_with_section:
            sec = (s.get("section") or "").lower()
            if sec not in by_section:
                continue
            ts = float(s.get("start", 0))
            te = float(s.get("end", ts))
            txt = s.get("text", "")
            by_section[sec].append({
                "start": ts, "end": te, "text": txt,
                "direction": "",
                "ending": _classify_ending(txt),
                "role": _classify_sentence_role(txt, len(by_section[sec]), 0),
            })
        # role 재계산 (section 내 idx/total로)
        for sec_name, sents in by_section.items():
            n = len(sents)
            for i, sd in enumerate(sents):
                sd["role"] = _classify_sentence_role(sd["text"], i, n)
        # override section 결과로 갱신
        if by_section["hook"]:
            hook_sents_all = by_section["hook"]
        if by_section["intro"]:
            intro_sents_all = by_section["intro"]
        if by_section["cta"]:
            cta_sents_all = by_section["cta"]
        # body_slots는 key_points 기반 유지 (multi-USP 슬롯 분할 보존)

    return {
        "total_sec": total or last_tts_end,
        "hook_sec": (hook[1] - hook[0]) if hook else 0,
        "intro_sec": (intro[1] - intro[0]) if intro else 0,
        "body_sec": b_end - b_start if b_end > b_start else 0,
        "cta_sec": cta_sec_real,
        "body_slots": body_slots,
        "tip_count": tip_count,
        "hook_pattern": hook_pattern,
        "intro_pattern": intro_pattern,
        "cta_pattern": cta_pattern,
        "hook_sents_all": hook_sents_all,
        "intro_sents_all": intro_sents_all,
        "cta_sents_all": cta_sents_all,
    }


def score_review_impact(review: str) -> int:
    """리뷰의 임팩트 점수 (높을수록 카피에 적합) — 도메인 중립."""
    import re
    score = 1
    # 숫자/수치
    if re.search(r"\d+", review): score += 5
    if re.search(r"%|만\s?원|퍼센트|할인|아꼈", review): score += 2
    # 구체적 고유명사·장소 (대문자 영단어 또는 한국 도시 패턴)
    if re.search(r"[A-Z][a-z]+|[가-힣]{2,3}(시|역|동|호텔|점)", review): score += 2
    # 감각·생생 표현
    for keyword in ["귀신같", "쌩돈", "짜릿", "진짜", "본전", "꿀", "들락거", "휘청", "경악", "당황", "찰떡", "갓벽", "촤르르", "쫀쫀", "챱챱"]:
        if keyword in review: score += 2; break
    return score


def _score_vivid(r: str) -> int:
    """vivid 시나리오 추출용 — 도메인 중립."""
    import re
    score = 0
    if re.search(r"\d+\s*만\s*원", r): score += 5
    if re.search(r"\d+\s*%", r): score += 4
    if re.search(r"\d+\s*(박|일|개|kg|cm|XL|L|M|S)", r): score += 3
    if re.search(r"[A-Z][a-z]+|[가-힣]{2,3}(시|역|동|호텔|점|매장|샵)", r): score += 2
    if re.search(r"(그저께|어제|오늘|내일|다음날|매일|매번)", r): score += 2
    if re.search(r"(취소|예약|받았|아꼈|뽑았|쿠폰|들었|썼|썼더니|샀|샀더니)", r): score += 2
    if len(r) < 25: score -= 2
    return score


def classify_hook_type(text: str) -> dict:
    """Hook 유형 분류 — 질문형/충격형/공감형/통계형/명령형."""
    if not text: return {"type": "unknown", "pattern": ""}
    t = text.strip()
    if t.endswith("?") or "나요" in t or "ㄴ가요" in t or "까요" in t:
        if any(k in t for k in ["모르고", "아직도", "여전히"]):
            return {"type": "충격_질문형", "pattern": "이 X 모르고 / 아직도 Y하시나요?"}
        return {"type": "질문형", "pattern": "X 한 적 있으신가요?"}
    if any(k in t for k in ["모르면", "손해", "이걸 모르면"]):
        return {"type": "충격형", "pattern": "X 모르면 Y / 손해"}
    if "다면" in t and ("마세요" in t or "않으면" in t):
        return {"type": "공감_명령형", "pattern": "X 했다면 Y하지 마세요"}
    import re
    if re.search(r"\d+", t) and any(k in t for k in ["만원", "%", "퍼센트", "배"]):
        return {"type": "통계_충격형", "pattern": "X만원? Y%?"}
    if t.endswith(("하세요", "해보세요", "마세요")):
        return {"type": "명령형", "pattern": "X 하세요"}
    return {"type": "기타_진술형", "pattern": t[:30]}


def classify_body_structure(ref: dict) -> dict:
    """Body 구조 유형 분류:
    - 멀티USP_1대1: 분절마다 다른 기능
    - 단일USP_카테고리분할: 한 USP를 시나리오·각도별로
    - 비교형: A vs B 비교
    """
    s = ref.get("structure") or {}
    body = s.get("body") or {}
    body_text = body.get("text", "")
    key_pts = body.get("key_points") or []

    # 비교형: 숫자 비교, "vs", "보다" 등
    import re
    if re.search(r"\d+\s*만\s*원.*\d+\s*만\s*원", body_text) or "vs" in body_text.lower():
        return {"type": "비교형", "guide": "한 제품·기능을 다른 옵션과 가격·결과 직접 비교"}

    # body_slots 3+ 이면 거의 항상 멀티 USP (3개 이상 토픽 = 별개 기능 가능성 ↑)
    body_slot_count = len(key_pts) if key_pts else 0
    if body_slot_count >= 3:
        return {"type": "멀티USP_1대1", "guide": "각 body 분절마다 다른 USP 매칭 (적응형)"}

    # 단일 USP 다각도: body_slots가 1-2개이고 시나리오 키워드 비중 높을 때만
    # 도메인 중립 — 시나리오·장소·각도 패턴을 일반 단어로 검출
    if key_pts and body_slot_count <= 2:
        scenario_kw = [
            # 카테고리/매장/장소
            "식사", "쇼핑", "택시", "카페", "맛집", "마사지", "디저트",
            "매장", "샵", "스토어", "지점", "점", "센터",
            # 시간/상황
            "아침", "저녁", "낮", "밤", "주말", "출근", "퇴근",
            # 디테일/스타일/디자인 각도
            "디자인", "디테일", "스타일", "포인트", "라인", "패턴", "색상", "컬러", "소재",
            # 사용 시나리오
            "사용", "시연", "활용", "케이스", "상황",
        ]
        place_phrase = ["에서", "할 때", "용도"]
        cat_count = sum(1 for kp in key_pts if any(k in str(kp) for k in scenario_kw))
        phrase_count = sum(1 for kp in key_pts if any(p in str(kp) for p in place_phrase))
        # 시나리오 키워드 60% OR phrase 50% — 단일USP 다각도형
        if cat_count >= len(key_pts) * 0.6 or phrase_count >= len(key_pts) * 0.5:
            return {"type": "단일USP_카테고리분할", "guide": "메인 USP 1개를 여러 시나리오·각도·디테일로 다각도 어필"}

    # 멀티 USP 1:1: key_points가 별개 기능들
    if len(key_pts) >= 2:
        return {"type": "멀티USP_1대1", "guide": "분절마다 다른 USP/기능을 1:1 매핑"}

    return {"type": "단일진행", "guide": "단일 흐름으로 풀어냄"}


def select_unified_scenario(usps: list[dict]) -> dict:
    """여행 카테고리에 한해 — 모든 USP의 리뷰를 훑어 가장 풍부한 도시·맥락 1개를 선택.

    여행이 아닌 도메인은 city=None 반환 → 호출 측에서 city_rule 비활성화.
    최소 3개 리뷰 매칭이 있어야 통일 시나리오로 인정 (1-2건 우연 매칭 방지).
    """
    cities = ["도쿄", "오사카", "유럽", "괌", "베트남", "발리", "나트랑", "방콕", "교토"]
    city_reviews: dict[str, list[str]] = {c: [] for c in cities}
    for u in usps:
        for r in (u.get("reviews") or []):
            for c in cities:
                if c in r:
                    city_reviews[c].append(r)
                    break  # 한 리뷰 = 한 도시 매핑
    # 도시별 리뷰 점수 합산 (vivid score 사용)
    best = None
    best_score = 0
    MIN_REVIEWS = 3  # 최소 3건 매칭 — 비여행 도메인 우연 매칭 방지
    for c, rs in city_reviews.items():
        if len(rs) < MIN_REVIEWS: continue
        score = sum(_score_vivid(r) for r in rs) + len(rs) * 2
        if score > best_score:
            best_score = score; best = {"city": c, "review_count": len(rs), "supporting_reviews": rs[:5]}
    return best or {"city": None, "review_count": 0, "supporting_reviews": []}


def extract_vivid_scenarios(usps: list[dict], limit: int = 5) -> list[str]:
    """전 USP에서 Hook 후보 시나리오 추출."""
    cands = []
    for u in usps:
        for r in (u.get("reviews") or []):
            r = r.strip()
            if not r: continue
            s = _score_vivid(r)
            if s >= 5: cands.append((s, r))
    cands.sort(key=lambda x: -x[0])
    return [r for _, r in cands[:limit]]


def extract_vivid_per_usp(reviews: list[str], top_n: int = 2) -> list[str]:
    """USP별 vivid 시나리오 — Body 결과 문장용."""
    cands = []
    for r in reviews or []:
        r = r.strip()
        if not r: continue
        s = _score_vivid(r)
        if s >= 3: cands.append((s, r))
    cands.sort(key=lambda x: -x[0])
    return [r for _, r in cands[:top_n]]


def select_reviews_for_budget(reviews: list[str], syllable_budget: int) -> list[str]:
    """음절 budget 안에서 점수 내림차순으로 리뷰 선택. 0~N개 반환."""
    if not reviews or syllable_budget <= 0: return []
    scored = sorted(
        [(score_review_impact(r), _count_kor_syllables(r), r) for r in reviews if r.strip()],
        key=lambda x: (-x[0], x[1]),  # 점수 ↓, 길이 ↑ (짧은 게 우선)
    )
    selected: list[str] = []
    used = 0
    for sc, syl, r in scored:
        if used + syl <= syllable_budget:
            selected.append(r); used += syl
        elif not selected and syl <= int(syllable_budget * 1.3):
            # 첫 리뷰가 budget 살짝 넘으면 허용 (최소 1개 보장)
            selected.append(r); used += syl
            break
    return selected


def _emo_label(key: str) -> str:
    M = {
        "happy": "기쁨", "excited": "신남", "sad": "슬픔", "angry": "분노",
        "fearful": "공포", "surprised": "놀람", "neutral": "중립", "calm": "차분",
        "crying": "우는", "nervous": "불안", "curious": "호기심", "serious": "진지",
        "tired": "피곤", "frustrated": "좌절", "cheerful": "명랑",
        "sarcastic": "비꼬는", "mischievously": "장난스러운",
    }
    return M.get(key, key)


def _mmss_to_sec(v) -> float:
    if isinstance(v, (int, float)):
        return float(v)
    parts = str(v).split(":")
    if len(parts) == 2:
        try: return float(parts[0]) * 60 + float(parts[1])
        except: pass
    try: return float(v)
    except: return 0.0


def fetch_reference(shortcode: str) -> dict | None:
    """참고 릴스의 분석 데이터 수집 (transcript, structure, sentences, emotion_timeline, caption)."""
    H = supabase.SUPABASE_HEADERS
    base = supabase.SUPABASE_URL

    meta = requests.get(f"{base}/rest/v1/reels_metadata?shortcode=eq.{shortcode}&select=author_username,play_count,like_count,video_duration,caption_text&limit=1", headers=H, timeout=10).json()
    if not meta:
        return None
    m = meta[0]

    trans = requests.get(f"{base}/rest/v1/reels_transcripts?shortcode=eq.{shortcode}&select=transcript,segments&limit=1", headers=H, timeout=10).json()
    transcript = trans[0].get("transcript", "") if trans else ""
    sentences = trans[0].get("segments") if trans else []

    structure = requests.get(f"{base}/rest/v1/reels_script_structure?shortcode=eq.{shortcode}&select=*&limit=1", headers=H, timeout=10).json()
    structure = structure[0] if structure else {}

    pa = requests.get(f"{base}/rest/v1/reels_pro_audio?shortcode=eq.{shortcode}&select=pro_audio&limit=1", headers=H, timeout=10).json()
    pro = pa[0].get("pro_audio") if pa else {}

    return {
        "shortcode": shortcode,
        "author": m.get("author_username"),
        "plays": m.get("play_count") or 0,
        "likes": m.get("like_count") or 0,
        "duration": m.get("video_duration") or 0,
        "caption": m.get("caption_text") or "",
        "transcript": transcript,
        "sentences": sentences or [],
        "structure": structure,
        "emotion_timeline": (pro or {}).get("emotion_timeline") or [],
        "tts_script": (pro or {}).get("tts_script") or [],
    }


def _format_reference(ref: dict, idx: int) -> str:
    er = round((ref["likes"] / ref["plays"]) * 100, 2) if ref["plays"] else 0
    lines = [
        f"\n=== 참고 릴스 {idx+1}: @{ref['author']} (조회 {ref['plays']:,}, ER {er}%, 길이 {ref['duration']:.0f}초) ===",
    ]
    s = ref.get("structure") or {}
    for k, ko in [("hook", "Hook"), ("intro", "Intro"), ("body", "Body"), ("cta", "CTA")]:
        sec = s.get(k) or {}
        if sec.get("text") or sec.get("analysis"):
            lines.append(f"\n[{ko}] ({sec.get('seconds') or '?'})")
            if sec.get("type"): lines.append(f"  유형: {sec['type']}")
            lines.append(f"  텍스트: \"{sec.get('text','')}\"")
            if sec.get("analysis"): lines.append(f"  분석: {sec['analysis']}")

    overall = s.get("overall") or {}
    if overall:
        lines.append(f"\n[전체 흐름] {overall.get('flow','')}")
        lines.append(f"[강점] {overall.get('strength','')}")

    # 문장 타임라인 + 감정/delivery
    lines.append("\n[문장 타임라인 — direction + 감정 + delivery]")
    tl = ref.get("emotion_timeline") or []
    tts = get_canonical_tts(ref)
    for sent in (ref.get("sentences") or []):
        st = sent.get("start") or 0
        en = sent.get("end") or 0
        text = sent.get("text", "")
        # tts_script에서 direction/delivery 매칭
        ti = next((t for t in tts if abs(_mmss_to_sec(t.get("start", 0)) - st) < 0.5), None)
        direction = (ti or {}).get("direction") or ""
        delivery = (ti or {}).get("delivery") or ""
        # emotion_timeline에서 오버랩 매칭
        best = None
        bo = 0
        for seg in tl:
            ss = _mmss_to_sec(seg.get("start", 0))
            se = _mmss_to_sec(seg.get("end", 0))
            ov = max(0, min(en, se) - max(st, ss))
            if ov > bo:
                bo, best = ov, seg
        emo = ""
        if best:
            emo = f"{_emo_label(best.get('emotion',''))} {int((best.get('intensity') or 0)*100)}%"
        prefix_parts = []
        if direction: prefix_parts.append(f"({direction})")
        if delivery and delivery != "normal": prefix_parts.append(f"({delivery})")
        if emo: prefix_parts.append(f"({emo})")
        lines.append(f"  [{st:.1f}~{en:.1f}s] {''.join(prefix_parts)} {text}")

    if ref.get("caption"):
        lines.append(f"\n[캡션] {ref['caption'][:200]}")
    return "\n".join(lines)


def _split_clauses(text: str) -> list[str]:
    """절(clause) 분리 — 연결어미 또는 쉼표 뒤에서 끊음."""
    import re
    s = text.strip().rstrip(".!?")
    # 어절 단위로 보면서 연결어미로 끝나는 어절 다음에 끊음
    endings = ("했는데", "때문에", "다면", "면서", "니까", "지만", "는데", "어서", "기에", "어도", "어야",
               "아서", "고서", "면서도", "더라도", "라도")
    short = ("면", "니", "고", "며", "서")  # 짧은 어미는 단독 어절 끝일 때만
    tokens = re.split(r"(\s+)", s)  # 공백 보존
    out = []
    cur = ""
    for tok in tokens:
        cur += tok
        bare = tok.strip()
        if not bare:
            continue
        bare_clean = bare.rstrip(",.")
        if bare_clean.endswith(endings) or (any(bare_clean.endswith(sh) and len(bare_clean) > 1 for sh in short)):
            out.append(cur.strip().rstrip(","))
            cur = ""
        elif bare.endswith(","):
            out.append(cur.strip().rstrip(","))
            cur = ""
    if cur.strip():
        out.append(cur.strip())
    return [c for c in out if c]


def _extract_pattern(text: str) -> dict:
    """문장 syntax 패턴 — 절 개수, 절 목록, 끝맺음."""
    clauses = _split_clauses(text)
    return {
        "raw": text,
        "clause_count": len(clauses),
        "clauses": clauses,
    }


def _classify_ending(text: str) -> dict:
    """문장 끝맺음 분석 — 형태 분류 + 마지막 어미 패턴 추출."""
    import re
    t = text.strip().rstrip(".,!?…")
    # 마지막 5~6자 추출
    tail = t[-6:] if len(t) > 6 else t
    if re.search(r"(요|니다|니까|네요|군요|라구요|에요|예요|죠|래요|구나|군)$", t):
        kind = "완결문 (서술어 + 어미)"
    elif re.search(r"(고|며|면서|면|서|니|나|지|데|는지|을지|던지|러|려|고서)$", t):
        kind = "연결형 (다음 문장으로 이어짐)"
    elif re.search(r"(이|가|을|를|에|에서|와|과|의|로|으로|도|만|은|는)$", t):
        kind = "조사 끝 (체언 + 조사)"
    else:
        kind = "단어/구 (체언으로 끝)"
    # 어미 패턴 추출 (마지막 어절 + 종결부호)
    # 마지막 어절 + 종결부호 형태
    last_word = t.split()[-1] if t.split() else t
    pattern_short = f"...{last_word[-4:]}{'.' if text.rstrip().endswith('.') else ''}" if len(last_word) >= 4 else text[-6:]
    return {"kind": kind, "ending": pattern_short, "raw_tail": tail}


def _extract_slot_sentences(ref: dict, slot: tuple) -> list[dict]:
    """body 분절 시간대에 속하는 참고 문장들의 (시간, 감정, direction, 역할, 끝맺음) 반환."""
    s_start, s_end = slot[0], slot[1]
    tts = get_canonical_tts(ref)
    tl = ref.get("emotion_timeline") or []
    sents_in_slot = []
    for t in tts:
        ts = _mmss_to_sec(t.get("start", 0))
        te = _mmss_to_sec(t.get("end", ts))
        if ts >= s_start - 0.3 and te <= s_end + 0.3:
            # match emotion
            best = None; bo = 0
            for seg in tl:
                ss = _mmss_to_sec(seg.get("start", 0))
                se = _mmss_to_sec(seg.get("end", ss))
                ov = max(0, min(te, se) - max(ts, ss))
                if ov > bo: bo, best = ov, seg
            ending = _classify_ending(t.get("text", ""))
            sents_in_slot.append({
                "start": ts, "end": te,
                "direction": t.get("direction", ""),
                "emotion": (best or {}).get("emotion", ""),
                "intensity": (best or {}).get("intensity", 0),
                "delivery": (best or {}).get("delivery", "normal"),
                "ending_kind": ending["kind"],
                "ending_pattern": ending["ending"],
                "ref_text_for_pattern": t.get("text", ""),  # 패턴 참고용 (텍스트 차용 X)
            })
    # 역할 추정 (텍스트 내용 기반 — spec / benefit / pain / proof / cta)
    n = len(sents_in_slot)
    for i, s in enumerate(sents_in_slot):
        s["role"] = _classify_sentence_role(s.get("ref_text_for_pattern", ""), i, n)
    return sents_in_slot


def _classify_sentence_role(text: str, idx: int = 0, total: int = 1) -> str:
    """문장 역할 분류 — spec / benefit / pain / proof / cta / transition.

    각 역할의 정의:
    - spec: 제품 속성·재료·기능 묘사 (소비자 언어, 평가어 없음). 끝맺음 "~라/이라/~인데/~까지" 등
    - benefit: 사용자가 얻는 체감·결과. "~좋아요/편해요/끝나요/거든요" 평가성
    - pain: 사용자 고통·짜증 표현. "~귀찮/힘들/답답/스트레스/~지?"
    - proof: 구체 수치·일화·증거 ("200만원이...", "5번 돌렸는데...")
    - cta: 행동 유도 ("~하세요/남기면/받으세요/구경/클릭")
    - transition: 전환·도입 ("오늘은~", "그리고 제일 중요한~", "마지막으로~")
    """
    import re
    t = (text or "").strip()
    if not t:
        return "spec"
    # CTA 키워드
    if re.search(r"(저장|써먹|클릭|댓글|공유|팔로우|링크|구독|DM|가입|다운로드|프로필|남기|받으|쏠게|보내|남겨|받아)", t):
        return "cta"
    # Transition 키워드
    if re.search(r"^(오늘은|그리고|또한|마지막으로|근데|하지만|이제|그런데)", t):
        return "transition"
    # Pain 키워드
    if re.search(r"(귀찮|힘들|답답|괴롭|스트레스|짜증|불편|지?쳤|지긋|싫어|망|줄어)", t):
        return "pain"
    # Proof — 구체 수치·일화
    if re.search(r"\d+\s*(만\s*원|%|번|박|일|kg|cm|개월)", t):
        return "proof"
    if re.search(r"(다음날|어제|오늘|매일|매번|샀더니|돌렸더니|입었더니|들었더니|받았)", t):
        return "proof"
    # Benefit — 평가성·체감 종결 (~좋/~편/~끝/~거든요/~잖아요)
    if re.search(r"(좋아요|좋네요|좋다|편해요|편하다|끝나|끝!|거든요|잖아요|만족|쾌적|시원해요|상쾌)", t):
        return "benefit"
    # Spec — 명사 + 묘사 종결 (~라/이라/~인데/~까지 등)
    if re.search(r"(라$|이라$|인데$|까지$|\?$|정도$|뿐|만$)", t):
        return "spec"
    # 기본: 위치 기반 fallback
    if total == 1: return "spec_or_benefit"
    return "spec" if idx == 0 else "benefit"


def _allocate_usp_to_slots(usps: list[dict], body_slots: list[tuple], total_body_sec: float, ref: dict, body_class: dict | None = None) -> list[dict]:
    """USP를 참고의 body 분절(slot)에 매핑 + body 유형별 매핑 전략 적용."""
    n_slots = max(1, len(body_slots))
    n_usps = len(usps)
    result = []

    # 단일USP_카테고리분할: 메인 USP 1개를 모든 슬롯에 다른 각도로
    if body_class and body_class.get("type") == "단일USP_카테고리분할" and usps:
        main_usp = usps[0]
        all_reviews = []
        for u in usps:  # 다른 USP의 리뷰도 끌어와 다른 각도 풍부화
            all_reviews.extend(u.get("reviews") or [])
        for slot_idx in range(n_slots):
            slot = body_slots[slot_idx]
            sec = slot[1] - slot[0]
            slot_sents = _extract_slot_sentences(ref, slot)
            angle = ["사용 흐름·기능 시연", "구체 시나리오·일화", "결과·혜택 강조", "추가 사용 케이스"][slot_idx % 4]
            result.append({
                "usp": main_usp.get("usp", ""),
                "reviews": all_reviews,
                "alloc_sec": sec,
                "alloc_syllables": int(sec * _KOR_SYL_PER_SEC),
                "ref_micro_pattern": slot_sents,
                "angle": f"단일USP 다각도 — {angle}",
                "is_main": True,
                "selected_reviews": select_reviews_for_budget(
                    all_reviews, int(sec * _KOR_SYL_PER_SEC * 0.8)
                ),
            })
        return result

    if n_usps <= n_slots:
        # 메인 USP = USP[0] → Body 1 + Body 2 (연속 슬롯)을 차지하여 Hook→Body 흐름 일관
        # 보조 USPs (USP[1:]) → 나머지 뒤쪽 슬롯
        # n_slots=3, n_usps=2 → main: [0,1], sub: [2]
        # n_slots=3, n_usps=3 → main: [0,1], sub: [2] (3번째 USP), USP[2]는 본문 외로 합쳐지지만 사용자 USP 모두 활용
        # n_slots=3, n_usps=1 → main: [0,1,2]
        main_slot_count = n_slots - max(0, n_usps - 1)  # 보조 USP 수 만큼 슬롯 빼고 나머지를 메인이 차지
        slot_assignments: dict[int, dict] = {}
        # 메인 USP → 처음부터 main_slot_count개 슬롯 차지
        for si in range(main_slot_count):
            slot_assignments[si] = {
                "usp": usps[0],
                "is_main": True,
                "main_part": si + 1,
                "main_total": main_slot_count,
            }
        # 보조 USP들 → 나머지 슬롯에 순서대로
        for j, u in enumerate(usps[1:]):
            si = main_slot_count + j
            if si < n_slots:
                slot_assignments[si] = {"usp": u, "is_main": False}

        for slot_idx in range(n_slots):
            assign = slot_assignments.get(slot_idx)
            if not assign: continue
            u = assign["usp"]
            slot = body_slots[slot_idx]
            sec = slot[1] - slot[0]
            slot_sents = _extract_slot_sentences(ref, slot)
            if assign.get("is_main"):
                if assign.get("main_total", 1) == 1:
                    angle = "메인 USP — 작동 + 혜택 통합"
                else:
                    part = assign.get("main_part", 1)
                    total = assign["main_total"]
                    if part == 1:
                        angle = f"메인 USP ({part}/{total}) — 도입·핵심 작동 (Hook 흐름 직접 이어받기)"
                    elif part == total:
                        angle = f"메인 USP ({part}/{total}) — 깊이·사회적 증거·결과 (수치 포함)"
                    else:
                        angle = f"메인 USP ({part}/{total}) — 부가설명·시나리오"
            else:
                angle = "보조 USP — 추가 혜택 (메인 USP 외 다른 가치 도입)"
            result.append({
                "usp": u.get("usp", ""),
                "reviews": u.get("reviews") or [],
                "alloc_sec": sec,
                "alloc_syllables": int(sec * _KOR_SYL_PER_SEC),
                "ref_micro_pattern": slot_sents,
                "angle": angle,
                "is_main": assign.get("is_main", False),
                "selected_reviews": select_reviews_for_budget(
                    u.get("reviews") or [], int(sec * _KOR_SYL_PER_SEC * 0.8)
                ),
            })
    else:
        per_slot = max(1, n_usps // n_slots)
        for slot_idx, slot in enumerate(body_slots):
            slot_sec = slot[1] - slot[0]
            grp_start = slot_idx * per_slot
            grp_end = (slot_idx + 1) * per_slot if slot_idx < n_slots - 1 else n_usps
            grouped = usps[grp_start:grp_end]
            per_usp_syl = int(slot_sec * _KOR_SYL_PER_SEC * 0.6 / max(1, len(grouped)))
            slot_sents = _extract_slot_sentences(ref, slot)
            for u in grouped:
                result.append({
                    "usp": u.get("usp", ""),
                    "reviews": u.get("reviews") or [],
                    "alloc_sec": slot_sec / max(1, len(grouped)),
                    "alloc_syllables": int(slot_sec * _KOR_SYL_PER_SEC / max(1, len(grouped))),
                    "ref_micro_pattern": slot_sents,
                    "selected_reviews": select_reviews_for_budget(
                        u.get("reviews") or [], per_usp_syl
                    ),
                })
    return result


def extract_personas(usp: str, reviews: list[str], pain_solved: str = "") -> list[dict]:
    """USP의 리뷰를 분석해 1-3개 페르소나 후보를 추출한다.

    각 페르소나 = { name, scenario, signals, review_count, sample_reviews, tone_hint }
    Gemini 2.5 Flash 사용 — 단순 분류라 Pro 안 써도 되고 5배 빠름.
    """
    if not reviews:
        return []
    review_text = "\n".join(f"- {r}" for r in reviews[:30])  # 30으로 줄임 (페르소나 분류는 적어도 충분)
    prompt = f"""당신은 광고 페르소나 분석가입니다. 아래 USP의 실제 리뷰를 분석해, 명확히 구분되는 페르소나 1~6개를 추출하세요.

## USP
{usp}

## Pain solved
{pain_solved or '(미지정)'}

## 리뷰 ({len(reviews)}개 중 상위 80개)
{review_text}

## 페르소나 추출 규칙
- 리뷰 코퍼스에서 **반복 등장하는 명확한 시그널 단어**가 있는 페르소나만 추출
- 페르소나끼리는 **시나리오·시그널이 겹치면 안 됨** (서로 명확히 다른 인구·상황만)
- 리뷰가 단일 페르소나만 보여주면 1개만 반환 (억지로 만들지 말 것)
- 페르소나 정의는 반드시 위 리뷰에서 직접 관찰되는 것만 (다른 도메인 페르소나 끌어오기 금지)
- **세분화 권장**: 인구통계(연령/성별)+라이프스타일(직장인/주부/학생)+상황(여름/출퇴근/취침)으로 조합 가능한 만큼 분리
- 최대 6개 (리뷰에 명확히 다른 페르소나가 보이면 6개까지 추출, 강제 X)

## 출력 JSON (배열만)
{{
  "personas": [
    {{
      "name": "한 줄 정의 (인구통계 + 라이프스타일 키워드)",
      "scenario": "이 페르소나가 이 USP를 사용·체감하는 구체 상황 (리뷰에서 발견된 실제 맥락)",
      "signals": ["리뷰 키워드1","2","3"],
      "destinations": ["리뷰에 등장하는 구체 장소·여행지 (선택, 여행 카테고리만 — 푸꾸옥/나트랑/다낭/도쿄 등)"],
      "review_count": <매칭 리뷰 개수>,
      "sample_reviews": ["대표 리뷰 1","2"],
      "tone_hint": "친근·일상 / 실용·간결 / 따뜻 / 신중·전문 등"
    }}
  ]
}}

JSON만 출력. 설명 금지.
"""
    try:
        result = call_gemini(prompt, model="gemini-3-flash-preview", max_tokens=4096)
        if isinstance(result, list) and result:
            result = result[0]
        if isinstance(result, dict):
            personas = result.get("personas", [])
            if isinstance(personas, list):
                return personas
    except Exception as e:
        logger.warning("extract_personas failed: %s", e)
    return []


def build_prompt(product_name: str, pain: str, desire: str, usps: list[dict], references: list[dict], target_persona: dict | None = None) -> str:
    """R-C-T-F-C-E 프레임워크 프롬프트 구성. 참고 릴스의 섹션 비율 미러링 + 리뷰 사전 선택."""
    # 첫 참고 릴스를 길이/비율 기준으로 사용
    primary = references[0]
    props = analyze_reference_proportions(primary)
    total = props["total_sec"]
    # 섹션 budget을 참고 비율로 계산
    hook_b = props["hook_sec"]
    intro_b = props["intro_sec"]
    body_b = props["body_sec"]
    cta_b = props["cta_sec"]
    body_slots = props["body_slots"] or [(0, body_b)]

    # 참고 문장 수 (sentences 우선, 없으면 tts_script)
    ref_total_sentences = len(primary.get("sentences") or []) or len(primary.get("tts_script") or [])
    # 섹션별 문장 수 추정
    ref_tts = primary.get("tts_script") or []
    def _count_sentences_in_range(ts_lo: float, ts_hi: float) -> int:
        cnt = 0
        for t in ref_tts:
            ts = _mmss_to_sec(t.get("start", 0))
            te = _mmss_to_sec(t.get("end", ts))
            if ts >= ts_lo - 0.1 and te <= ts_hi + 0.1:
                cnt += 1
        return cnt
    hook_n = _count_sentences_in_range(0, hook_b) or 1
    intro_n = _count_sentences_in_range(hook_b, hook_b + intro_b) or 1
    cta_n = _count_sentences_in_range(total - cta_b, total) or 1

    # 분류는 참고 릴스 자체 구조에서만 결정 (사용자 USP 수에 의존 X)
    body_class_pre = classify_body_structure(primary)
    usp_alloc = _allocate_usp_to_slots(usps, body_slots, body_b, primary, body_class_pre)

    # 섹션별 syntax 패턴
    hook_pat = props.get("hook_pattern")
    intro_pat = props.get("intro_pattern")
    cta_pat = props.get("cta_pattern")

    parts = [
        "당신은 한국어 인스타 릴스 광고 카피라이터입니다. 직접반응 광고 10년 경력.",
        "",
    ]

    # 단일 페르소나 lock (선택된 경우) — 가장 강한 제약
    if target_persona and target_persona.get("name"):
        parts.append("## 🎯 단일 페르소나 LOCK (절대 분산 금지)")
        parts.append(f"- 타깃: **{target_persona.get('name')}**")
        if target_persona.get("scenario"):
            parts.append(f"- 시나리오: {target_persona.get('scenario')}")
        signals = target_persona.get("signals") or []
        if signals:
            parts.append(f"- 시그널 어휘 (반드시 자연스럽게 녹여서 사용): {', '.join(signals)}")
        if target_persona.get("tone_hint"):
            parts.append(f"- 톤: {target_persona.get('tone_hint')}")
        parts.append("")
        parts.append("⚠️ **이 광고는 위 한 명에게만 말하는 영상**입니다.")
        parts.append("- 다른 페르소나(예: 다른 연령대·다른 라이프스타일·다른 가족 구성) 호명 절대 금지.")
        parts.append("- 다른 시나리오·도시·상황으로 분산되지 말 것 (한 영상 = 한 시나리오).")
        parts.append("- Hook·Intro·Body·Climax·CTA 모두 위 한 페르소나의 시점·어휘로 일관.")
        parts.append("")

    parts.append("## 페르소나 보조 입력")
    parts.append(f"- 고민(Pain): {pain or '(미지정)'}")
    parts.append(f"- 욕구(Desire): {desire or '(미지정)'}")
    parts.append("")
    if not target_persona:
        parts.append("나이대·성별·직업·구매 결정 요인은 위 고민/욕구와 아래 USP, 참고 릴스의 톤·구조에서 직접 추론하여 일관되게 적용하세요.")
        parts.append("")
    parts += [
        "## 제품 / 서비스",
        product_name,
        "",
        f"## ⏱ 섹션별 음절 가이드 (참고 릴스 비율, 한국어 ≈{_KOR_SYL_PER_SEC}음절/초)",
        f"- Hook: ~{int(hook_b*_KOR_SYL_PER_SEC)}음절 — **{hook_n}문장**",
        f"- Intro: ~{int(intro_b*_KOR_SYL_PER_SEC)}음절 — **{intro_n}문장**",
        f"- Body: {len(body_slots)}분절",
    ]
    body_total_sentences = 0
    for i, slot in enumerate(body_slots, 1):
        slot_n = slot[2] if len(slot) > 2 else max(1, int((slot[1]-slot[0]) / 1.0))
        body_total_sentences += slot_n
        parts.append(f"  · Body 분절 {i}: ~{int((slot[1]-slot[0])*_KOR_SYL_PER_SEC)}음절 — **{slot_n}문장**")
    parts.append(f"- CTA: ~{int(cta_b*_KOR_SYL_PER_SEC)}음절 — **{cta_n}문장**")
    parts.append("")
    expected_total = hook_n + intro_n + body_total_sentences + cta_n
    parts.append(f"## 🎯 sentences 배열 길이 = **{expected_total}개 (±2)** — 참고와 같은 호흡으로 풀어내기")
    parts.append("")

    # 참고 분석 — Hook/Body 유형 분류
    hook_class = classify_hook_type(hook_pat["raw"]) if hook_pat else {"type": "unknown", "pattern": ""}
    body_class = body_class_pre

    # 섹션별 narrative role (저장된 게 있으면 사용 — script_structure.overall.section_roles)
    primary_struct = primary.get("structure") or {}
    overall_pri = primary_struct.get("overall") or {}
    section_roles = overall_pri.get("section_roles") or {}
    if section_roles:
        parts.append("## 🎬 섹션별 내러티브 역할 (단순 반복 금지 — 각 섹션은 흐름의 다른 단계)")
        sec_order = ["hook", "intro"] + sorted([k for k in section_roles if k.startswith("body")]) + ["cta"]
        for sec in sec_order:
            sd = section_roles.get(sec)
            if not sd:
                continue
            label = sec.replace("_", " ").upper()
            parts.append(f"\n■ {label}")
            if sd.get("role"):
                parts.append(f"  - 역할: {sd['role']}")
            if sd.get("what_it_does"):
                parts.append(f"  - 역할 흐름: {sd['what_it_does']}")
            if sd.get("must_not_repeat"):
                parts.append(f"  - 반복 금지: {sd['must_not_repeat']}")
        parts.append("")
        parts.append("⚠️ 우리 대본도 위 역할을 그대로 수행. 같은 정보를 두 섹션에서 반복 X. 흐름이 advance해야 함.")
        parts.append("")

    parts.append("## 🔍 참고 대본 패턴 분석 (이 유형을 그대로 따라야 함, 자유롭게 X)")
    parts.append(f"  Hook 유형: **{hook_class['type']}** — 패턴: \"{hook_class['pattern']}\"")
    parts.append(f"    → 우리 Hook도 반드시 이 유형으로 작성. 다른 유형 (예: 추상적 페인 진술) 절대 금지.")
    if hook_pat:
        parts.append(f"    → 참고 Hook 원문: \"{hook_pat['raw']}\"")
    parts.append(f"  Body 구조: **{body_class['type']}** — {body_class['guide']}")
    if body_class["type"] == "단일USP_카테고리분할":
        parts.append(f"    → ⚠️ 이 참고는 **메인 USP 1개**를 여러 카테고리·시나리오로 풀어냄.")
        parts.append(f"    → 우리도 메인 USP 1개를 골라 Body 분절마다 다른 사용 시나리오·매장·카테고리로 다각도 어필.")
        parts.append(f"    → USP 여러 개를 1:1 매핑하지 말 것. 메인 USP에 집중.")
    elif body_class["type"] == "멀티USP_1대1":
        parts.append(f"    → 우리 USP 여러 개를 분절에 1:1 매핑 (각 분절 = 다른 USP)")
    elif body_class["type"] == "비교형":
        parts.append(f"    → 우리 USP를 A(이전·다른 옵션) vs B(우리 제품) 비교 형식으로")
    parts.append("")

    # 역할 + 토픽 미러링 — 1:1 scaffold 핵심
    parts.append("## 🎭 역할 + 토픽 미러링 (가장 중요)")
    parts.append("아래 1:1 scaffold의 각 문장에 [역할=X] 표시. 참고 문장의 역할·토픽 그대로 미러링.")
    parts.append("")
    parts.append("### 역할 라벨")
    parts.append("- spec: 제품 속성·재료·기능 묘사")
    parts.append("- benefit: 사용자 체감·결과")
    parts.append("- pain: 공감 페인")
    parts.append("- proof: 구체 일화·수치")
    parts.append("- cta: 행동 유도")
    parts.append("- transition: 전환·도입")
    parts.append("")
    parts.append("### 핵심 룰")
    parts.append("⚠️ **참고 문장 N의 역할이 X면 우리 문장 N도 역할 X** — 다른 역할로 대체 금지")
    parts.append("⚠️ **토픽 미러링** — 참고 문장 N이 어떤 주제(재질/사이즈/시원함/세탁/구매동기 등)를 다루면, 우리 문장 N도 **같은 주제**를 다뤄야 함")
    parts.append("   - 예: 참고 문장 2가 '재질 묘사' → 우리 문장 2도 '우리 제품 재질 묘사' (구매 동기 X)")
    parts.append("   - 예: 참고 문장 3이 '촉감 체감 혜택' → 우리 문장 3도 '우리 제품 촉감 체감 혜택'")
    parts.append("   - ❌ 참고는 재질 도입인데 우리는 \"가족 선물로 샀거든요\"로 토픽 점프 — 흐름 깨짐")
    parts.append("⚠️ **인접 문장 흐름 매끄럽게** — 한 영상의 한 화자가 이어 말하는 톤")
    parts.append("⚠️ 참고가 섞여있으면 우리도 섞고, 분리되어 있으면 우리도 분리 — 추가 룰 없음")
    parts.append("")

    # Hook/Intro/CTA 문장 단위 1:1 scaffold
    hook_sents = props.get("hook_sents_all") or []
    intro_sents = props.get("intro_sents_all") or []
    cta_sents = props.get("cta_sents_all") or []
    import re as _re_mod
    def _extract_actual_ending(text: str) -> str:
        """문장 마지막 어미를 그대로 추출 (예: '편하잖아' → '~잖아', '보여줄게~' → '~줄게~')."""
        if not text:
            return ""
        s = text.strip()
        # 마지막 어절
        last_word = s.split()[-1] if s.split() else s
        # 길이 제한 — 마지막 4-6자만 (한국어 어미 길이)
        suffix = last_word[-6:] if len(last_word) > 6 else last_word
        return f"~{suffix}"

    def _scaffold_line(j: int, ref_t: str, role: str, ending: str, default_instr: str) -> tuple[str, str]:
        """참고 문장 j에 대한 우리 문장 j 가이드 라인 두 개 반환 (참고 표시 / 우리 지침)."""
        ref_label = f"  {j}) 참고: \"{ref_t}\" [역할={role}]"
        if _is_interjection_text(ref_t):
            instr = (
                f"     → 우리 문장 {j}: ⚠️ **이건 짧은 감탄어/호응어** ({_count_kor_syllables(ref_t)}음절). "
                f"우리도 비슷한 톤의 짧은 감탄어/호응어로 미러링 (예: 와, 진짜, 오, 어머 등). "
                f"제품 기능·USP·CTA 등 정보성 내용 절대 채우지 말 것. 참고와 같은 길이·리듬 유지."
            )
        else:
            actual_end = _extract_actual_ending(ref_t)
            instr = default_instr
            if actual_end:
                instr += f" 종결어 강제: 참고 끝 '{actual_end}' — **같은 종결어로 끝내기**. '~잖아'·'~지'·'~네' 같은 다른 어미로 평탄화 금지."
        return ref_label, instr

    if hook_sents:
        parts.append(f"## 📐 HOOK 1:1 scaffold ({len(hook_sents)}문장)")
        for j, s in enumerate(hook_sents, 1):
            ending = (s.get("ending") or {}).get("kind", "")
            role = s.get("role", "spec")
            ref_t = s.get("text", "")
            default = f"     → 우리 Hook 문장 {j}: 위 참고문장의 **토픽·역할·구문 shape·종결({ending})** 그대로. 참고가 무엇을 말하는지 파악해 우리 제품·페인에 같은 주제로 작성. 다른 토픽으로 점프 금지."
            label, instr = _scaffold_line(j, ref_t, role, ending, default)
            parts.append(label); parts.append(instr)
        parts.append("")
    if intro_sents:
        parts.append(f"## 📐 INTRO 1:1 scaffold ({len(intro_sents)}문장)")
        for j, s in enumerate(intro_sents, 1):
            ending = (s.get("ending") or {}).get("kind", "")
            role = s.get("role", "transition")
            ref_t = s.get("text", "")
            default = f"     → 우리 Intro 문장 {j}: 위 참고문장의 **토픽·역할·구문 shape·종결({ending})** 그대로. 참고가 제품 재질을 도입하면 우리도 우리 제품 재질을 도입. 다른 주제 X."
            label, instr = _scaffold_line(j, ref_t, role, ending, default)
            parts.append(label); parts.append(instr)
        parts.append("")
    if cta_sents:
        parts.append(f"## 📐 CTA 1:1 scaffold ({len(cta_sents)}문장)")
        for j, s in enumerate(cta_sents, 1):
            ending = (s.get("ending") or {}).get("kind", "")
            role = s.get("role", "cta")
            ref_t = s.get("text", "")
            default = f"     → 우리 CTA 문장 {j}: 위 참고문장의 **토픽·역할·구문 shape·종결({ending})** 그대로. 인센티브·키워드는 우리 페르소나에 맞게."
            label, instr = _scaffold_line(j, ref_t, role, ending, default)
            parts.append(label); parts.append(instr)
        parts.append("")
    # 통일 시나리오 — 모든 Body가 같은 맥락 유지
    unified = select_unified_scenario(usps)
    if unified.get("city"):
        parts.append(f"## 🌏 통일 시나리오 — 모든 Body는 \"{unified['city']}\" 맥락 안에서 일관되게")
        parts.append(f"  ⚠️ 다른 도시(예: 다른 도시명) 절대 섞지 말 것. 한 영상 = 한 시나리오.")
        parts.append(f"  활용 가능 리뷰 ({unified['review_count']}개 from \"{unified['city']}\"):")
        for r in unified["supporting_reviews"]:
            parts.append(f"    · \"{r}\"")
        parts.append("")
    # Hook 후보 시나리오
    vivid = extract_vivid_scenarios(usps, limit=5)
    if vivid:
        parts.append("## 🎬 Hook용 vivid 시나리오 후보 (리뷰에서 추출)")
        # 통일 도시 시나리오 우선
        if unified.get("city"):
            city = unified["city"]
            vivid = [v for v in vivid if city in v] + [v for v in vivid if city not in v]
        for v in vivid[:5]:
            parts.append(f"  · \"{v}\"")
        parts.append("  → 위 시나리오 중 통일 도시와 일치하는 가장 강렬한 1개를 Hook 베이스로.")
        parts.append("")

    # 🚫 사실 grounding & USP 경계 락 — 환각 방지
    parts.append("## 🚫 사실 grounding & USP 경계 락 (환각 방지 — 위반 시 실패)")
    parts.append("⚠️ **수치 거짓말 금지**: 비율(%), 금액, 횟수, 기간 등 모든 수치는 **리뷰에 명시된 그대로**만 인용. 새 숫자 만들지 말 것")
    parts.append("   - ❌ 리뷰에 \"200만원→170만원\" → 우리가 \"20% 떨어졌다\" (15%인데 임의로 환산해 만들지 말 것)")
    parts.append("   - ❌ 리뷰 어디에도 없는 \"평균 30% 절약\" 같은 통계 지어내기")
    parts.append("⚠️ **USP 경계 락**: 한 문장은 그 분절의 USP 안에서만 근거 사용. **다른 USP의 기능·작동방식·전용 어휘 차용 절대 금지**")
    parts.append("   - 예: '가격추적' USP 분절에서 '가격알림' USP의 푸시 알림 기능 언급 X")
    parts.append("   - 한 USP의 리뷰만 이 분절 근거로 사용. 다른 USP 리뷰를 합성해 새 시나리오 만들지 말 것")
    parts.append("⚠️ **기능 합성 금지**: 리뷰에 적힌 일이 아니면 새 기능·동작·시나리오 발명 금지. 'X해주니 Y한다' 같은 인과 체인은 한 리뷰 안에 명시되어야 함")
    parts.append("⚠️ **새 클레임/포지셔닝 금지**:")
    parts.append("   - **랭킹 표현 금지**: 참고에 없으면 \"1위\", \"최고\", \"베스트\", \"국민\", \"필수템\", \"역대급\" 등 사용 X")
    parts.append("   - **타겟 신조어 금지**: 참고에 없으면 \"X러/X족/X파/X형\" (예: 예민러, 자취러, 캠핑족) 새 카테고리 명사 만들지 말 것")
    parts.append("   - **가치 단정 금지**: \"진짜\", \"리얼\", \"무조건\", \"꼭\", \"반드시\" 같은 강조어 — 참고가 안 쓰면 우리도 X")
    parts.append("⚠️ **레지스터(말투 등급) 락 — 참고와 같은 격식 수준 유지**:")
    parts.append("   - 참고가 친밀·캐주얼 (보여줄게~ / 봐봐 / 알려줄게~)이면 우리도 친밀·캐주얼")
    parts.append("   - 참고의 종결어미 (~게 / ~야 / ~지 / ~죠 등) 그대로 미러링. assertive로 격상 금지")
    parts.append("   - 참고가 형태·사실 묘사 (\"3피스 잠옷\")면 우리도 형태·사실. 포지셔닝 클레임으로 변환 금지")
    parts.append("     - ❌ \"3피스 잠옷 보여줄게~\" → \"1위 예민러 잠옷이야~\" (사실→랭킹/타겟 클레임 격상)")
    parts.append("     - ✅ \"3피스 잠옷 보여줄게~\" → \"여행용 캐리어 보여줄게~\" (사실→사실, 톤 유지)")
    parts.append("")

    parts.append("## USP — 분절별 매핑 + 마이크로 구조 + 사용 가능 리뷰")
    # USP별 어휘 도메인 hint (다른 USP의 단어를 빌리지 않게 격리)
    other_usps = [u.get("usp", "") for u in usps]
    # USP description 매핑 (이름으로 매칭)
    usp_desc_map = {(u.get("usp") or "").strip(): (u.get("description") or "").strip() for u in usps}
    for i, ua in enumerate(usp_alloc, 1):
        main_tag = " ⭐ [메인 USP]" if ua.get("is_main") else ""
        slot_n = i if i <= len(body_slots) else len(body_slots)
        parts.append(f"\n■ Body 분절 {slot_n}: {ua['usp']}{main_tag}")
        # USP description (있으면 이게 핵심 — LLM이 USP 영역을 정확히 이해)
        desc = usp_desc_map.get((ua.get("usp") or "").strip(), "")
        if desc:
            parts.append(f"  📋 기능 정의: {desc}")
            parts.append(f"     ⚠️ 이 분절의 모든 문장은 위 정의 범위 안에서만 작성. 정의 밖 기능·작동방식 언급 금지.")
        if ua.get("angle"):
            parts.append(f"  각도: {ua['angle']}")
        parts.append(f"  할당: {ua['alloc_sec']:.1f}초 ({ua['alloc_syllables']}음절)")
        # 분절 2 이상의 첫 문장은 전환어 권장 (강제 X)
        if slot_n >= 2:
            parts.append(f"  🔗 분절 {slot_n} 첫 문장: 자연스러운 흐름으로 새 USP 도입. 필요시 \"그리고/또/거기다\" 같은 전환어. 강제 X — 자연 흐름이 살아있으면 생략 가능")
            parts.append(f"     ⚠️ 단, 이전 분절과 가짜 인과(\"라서/하면\")로 묶지 말 것. 새 USP 토픽임을 명확히")
        # 다른 USP 어휘 침입 금지 명시 (description도 함께 표시 — 어디까지가 다른 USP인지 명확)
        forbidden = [(o, usp_desc_map.get(o, "")) for o in other_usps if o and o != ua["usp"]]
        if forbidden:
            parts.append(f"  🚫 이 분절에서 사용 금지 (다른 USP 영역):")
            for fo, fd in forbidden:
                if fd:
                    parts.append(f"     · \"{fo}\" — {fd}")
                else:
                    parts.append(f"     · \"{fo}\"")
        # 참고 분절의 마이크로 패턴 — 1:1 scaffold (참고 텍스트도 shape 가이드용으로 노출)
        micro = ua.get("ref_micro_pattern") or []
        if micro:
            n_micro = len(micro)
            parts.append(f"  📐 참고 분절의 1:1 scaffold — **정확히 {n_micro}문장**, 각 문장은 같은 위치 참고 문장의 **구문 shape·역할·톤·종결 패턴**을 모방 (단어·내용은 우리 USP):")
            for j, m in enumerate(micro, 1):
                syl = int((m['end']-m['start'])*_KOR_SYL_PER_SEC)
                deliv = f" [{m['delivery']}]" if m.get("delivery") and m["delivery"] != "normal" else ""
                ref_text = m.get("ref_text_for_pattern", "").strip()
                ending = m.get("ending_pattern", "")
                role = m.get('role', 'spec')
                parts.append(
                    f"     {j}) 참고문장 \"{ref_text}\" [역할={role}]"
                )
                parts.append(
                    f"        → shape: 톤={m.get('emotion')} {int(m.get('intensity',0)*100)}%{deliv} · ~{syl}음절 · 종결={ending}"
                )
                if _is_interjection_text(ref_text):
                    parts.append(
                        f"        → 우리 문장 {j}: ⚠️ **짧은 감탄어/호응어** — 우리도 비슷한 톤의 짧은 반응 (와/진짜/오/어머 등). 제품 기능 채우지 말 것. 같은 길이·리듬 유지."
                    )
                else:
                    parts.append(
                        f"        → 우리 문장 {j}: 위 참고문장의 **토픽(무엇에 대해 말하는지)·역할·구문 shape·종결** 그대로. 참고가 재질 묘사면 우리도 재질, 사이즈면 사이즈, 시연이면 시연. 다른 토픽 점프 금지. 참고의 동사·명사 복사 금지 (우리 USP·리뷰에서)."
                    )
        if ua["selected_reviews"]:
            parts.append(f"  사용할 리뷰 ({len(ua['selected_reviews'])}개, 임팩트 점수 순) — 부가설명·혜택 문장에 자연스럽게 녹여 활용:")
            for r in ua["selected_reviews"]:
                parts.append(f"    • \"{r}\" ({_count_kor_syllables(r)}음절)")
        else:
            parts.append("  (선별된 리뷰 없음 — USP 자체를 마이크로 구조에 맞게 풀어내세요)")
        # 이 USP의 vivid 일화 (혜택 문장에 활용)
        usp_vivid = extract_vivid_per_usp(ua["reviews"], top_n=2)
        if usp_vivid:
            parts.append(f"  💎 이 분절의 혜택·결과 문장에 활용할 vivid 일화 (구체 수치·장소 포함):")
            for v in usp_vivid:
                parts.append(f"    • \"{v}\"")
            parts.append(f"  → 분절의 마지막 문장(혜택)은 위 일화의 구체 수치·장소를 살려 작성. 추상 칭찬(\"좋네용\", \"너무 좋아요\") 금지.")

    parts.append("\n## 성공한 경쟁사 릴스 분석 (참고용)")
    for i, ref in enumerate(references):
        parts.append(_format_reference(ref, i))

    parts.append("""

## 작업
페르소나의 고민(Pain)을 첫 3초 안에 정확히 찌르는 Hook으로 시작해, 욕구(Desire)를 자극하는 흐름으로 이어가세요. 페르소나의 인구통계는 벤치 릴스와 USP 맥락에 맞게 자연스럽게 추론·반영하세요.

## 🎙 화자(host) 일관성 + 흐름 (가장 중요)
- 광고 = **한 명의 화자가 친구한테 이야기하듯** 말하는 영상. 끊긴 리뷰 모음이 아님.
- 리뷰는 **영감·시그널·일화**의 출처일 뿐, **텍스트 그대로 붙여넣지 말 것**.
- 한 명의 화자가 처음부터 끝까지 **자기 톤으로** 자연스럽게 말함. 인용된 후기처럼 들리면 실패.
- ❌ 나쁜 예 (리뷰 붙여놓은 느낌): "찰랑거리는 소재라 참 좋아요." / "부들부들 촉감이 진짜 좋아요." (둘 다 평가 종결, 화자 톤 X)
- ✅ 좋은 예 (자연스러운 화자): "찰랑거리는 실키 원단이거든요." / "그래서 한여름에도 몸에 안 들러붙어요." (전환어로 연결, 화자가 풀어 설명)

## ✨ 인접 문장 자연스러운 연결 (필수)
- 각 문장은 앞 문장과 **자연스럽게 이어져야** 함. 끊긴 평가 나열 X.
- 연결어 활용: "그래서 / 거든요 / 잖아요 / 근데 / 그리고 / 또 / 게다가 / 심지어 / 이게 또 / 그것도"
- 같은 종결어("좋아요/거든요") 연속 2번 이상 X — 종결 다양화로 호흡감 살리기.
- 문장끼리 **인과·시간·대조** 관계가 있어야 한 영상으로 들림.

## 📝 USP·리뷰 활용 방식
- 리뷰에서 가져올 것: vivid 단어("촤르르", "부들부들", "갓벽"), 구체 일화(수치, 상황), 감각 묘사
- 가져오지 말 것: 리뷰 문장 통째로, 평가어("진짜 좋아요" 등) 종결
- 예시: 리뷰에 "고양이털 안박히는 실키 소재라 너무 좋아요" → 우리는 "촤르르 흐르는 실키라 / 냥이가 뒹굴어도 / 털 한 올 안 박혀요" 식으로 풀어냄

**🎯 문장 수 — 위에 명시된 문장 수(Hook N문장, Intro N문장, Body 분절별 N문장, CTA N문장)를 따르세요. sentences 배열 길이는 합계 ±2 범위.**

**🔥 참고 릴스의 핵심 구조 의무 차용 (3가지)**
1. **Hook 빌드업**: 참고가 N분절(보통 2-3분절)이면 우리도 N분절로 호흡 빌드업. 한 문장에 압축 절대 금지.
2. **클라이맥스 빌드업 1문장 의무**: 참고에 "그리고 제일 중요한 포인트!", "근데 진짜 좋은 건," 류의 Body 후반 펀치 문장이 있으면 우리도 같은 위치에 동등한 펀치 문장 1개 삽입.
3. **마무리 한 줄 요약 (CTA 직전)**: 참고가 "이 X 하나로 해결" 류로 끝맺으면 우리도 메인 USP를 한 줄 요약으로 마무리한 후 CTA로 진입.

**❌ 절대 금지**
- "정말 좋아요", "최고예요", "찾거든요" 같은 마케터·후기 어휘 (실제 사용자 일상 어휘만)
- Hook을 한 문장에 우겨넣기
- Body에서 다른 USP·다른 페르소나 어휘 끌어오기 (target_persona LOCK 위반)

**📌 토픽 도입 문장의 처리**
- 참고에 "마지막으로 X 기능.", "그리고 X 기능."처럼 [전환어 + 기능명 + 명사형 종결] 형태가 있으면, 우리도 동일하게 [전환어 + USP 기능명]을 한 문장에 담으세요.
- ❌ "마지막으로," 만 단독으로 떨어뜨리지 말 것.
- ✅ [전환어 + 우리 USP 기능명]을 한 문장에 담아내기.

**💭 Desire (욕구) 활용 — 자연스러운 위치만**
Desire 키워드는 다음 위치 중 **자연스럽게 어울리는 곳에만** 사용 (강제 끼워넣기 금지):
- Intro: 페인 해결 후 도달 상태 묘사
- CTA: 미래 시점 호소
- Body의 결과/혜택 문장 (단, 어색하면 사용 X)
- ❌ 차별점·경고 문장(예: "단, ..." 자리)에 Desire 강제 끼워넣지 말 것
- ❌ 같은 Desire 키워드 반복 사용 금지 (1~2회면 충분)
- ✅ Desire와 자연스러운 흐름이 충돌하면 Desire 무시하고 자연스러움 우선

**🔧 USP 작동 흐름 강화 (USP 이름이 추상적이어도)**
- USP 이름이 추상 명사면, 그 USP의 **리뷰에서 사용 흐름**을 추론해 Body 도입을 구체화하세요.
- 리뷰에서 [어떤 행동] → [어떤 결과] 흐름을 뽑아 한 문장으로 묘사.
- 추상명사만 나열 ❌. 항상 [어디서] [무슨 액션] [어떤 결과] 구조.

**🛠️ 기능(USP) 작동 흐름이 카피의 중심 (가장 중요)**
- Body의 본질은 **제품 기능의 실제 작동·사용 흐름** 또는 **사용 결과·체감** 보여주기. 리뷰는 그것을 뒷받침하는 보조 증거.
- 각 USP 분절의 첫 문장은 **기능이 어떻게 작동/사용되는지** 또는 **사용 시 어떤 변화가 일어나는지** 구체적으로 설명:
  - "[어디서/언제] [어떤 액션] 하면 [어떤 결과]" 형식
- 두 번째 문장: 부가 조건·차별점·메커니즘 (왜 이게 좋은지)
- 세 번째 문장: 혜택·결과·수치 (리뷰의 구체적 표현 활용 OK)
- ❌ 금지: 1·2번째 문장에서 리뷰 일화부터 시작하기 (시청자가 "그래서 이게 뭔데?" 모름)
- ❌ 금지: 기능 설명 없이 리뷰 칭찬만 ("스트레스 풀렸대요!" 같은 막연한 후기)
- ✅ 필수: 시청자가 영상 보고 "아, 이렇게 작동하는구나" 또는 "이런 변화가 있구나" 정확히 이해

**🔒 USP 도메인 격리 (혼용 금지)**
- 각 Body 분절은 자기에게 매핑된 USP의 의미·어휘 안에서만 작성. 다른 USP 어휘 침입 금지.
- 분절 간 전환은 "그리고", "또한", "마지막으로" 등으로 명확히.

**🇰🇷 자연스러운 한국어가 최우선 (형식보다 우선)**
- 참고의 어미·구조는 **참고용 영감**이지 강제 템플릿이 아닙니다.
- 우리 USP·리뷰의 자연스러운 한국어 표현이 우선. 형식 맞추려고 어색한 문장 만들지 마세요.
- 광고 카피로서 시청자에게 매끄럽게 들려야 합니다. 한국어 모어 화자가 어색하다고 느낄 표현 금지.
- 예: 참고의 종결 어미가 우리 콘텐츠에 안 어울리면 다른 어미로 자유롭게 교체.
- 핵심: 어미 형식 맞추려고 단어·조사가 부자연스러워지면 형식 포기.

**🎵 참고에서 차용할 것 (자연스러움을 해치지 않는 선에서)**
- 톤 변화 곡선 (감정·delivery 흐름) — 시청자 몰입 유도 패턴
- 호흡 (절 수가 비슷하면 좋지만 ±1 허용)
- 전환 패턴 (Hook→Intro 전환 방식, Body 분절 간 연결, CTA 유도 방식)
- 부사·어미는 자연스러우면 차용, 어색하면 다른 표현으로 자유롭게 교체

❌ 금지: 참고 문장의 동사·명사·고유어 그대로 재사용 (표절)
❌ 금지: 형식 맞추려고 어색한 한국어 만들기
✅ 자유: 절 개수, 어미 형태, 부사 위치 모두 콘텐츠가 자연스럽게 살아나는 방향으로 조정

**🎬 Hook은 참고 분류 유형을 따른다**
- 위 "참고 대본 패턴 분석"의 Hook 유형을 그대로 따라야 함:
  - 충격_질문형: "이 X 모르고 / 아직도 Y하시나요?" 형태
  - 질문형: "X 한 적 있으신가요?" 형태
  - 충격형: "X 모르면 손해" 형태
  - 공감_명령형: "X 했다면 Y하지 마세요" 형태
  - 통계_충격형: "X만원? Y%?" 숫자 강조
- ❌ 금지: 사용자 입력 Pain을 그대로 Hook에 옮기기 (Pain은 의도일 뿐, Hook은 참고 유형의 시나리오)
- ❌ 금지: "X해서 속상했다면?" 같은 추상적 진술 (단, 참고가 공감_명령형이면 OK)

**📐 Pain을 vivid 시나리오로 재구성하는 단계 (Hook 작성 전 필수)**
1. 사용자 입력 Pain을 분석 → 어떤 도메인의 어떤 고통인지 파악
2. 메인 USP(USP 1)의 리뷰 중 그 도메인의 vivid 일화(숫자·장소·시점) 찾기
3. 그 일화를 Pain의 시각으로 재해석한 한 장면을 Hook으로 작성
- 핵심: Pain에 등장하는 [상황/숫자/장면] + 리뷰에 등장하는 [구체 일화] = Hook 한 장면
- 한국어 모어 화자가 듣고 "아, 나도 그런 적!" 라고 즉시 공감할 한 장면 (해당 페르소나의 실제 일상)

**🎯 Pain ↔ USP 1 (메인) 무조건 연결 (절대 규칙)**
- Hook은 Pain의 도메인과 USP 1의 도메인이 만나는 지점을 직접 찌릅니다.
- USP 1이 메인 슬롯(주로 Body 2)에 있고, Hook의 페인 → USP 1이 해결하는 구조.
- Pain 도메인이 USP 1과 동떨어져 보이면, USP 1 리뷰에서 Pain 흔적을 찾아 시나리오로 통합.
- 절대로 Hook을 USP 2/3/4 도메인으로 시작하지 마세요 — 메인 흐름 깨짐.

**🔗 Hook ↔ Intro ↔ 메인 USP 연결 규칙 (매우 중요)**
- Hook은 **메인 USP** (각도가 "메인 USP"로 표시된 분절)가 해결하는 페인을 정확히 찌릅니다.
- 사용자 입력 Pain이 메인 USP와 다른 도메인이어도 메인 USP의 핵심 페인을 우선.
- Intro는 메인 USP가 그 페인의 솔루션이라고 자연스럽게 알립니다.
- 메인 USP가 위치한 분절(주로 Body 2)의 첫 문장이 Hook과 Intro의 페인·솔루션을 구체화하는 핵심 작동 설명.
- 보조 USP들(Body 1, Body 3)은 메인 USP를 둘러싼 도입·마무리 역할 — 메인을 설명하기 전 짧은 setup 또는 마무리 추가 혜택.
- Hook→Intro→메인 USP까지 한 흐름이 끊기지 않게.

**🎬 Body 분절 간 전환**

⚠️ **가짜 인과 어미 금지**
- 두 USP를 "라서/하면/면" 같은 **인과 연결 어미**로 묶지 말 것 (실제 인과 관계 없으면)
- ❌ 가짜 인과 예: "여름소재라서 깊숙한 주머니에 폰 빠질 걱정도 없었고" — 시원함 ≠ 주머니 깊이, 인과 관계 없음
- 자연스럽게 묶을 수 있는 경우 (실제 인과·연관 있음):
  - 같은 USP의 spec → benefit: "찰랑거리는 실키 원단이라 한여름에도 안 들러붙어요" (재질 → 그 재질의 효과 = 인과 OK)
  - USP A가 USP B의 전제: "Body 슬롯 간 자연 인과면 OK"

⚠️ **분절 전환 시 종결**
- 분절 끝 → 다음 분절로 넘어갈 때, 끝 문장은 **종결형 권장**:
  - "~거든요", "~잖아요", "~끝.", "~없어요", "~예요"
- 연결 어미("라서/하면/고") 사용 시: 다음 문장이 진짜 그 인과의 결과여야 함
- 분절 첫 문장에 전환어("그리고/또/거기다/마지막으로")를 자연스럽게 (의무는 아님, 흐름이 자연스러우면 생략 가능)

⚠️ **자연스러움 우선 — 강제 분리 X**
- 한 문장에 두 USP가 자연스럽게 연결되면 OK
- 다만 무관한 두 USP에 가짜 인과 만들면 ❌
- 종결 어미 강제 X — 자연 흐름이 살아있으면 어떤 어미든 OK

## 참고 대본 활용 — 차용 vs 격리
**차용 (반드시 따라할 것)**:
- HOOK 진입 패턴 (분절 수, 문장 형태, 빌드업)
- INTRO 솔루션 선언 패턴
- BODY 분절 수와 각 분절의 문장 수
- 클라이맥스 빌드업 위치
- CTA 진입 패턴
- 톤 변화 곡선 (감정 + delivery 흐름)
- 끝맺음 어휘 패턴 (이모지·종결어미)

**격리 (절대 사용 금지)**:
- 참고의 페인·페르소나·USP·상품 정보·예시 텍스트 그대로 가져오기
- 참고의 동사·명사·고유어를 그대로 복사
- (구조만 차용, 내용은 우리 USP/리뷰로)

## 규칙
- Hook은 첫 3초 안에 시청자를 잡아야 함 — 참고 분절 수 엄수.
- USP를 직접 나열하지 말고 리뷰의 자연스러운 표현으로 풀어낼 것.
- direction·delivery·emotion은 참고 릴스 패턴을 분석해 적절히 부여.
- delivery는 "normal", "whispers", "shouts", "slowly", "very_fast" 중 선택.
- emotion은 happy, excited, sad, angry, fearful, surprised, neutral, calm, crying, nervous, curious, serious, tired, calm, frustrated, cheerful, sarcastic, mischievously 중 선택.

## 출력 형식 (JSON만, 다른 텍스트 없이)
{
  "duration_target_sec": <영상 총 초>,
  "structure": {
    "hook": {"seconds": "0-3", "text": "...", "type": "...", "analysis": "..."},
    "intro": {"seconds": "3-7", "text": "...", "analysis": "..."},
    "body": {"seconds": "7-N", "text": "...", "key_points": ["..."], "analysis": "..."},
    "cta": {"seconds": "N-끝", "text": "...", "type": "...", "analysis": "..."},
    "overall": {"flow": "...", "strength": "...", "why_it_works": "..."}
  },
  "sentences": [
    {"start": 0.0, "end": 3.0, "text": "...", "direction": "궁금하게 묻는다", "emotion": "curious", "intensity": 0.7, "delivery": "normal"},
    ...
  ],
  "tts_script": "(direction)(emotion N%) text\\n(direction)(emotion N%) text\\n..."
}
""")
    return "\n".join(parts)


def call_gemini(prompt: str, min_sentences: int | None = None, model: str | None = None, max_tokens: int = 32768) -> dict:
    """Gemini 호출 → JSON 응답 파싱.

    model: 미지정 시 기본 MODEL (script_gen용 Pro). 페르소나 추출 등 가벼운 분류엔 Flash 권장.
    min_sentences가 주어지면 responseSchema로 sentences 배열 minItems 강제.
    """
    key = _gemini_key()
    if not key:
        raise RuntimeError("GEMINI_API_KEY 없음 (Vault 또는 env)")
    use_model = model or MODEL
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{use_model}:generateContent"
    gen_config: dict = {
        "temperature": 0.85,
        "responseMimeType": "application/json",
        "maxOutputTokens": max_tokens,
    }
    if min_sentences is not None:
        gen_config["responseSchema"] = {
            "type": "object",
            "properties": {
                "duration_target_sec": {"type": "number"},
                "structure": {"type": "object"},
                "sentences": {
                    "type": "array",
                    "minItems": max(1, min_sentences),
                    "items": {
                        "type": "object",
                        "properties": {
                            "start": {"type": "number"},
                            "end": {"type": "number"},
                            "text": {"type": "string"},
                            "direction": {"type": "string"},
                            "emotion": {"type": "string"},
                            "intensity": {"type": "number"},
                            "delivery": {"type": "string"},
                        },
                        "required": ["start", "end", "text"],
                    },
                },
                "tts_script": {"type": "string"},
            },
            "required": ["sentences"],
        }
    body = {
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": gen_config,
    }
    r = requests.post(url, params={"key": key}, json=body, timeout=240)
    if r.status_code != 200:
        raise RuntimeError(f"Gemini call {r.status_code}: {r.text[:300]}")
    data = r.json()
    # 비용 추적 — usageMetadata 기록
    try:
        um = data.get("usageMetadata") or {}
        in_tok = int(um.get("promptTokenCount", 0))
        out_tok = int(um.get("candidatesTokenCount", 0))
        _cost_meter.append({"model": use_model, "in_tokens": in_tok, "out_tokens": out_tok})
    except Exception:
        pass
    text = ""
    try:
        text = data["candidates"][0]["content"]["parts"][0]["text"]
    except Exception:
        raise RuntimeError(f"Gemini 응답 파싱 실패: {json.dumps(data)[:300]}")
    # finishReason 검사 — MAX_TOKENS이면 잘린 응답
    finish_reason = ""
    try:
        finish_reason = data["candidates"][0].get("finishReason", "")
    except Exception:
        pass
    if finish_reason == "MAX_TOKENS":
        logger.warning("Gemini response truncated (MAX_TOKENS, %d chars)", len(text))
    try:
        return json.loads(text)
    except json.JSONDecodeError as e:
        # 잘린 JSON일 가능성 — sentences 배열까지만 파싱 시도
        if finish_reason == "MAX_TOKENS" or len(text) > 14000:
            try:
                # sentences 배열에서 마지막 } 찾기
                import re as _re
                # 가장 마지막의 완전한 sentence 객체 끝까지 자르고 array 닫기
                m = _re.search(r'"sentences"\s*:\s*\[', text)
                if m:
                    arr_start = m.end()
                    # 마지막 완전한 } 찾기
                    last_complete = arr_start
                    depth = 0
                    for i, ch in enumerate(text[arr_start:], arr_start):
                        if ch == '{': depth += 1
                        elif ch == '}':
                            depth -= 1
                            if depth == 0: last_complete = i + 1
                    salvaged = text[:last_complete] + "]}"
                    parsed = json.loads(salvaged)
                    logger.warning("salvaged truncated response with %d sentences", len(parsed.get("sentences") or []))
                    return parsed
            except Exception as e2:
                logger.warning("salvage failed: %s", e2)
        # 마크다운 코드 펜스 제거 시도
        cleaned = text.strip().lstrip("```json").lstrip("```").rstrip("```").strip()
        return json.loads(cleaned)


def detect_awkward_sentences(sentences: list[dict], ref_sents: list[dict] | None = None) -> list[dict]:
    """Flash로 어색한 한국어 문장 감지.
    Returns: [{"idx": i, "text": "...", "reason": "왜 어색한지"}]
    """
    if not sentences:
        return []
    sent_lines = []
    for i, s in enumerate(sentences):
        ref_text = ""
        if ref_sents and i < len(ref_sents):
            ref_text = ref_sents[i].get("text", "")
        ref_part = f' (참고: "{ref_text}")' if ref_text else ""
        sent_lines.append(f'  [{i+1}] "{s.get("text","")}"{ref_part}')

    prompt = f"""당신은 한국어 광고 카피 검수자입니다. 아래 문장들을 읽고 **자연스럽지 않은 한국어** 문장만 골라내세요.

## 문장 목록
{chr(10).join(sent_lines)}

## 어색한 패턴 (검출 대상)
1. **의미 충돌**: 동사·목적어 의미 안 맞음 (예: "털 박힘은 절대 지킨" — 막아야 할 걸 지킨다는 모순)
2. **위치격 부적절**: "X에 Y와 Z으로" 같이 조사가 의미 안 맞음 (예: "재질에 매끈함과 부드러움으로" — "재질이 매끈하고"가 자연)
3. **명사화 어색**: "줄어듦/굽혀짐/쳐지지않음" 같은 어색한 명사화
4. **이질 결합**: 다른 종류의 명사 묶음 (예: "실크와 튼튼함" — 소재+특성)
5. **조사 누락/과잉**: "이/가/을/를/은/는/와/과/에/에서" 부적절
6. **시그니처 변형**: ref 시그니처가 어색하게 변형됨
7. **추상명사+물리형용사 mismatch** ⚠️: 추상명사(포인트/순간/이유/매력/장점/팁) 앞에 USP 물리감각 형용사가 박힘 (예: "제일 시원한 포인트" — "시원한"은 물리, "포인트"는 추상 → mismatch). 평가형(중요한/좋은/핵심/특별한)이 어울림.

## 출력 규칙
- **자연스러운 문장은 출력 X** — 어색한 것만
- 각 어색한 문장에 대해 짧은 reason (15자 이내)
- 어색 없으면 빈 리스트 []

## 출력 JSON
{{"awkward": [{{"idx": 5, "text": "냥이 털박힘은 절대 지킨", "reason": "지킨다 의미 충돌"}}, ...]}}

JSON만. 설명 X."""

    try:
        result = call_gemini(prompt, model="gemini-3-flash-preview", max_tokens=2048)
        if isinstance(result, dict):
            return result.get("awkward") or []
    except Exception as e:
        logger.warning("[awkward] detection failed: %s", e)
    return []


def build_refine_prompt(draft: dict, unified_city: str | None, ref_info: dict | None = None, usps: list[dict] | None = None, awkward_info: list[dict] | None = None) -> str:
    """1차 결과를 다듬기 위한 검토 프롬프트.

    ref_info가 있으면 길이 매칭 + 리뷰 내용 조정 추가.
    awkward_info가 있으면 어색 문장 명시 + 강제 수정 지시.
    """
    sentences = draft.get("sentences", [])
    sent_text = "\n".join(
        f'  [{s.get("start",0):.1f}~{s.get("end",0):.1f}s] ({s.get("direction","")}) ({s.get("emotion","")} {int((s.get("intensity") or 0)*100)}%) "{s.get("text","")}"'
        for s in sentences
    )
    city_rule = f"- 시나리오 도시는 반드시 \"{unified_city}\" 하나로 통일. 다른 도시명 등장 시 \"{unified_city}\"로 교체.\n" if unified_city else ""

    # 어색 문장 강제 교정 블록 (Flash 검출 결과 기반)
    awkward_block = ""
    if awkward_info:
        aw_lines = []
        for aw in awkward_info:
            idx = aw.get("idx", 0)
            txt = aw.get("text", "")
            reason = aw.get("reason", "어색")
            aw_lines.append(f'  [{idx}] "{txt}" — {reason}')
        awkward_block = "\n## ⚠️ 어색 문장 — 강제 교정 필수\n" + "\n".join(aw_lines) + "\n→ 위 문장은 자연 한국어로 다시 쓰기 (의미·시그니처 보존)\n"

    # 길이 매칭 섹션
    length_match_block = ""
    if ref_info:
        ref_n = ref_info.get("sentence_count", 0)
        ref_dur = ref_info.get("duration", 0)
        ref_sents = ref_info.get("sentences", [])
        draft_n = len(sentences)
        draft_dur = max((float(s.get("end", 0)) for s in sentences), default=0)
        ref_lines = "\n".join(
            f"  [{float(s.get('start',0)):.1f}-{float(s.get('end',0)):.1f}s] \"{s.get('text','')}\""
            for s in ref_sents[:30]
        )

        # 우리가 ref보다 긴지 짧은지
        if draft_n > ref_n:
            length_match_block = f"""
## ⚠️ 길이 매칭 (가장 중요)
- 참고 릴스: **{ref_n}문장 / {ref_dur:.1f}초**
- 우리 1차: **{draft_n}문장 / {draft_dur:.1f}초** (TOO LONG)
- 작업: **{ref_n}문장으로 압축** — 리뷰 내용을 짧은 표현으로 바꿔서 길이 맞추기
- 합치기·삭제 OK (단, 시그니처와 흐름은 보존)
- 우리 1차 문장에서 **장황한 표현 → 더 짧은 리뷰 표현**으로 substitute
- **각 문장 음절 = 참고 ±15% 이내** — 위치별로 참고 문장 음절수에 맞춰 압축

### 참고 릴스 ({ref_n}문장)
{ref_lines}

→ 위 참고와 같은 호흡·길이로 우리 카피를 압축. 각 문장의 start/end는 참고와 동일하게.
"""
        elif ref_n > draft_n:
            length_match_block = f"""
## ⚠️ 길이 매칭
- 참고 릴스: **{ref_n}문장 / {ref_dur:.1f}초**
- 우리 1차: **{draft_n}문장 / {draft_dur:.1f}초** (TOO SHORT)
- 작업: 참고 추가 문장 위치에 맞춰 **{ref_n - draft_n}문장 추가**
- **각 문장 음절 = 참고 ±15% 이내** — 위치별로 참고 문장 음절수에 맞춰 작성

### 참고 릴스 ({ref_n}문장)
{ref_lines}
"""
        else:
            length_match_block = f"""
## 길이 — 참고와 동일 ({ref_n}문장 / {ref_dur:.1f}초)
- 참고와 우리 둘 다 {ref_n}문장. 길이 변경 X. 텍스트만 다듬기.
- **각 문장 음절 = 참고 ±15% 이내** — 위치별로 참고 문장 음절수에 맞춰 다듬기

### 참고 릴스 ({ref_n}문장)
{ref_lines}
"""

    target_n = (ref_info or {}).get("sentence_count") or len(sentences)
    return f"""당신은 한국어 광고 카피 에디터입니다. 아래 1차 카피를 검토하고 다듬어 최종본을 만드세요.

## 1차 카피
{sent_text}

{length_match_block}

## 절대 규칙
- **문장 개수 = {target_n}개** (±2 허용) — 모든 문장 출력
- **각 문장 음절 = 참고 ±15% 이내** — 위치별로 참고 음절수에 맞춰 다듬기
- **마케터 톤 어휘 제거** ("최고잖아요/딱이죠/찾거든요/어때요/도와줘요/줍니다/입니다" → 자연 일상 어휘)
- **참고 시그니처(끝 어구) 보존** — 1차에 시그니처 변형됐으면 원복
- emotion·delivery·direction은 1차 값 유지 (텍스트만 다듬기)
{awkward_block}
## 검토·다듬기 규칙
{city_rule}- 어색한 한국어 어미·동사 조합 교체
- 같은 단어·어미 반복 줄임 (~죠 3+ 연속이면 변형)
- 절·조사 자연스럽게
- 인접 문장 흐름 매끄럽게 (논리 비약 X)
- 추상 칭찬 구체화 ("좋아요" → 구체 결과)
- 추상 명사구 제거 ("활동성/편의성/효율성/만족도/쾌적함")
- 길이 매칭 위해 리뷰의 더 짧은 vivid 표현으로 substitute (위 길이 매칭 섹션 참조)

## 어색 패턴 검출 + 강제 교정 (자주 나오는 실수)
1. **의미 충돌 동사 조합** — "X 박힘은 절대 지킨" → 막아야 할 걸 지킨다는 모순
   - ✅ 교정: "X 박힘은 절대 막아낸"
2. **위치격 부적절** — "재질에 매끈함과 부드러움으로" → "재질에"가 어색
   - ✅ 교정: "재질이 매끈하고 부드러워서" 또는 "매끈한 부드러운 재질로"
3. **명사화 어색** — "줄어듦/굽혀짐/쳐지지않음"
   - ✅ 교정: 동사형/형용사형으로 "줄지 않고/굽지 않는/안 쳐져"
4. **이질 결합** — "실크와 튼튼함을 맞춘" (소재 + 특성)
   - ✅ 교정: 같은 카테고리로 통일 "실크처럼 튼튼한 / 부드러우면서 튼튼한"
5. **시그니처 변형** — 끝 어구 "잖아요/거든요/보여줄게" 임의 변경
   - ✅ 교정: 참고 원본 시그니처로 원복

## 출력 (JSON만)
- 형식: {{"sentences": [...]}} (정확히 {target_n}±2개 객체)
- 각 문장 schema: start, end, text, direction, emotion, intensity, delivery
- 위 1차 카피의 emotion/delivery/direction은 그대로 복사, **text만 다듬기**
"""


def _find_refine_overflow(refined_sents: list[dict], ref_sents: list[dict]) -> list[tuple[int, int, int, str, str]]:
    """refined 결과에서 ref 대비 1.15x 초과 문장 검출.
    Returns: [(idx, gen_syl, ref_syl, ref_text, gen_text), ...]
    """
    violations = []
    for i in range(min(len(refined_sents), len(ref_sents))):
        ref_text = ref_sents[i].get("text", "")
        gen_text = refined_sents[i].get("text", "")
        if not ref_text or not gen_text.strip():
            continue
        ref_syl = _count_kor_syllables(ref_text)
        gen_syl = _count_kor_syllables(gen_text)
        if ref_syl > 0 and gen_syl > ref_syl * 1.15:
            violations.append((i, gen_syl, ref_syl, ref_text, gen_text))
    return violations


def build_refine_retry_prompt(prev_refined: dict, violations: list[tuple], all_ref_sents: list[dict]) -> str:
    """오버플로우 문장만 명시한 재작성 prompt."""
    lines = []
    for idx, gen_syl, ref_syl, ref_text, gen_text in violations:
        lines.append(
            f"  [{idx+1}] 참고({ref_syl}음절) \"{ref_text}\" → 우리({gen_syl}음절) \"{gen_text}\""
            f" — **{ref_syl}±2 음절로 강제 압축** (현재 {gen_syl - ref_syl}음절 초과)"
        )
    sent_text = "\n".join(
        f'  [{i+1}] [{s.get("start",0):.1f}~{s.get("end",0):.1f}s] "{s.get("text","")}"'
        for i, s in enumerate(prev_refined.get("sentences") or [])
    )
    n_total = len(prev_refined.get("sentences") or [])
    return f"""당신은 한국어 광고 카피 에디터입니다. 직전 다듬기 결과에서 **음절 초과 문장만** 다시 압축하세요.

## ⚠️ 음절 초과 — 강제 압축 필수
{chr(10).join(lines)}

## 직전 결과 전체 ({n_total}문장)
{sent_text}

## 출력 룰 (가장 중요)
- **출력은 반드시 모든 {n_total}문장 포함** — 변경 없는 문장도 직전 결과 텍스트 **그대로 복사**해서 함께 출력
- 위 표시된 문장만 음절 줄이기. **표시 없는 문장은 한 글자도 변경 X** (그대로 복사)
- 의미·시그니처(끝 어구) 보존. 핵심 키워드 1-2개만 남기고 수식어 제거.
- emotion/delivery/direction/start/end 모두 그대로 유지.

## 압축 예시
- "한여름 밤에 잠 안 올 일 생기면" (12음절) → "잠 안 올 일 생기면" (8음절)
- "시원한 것도 좋은데 세탁이나 건조기 돌려도" (17음절) → "세탁 건조기 돌려도" (8음절)
- "어떻게 맞는지 바로 보여줄게" (11음절) → "바로 핏 보여줄게" (7음절)

## 출력 (JSON만)
{{"sentences": [{n_total}개 모두] }}형식. 직전 결과와 동일 schema (start/end/text/direction/emotion/intensity/delivery).

{json.dumps(prev_refined, ensure_ascii=False, indent=2)}
"""


def analyze_usp_layout(sentences: list[dict]) -> dict | None:
    """ref의 USP 배치 흐름 분석 — 어느 USP가 어느 섹션들에서 등장하는지.

    sentences = [{start, end, text, section}] (classify_sentence_sections 거친 후)
    Returns: {"ref_usps": [{id, label, description, appears_in, evidence}, ...]}
    """
    if not sentences:
        return None
    sec_texts: dict[str, list[str]] = {}
    for s in sentences:
        sec = (s.get("section") or "?").strip()
        if not sec or sec == "?":
            continue
        sec_texts.setdefault(sec, []).append(f"[{s.get('start',0):.1f}s] {s.get('text','')}")
    if not sec_texts:
        return None

    sec_block = ""
    for k in ["hook", "intro", "body_1", "body_2", "body_3", "body_4", "body_5", "body_6", "body", "cta"]:
        if k in sec_texts:
            sec_block += f"\n## {k}\n" + "\n".join(sec_texts[k]) + "\n"

    prompt = f"""당신은 광고 대본 분석가입니다. 이 인스타 릴스 ref를 분석해서 (1) USP 배치 (2) 광고 포맷 분류 (3) 광고 적합성 점수를 출력하세요.

## ref 섹션별 문장
{sec_block}

## 작업 1: USP 배치 분석
1. **USP = 제품의 구체 feature/혜택** (예: "우버 할인 코드", "모달 안감", "푸시 알림 기능"). 추상 카테고리·umbrella 약속 X.
2. ⚠️ **Hook/Intro/CTA는 USP가 아닐 수 있음 — appears_in에 강제 포함 금지**
   - Hook이 호기심 유도·저장권유·스크롤멈추기·페인 제기 같은 **engagement** 역할이면 → 어느 USP의 appears_in에도 hook 추가 금지
   - Intro가 혜택 약속·티저·맥락 도입 (구체 feature 언급 X)이면 → appears_in에 intro 추가 금지
   - CTA는 행동 유도 — USP 명시적 재언급 없으면 appears_in 비움
   - 단, 해당 섹션에서 **구체 USP feature를 직접 명시·시연**하면 그때만 추가
3. body 섹션 매핑은 컨텐츠대로 — 같은 USP가 여러 body에 걸치거나 여러 USP가 한 body에 들어갈 수도 있음 (강제 분리 X)
4. MAIN USP = 시간 비중 가장 큰 / 댓글 트리거 / 카피의 핵심 약속을 실제 구현하는 USP
5. SUB USP = 보조 feature
6. 각 USP description = 구체 키워드 포함 한 줄 요약 (umbrella·추상 카테고리 금지)
7. evidence = 핵심 어구 인용 (50자 이내)
8. ⚠️ **umbrella USP 만들지 말 것** — 예: "할인 정보 모음" (X) → 우버/쇼핑/클룩 각각의 USP로 분리 (O)

### USP 세분화 룰 — **mechanism(디자인 요소) 기준으로 분리**
**한 USP = 하나의 design feature/mechanism**(브이넥, 셔링·절개, 모달 안감, 스트랩, 단추, 리본, 푸시 알림 기능, 우버 할인코드 등) **이 만들어내는 효과 묶음**.

- ✅ **다른 mechanism = 다른 USP** (같은 body 안에 있어도 split):
  - "브이넥(가슴골 가림)" + "셔링·절개(체형 보정)" → 두 mechanism이라 2 USP
  - "스트랩 조절" + "모달 안감" → 다른 mechanism, 2 USP
  - "단추 디테일" + "리본 포인트" → 다른 mechanism, 2 USP
- ✅ **같은 mechanism의 여러 효과 = 1 USP**:
  - "셔링·절개 → 가슴 라인 미관 + 부유방 커버" → 같은 셔링·절개 mechanism의 두 효과, 1 USP
  - "모달 안감 → 부드러운 촉감 + 통풍성" → 같은 모달의 두 효과, 1 USP
- ❌ **추상 카테고리로 묶지 말 것**: "디자인 디테일", "체형 보정", "내구성", "품질" 같은 umbrella는 USP가 아님
- ❌ **잘못된 예** (절대 하지 말 것): "브이넥과 셔링 디테일을 통한 체형 보정" → 두 mechanism을 카테고리로 묶음 (X)
  - 올바른 split: USP_n = "브이넥 라인으로 가슴골 노출 방지" / USP_n+1 = "셔링·절개로 가슴 라인 미관 + 부유방 보정"
- ⚠️ 같은 USP(같은 mechanism)가 여러 body에 걸쳐 반복 강조되면 appears_in에 그 body들 모두 추가
- description = "[mechanism 명사]로 [효과 동사]" 형식. mechanism이 무엇인지 명확히.

## 작업 2: 광고 포맷 분류 (정확히 1개)
- **광고형**: 직접적 USP 푸시, "이 제품이 좋다", CTA 명확 (구매·앱다운로드·링크)
- **정보형**: 팁·지식·노하우 공유, "X 하는 법", 제품 언급 후순위
- **후기형**: 사용 경험·리뷰, "써봤더니~", 실증 위주
- **브랜딩형**: 브랜드 스토리/가치/철학, "우리는 이렇게 만든다", 감성 호소
- **유머형**: 짤·밈·엔터테인먼트, 재미 우선
- **일상형**: 브이로그·사연·다이어리, 스토리 우선, USP 무관

## 작업 3: 광고 적합성 (0-100)
이 ref를 우리 product 광고 ref로 사용했을 때 USP 매핑이 자연스러운 정도.
- 광고형: 90-100 (그대로 광고로 적합)
- 후기형: 70-85 (USP 적용 자연)
- 정보형: 55-75 (정보→USP 매핑 가능)
- 브랜딩형: 45-65 (가치→USP)
- 유머형: 25-45 (재미 우선이라 어색)
- 일상형: 15-35 (스토리 우선, USP 매핑 강제됨)

## 출력 JSON
{{
  "ref_usps": [
    {{"id": 1, "label": "MAIN", "description": "...", "appears_in": ["hook", "intro", "body_1"], "evidence": "..."}},
    {{"id": 2, "label": "SUB", "description": "...", "appears_in": ["body_2"], "evidence": "..."}}
  ],
  "ad_format": "광고형 | 정보형 | 후기형 | 브랜딩형 | 유머형 | 일상형",
  "ad_suitability_score": 75,
  "ad_format_reason": "한 줄 근거 (왜 이 포맷인지)"
}}
JSON만. 설명 X."""
    def _extract(d: dict) -> dict | None:
        if not isinstance(d, dict) or not d.get("ref_usps"):
            return None
        return {
            "ref_usps": d["ref_usps"],
            "ad_format": d.get("ad_format"),
            "ad_suitability_score": d.get("ad_suitability_score"),
            "ad_format_reason": d.get("ad_format_reason"),
        }
    try:
        result = call_gemini(prompt, model="gemini-3-flash-preview", max_tokens=4096)
        if isinstance(result, list) and result:
            result = result[0]
        out = _extract(result)
        if out:
            return out
    except Exception as e:
        logger.warning("analyze_usp_layout call failed: %s — retrying with raw extraction", e)
        try:
            import re as _re, json as _json, requests as _req, os as _os
            key = _os.getenv("GEMINI_API_KEY") or _gemini_key()
            url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent"
            body = {"contents": [{"role": "user", "parts": [{"text": prompt}]}],
                    "generationConfig": {"temperature": 0.7, "maxOutputTokens": 4096, "responseMimeType": "application/json"}}
            r = _req.post(url, params={"key": key}, json=body, timeout=120)
            if r.status_code == 200:
                txt = r.json()["candidates"][0]["content"]["parts"][0]["text"]
                depth = 0
                start = txt.find("{")
                if start >= 0:
                    for i in range(start, len(txt)):
                        if txt[i] == "{": depth += 1
                        elif txt[i] == "}":
                            depth -= 1
                            if depth == 0:
                                first_json = txt[start:i+1]
                                parsed = _json.loads(first_json)
                                out = _extract(parsed)
                                if out:
                                    return out
                                break
        except Exception as e2:
            logger.warning("analyze_usp_layout retry failed: %s", e2)
    return None


def classify_sentence_sections(sentences: list[dict], structure: dict) -> list[dict]:
    """각 sentence에 section(hook/intro/body_N/cta) 라벨 부여.

    Gemini Flash로 sentence 단위 직접 분류. body는 key_points 개수만큼 body_1/body_2/.../body_N으로 세분화.
    Returns: 같은 sentences 리스트에 section 필드 추가된 사본.
    """
    if not sentences:
        return sentences
    s = structure or {}
    hook_text = (s.get("hook") or {}).get("text", "")
    intro_text = (s.get("intro") or {}).get("text", "")
    body_obj = s.get("body") or {}
    body_text = body_obj.get("text", "")
    cta_text = (s.get("cta") or {}).get("text", "")
    key_pts = body_obj.get("key_points") or []
    n_body_slots = len(key_pts) if key_pts else 0

    sent_lines = []
    for i, sent in enumerate(sentences, 1):
        sent_lines.append(f"  [{i}] [{sent.get('start',0):.1f}-{sent.get('end',0):.1f}s] \"{sent.get('text','')}\"")

    # body 세분화 라벨 + 가이드 블록
    if n_body_slots >= 2:
        body_labels = [f"body_{k}" for k in range(1, n_body_slots + 1)]
        body_section_def = (
            f"- **body_1 ~ body_{n_body_slots}**: 본문을 **시간 순서**로 {n_body_slots}개 토픽 chunk로 분할.\n"
            f"  ⭐⭐⭐ 시간상 먼저 등장하는 chunk = body_1, 다음 = body_2, ..., 마지막 = body_{n_body_slots}\n"
            f"  토픽이 바뀌는 경계점에서 body_N → body_(N+1) 전환.\n"
            f"  동일 chunk 내 인접 문장은 같은 body_N (한 chunk = 연속된 동일 토픽)"
        )
        body_kp_block = (
            f"\n## ⚠️ 절대 룰 — body_N은 **반드시 시간 순서**\n"
            f"- body 문장은 **연속된 시간 chunk**로만 그룹화 (시간상 떨어진 두 문장이 같은 body_N 되면 안 됨)\n"
            f"- body_1 = body 영역의 시작 부분, body_{n_body_slots} = body 영역의 끝 부분\n"
            f"- 각 body_N chunk 내부는 1개 이상의 인접 문장으로 구성\n"
            f"- 모든 body_1 ~ body_{n_body_slots} 라벨이 적어도 1번씩 사용되어야 함\n\n"
            f"## body 토픽 후보 (key_points — 순서 무관 참고용, 직접 매칭하지 말 것)\n"
        )
        for kp in key_pts:
            body_kp_block += f"- {kp}\n"
        body_kp_block += "\n⚠️ 위 key_points는 **순서 없는 후보 리스트**. body_1=key_point[0] 같은 직접 매칭 금지. ref body 흐름의 시간 순서가 우선.\n"
        body_label_list = " / ".join(body_labels)
        valid_set_str = "hook, intro, " + ", ".join(body_labels) + ", cta"
        body_example = '{"index": 5, "section": "body_1"}, {"index": 6, "section": "body_2"}, '
    else:
        body_section_def = "- **body**: 제품의 구체 기능·혜택·사용 흐름·시연. 가장 긴 섹션."
        body_kp_block = ""
        body_label_list = "body"
        valid_set_str = "hook, intro, body, cta"
        body_example = ""

    prompt = f"""당신은 광고 카피 분석가입니다. 각 문장을 정확히 어느 섹션({valid_set_str})에 속하는지 분류하세요.

## 섹션 정의
- **hook**: 시청자 시선을 잡는 첫 도입 (질문·충격·일반 진술). 보통 1-3 문장. 제품·솔루션 언급 X.
- **intro**: 제품·솔루션을 처음 도입. "오늘은 X 보여줄게" / 제품 재질·기능 도입. 보통 1-3 문장.
{body_section_def}
- **cta**: 행동 유도. "댓글에/링크에/저장하세요" 등.

## 분류 룰
- 시간 범위만 보지 말고 **문장 의미**를 보세요.
- 제품 기능·시연·디테일 = body (또는 body_N)
- 같은 토픽이 연속되면 같은 body_N
- 토픽이 바뀌는 순간 = body_N → body_(N+1) 경계
{body_kp_block}
## 참고 — script_structure 텍스트
- hook 원문: {hook_text[:200]}
- intro 원문: {intro_text[:200]}
- body 원문: {body_text[:300]}
- cta 원문: {cta_text[:200]}

## 분류할 문장
{chr(10).join(sent_lines)}

## 출력 JSON
{{
  "assignments": [
    {{"index": 1, "section": "hook"}},
    {{"index": 2, "section": "intro"}},
    {body_example}{{"index": N, "section": "cta"}}
  ]
}}
모든 {len(sentences)}개 문장 분류. body는 반드시 {body_label_list} 중 하나. JSON만.
"""
    valid_sections = {"hook", "intro", "cta"}
    if n_body_slots >= 2:
        for k in range(1, n_body_slots + 1):
            valid_sections.add(f"body_{k}")
    else:
        valid_sections.add("body")
    def _time_range_fallback() -> dict[int, str]:
        """Gemini 실패 시 structure의 hook/intro/body/cta 시간 범위로 분류.

        - hook/cta seconds가 빠져 있으면 다른 섹션 경계로 추정
        - body는 key_points 수만큼 균등 분할
        - sentences 끝까지 무라벨 안 남도록 마지막 범위 늘림
        """
        # 영상 끝 시각 추정 (문장 마지막 end)
        max_end = max((float(s.get("end", 0) or 0) for s in sentences), default=0.0)
        sec_ranges: dict[str, tuple[float, float]] = {}
        for k in ("hook", "intro", "body", "cta"):
            sec = (structure or {}).get(k) or {}
            r = _parse_section_seconds(sec.get("seconds"))
            if r:
                sec_ranges[k] = r
        if not sec_ranges:
            return {}

        # 누락된 hook/cta 추정
        intro_or_body_start = (sec_ranges.get("intro") or sec_ranges.get("body") or (0, 0))[0]
        if "hook" not in sec_ranges and intro_or_body_start > 0:
            sec_ranges["hook"] = (0.0, intro_or_body_start)
        body_or_intro_end = (sec_ranges.get("body") or sec_ranges.get("intro") or (0, 0))[1]
        if "cta" not in sec_ranges and max_end > body_or_intro_end:
            sec_ranges["cta"] = (body_or_intro_end, max_end + 0.01)
        # body 끝이 영상 길이를 초과하면 cap
        if "body" in sec_ranges:
            bs, be = sec_ranges["body"]
            if be > max_end + 1:
                sec_ranges["body"] = (bs, max_end + 0.01)

        ranges: list[tuple[float, float, str]] = []
        # body 분할
        if "body" in sec_ranges and n_body_slots >= 2:
            bs, be = sec_ranges["body"]
            span = (be - bs) / n_body_slots
            for k in range(n_body_slots):
                ranges.append((bs + k*span, bs + (k+1)*span, f"body_{k+1}"))
        for name in ("hook", "intro", "cta"):
            if name in sec_ranges:
                rs, re_ = sec_ranges[name]
                ranges.append((rs, re_, name))
        if "body" in sec_ranges and n_body_slots < 2:
            ranges.append((*sec_ranges["body"], "body"))

        out: dict[int, str] = {}
        for i, sent in enumerate(sentences, 1):
            st = float(sent.get("start", 0) or 0)
            en = float(sent.get("end", st) or st)
            mid = (st + en) / 2
            best_overlap = 0.0
            best_sec = ""
            for rs, re_, sec_name in ranges:
                ov = max(0.0, min(en, re_) - max(st, rs))
                if ov > best_overlap:
                    best_overlap = ov
                    best_sec = sec_name
            if not best_sec:
                # 가장 가까운 범위 (mid 기준)
                best_dist = float("inf")
                for rs, re_, sec_name in ranges:
                    if rs <= mid <= re_:
                        best_sec = sec_name; break
                    dist = min(abs(mid - rs), abs(mid - re_))
                    if dist < best_dist:
                        best_dist = dist; best_sec = sec_name
            if best_sec and best_sec in valid_sections:
                out[i] = best_sec
        return out

    idx_to_section: dict[int, str] = {}
    # Gemini 시도 (실패해도 fallback으로 이어짐)
    try:
        # 큰 문장 수에는 더 많은 토큰 (assignment 1개 ≈ 30 토큰)
        max_t = max(4096, len(sentences) * 60)
        result = call_gemini(prompt, model="gemini-3-flash-preview", max_tokens=max_t)
        if isinstance(result, list) and result:
            result = result[0]
        assignments = (result or {}).get("assignments") or []
        for a in assignments:
            try:
                idx = int(a.get("index", 0))
                sec = (a.get("section") or "").lower().strip()
                if sec in valid_sections and idx >= 1:
                    idx_to_section[idx] = sec
            except Exception:
                pass
    except Exception as e:
        logger.warning("Gemini classify failed (will fallback): %s", e)

    # ⚠️ Gemini 결과가 부족하면 (<30% sentences) 시간 범위 fallback
    if len(idx_to_section) < max(1, len(sentences) * 0.3):
        logger.warning("[classify] Gemini sparse (%d/%d) → 시간 범위 fallback",
                       len(idx_to_section), len(sentences))
        try:
            idx_to_section = _time_range_fallback()
        except Exception as e:
            logger.warning("time range fallback failed: %s", e)

    # apply
    out = []
    for i, sent in enumerate(sentences, 1):
        new_sent = dict(sent)
        if i in idx_to_section:
            new_sent["section"] = idx_to_section[i]
        out.append(new_sent)

    # ⭐ body_N 시간순 정규화
    if n_body_slots >= 2:
        body_items = [s for s in out if (s.get("section") or "").lower().startswith("body_")]
        if body_items:
            body_items.sort(key=lambda x: float(x.get("start", 0)))
            cur_label = body_items[0].get("section")
            cur_chunk = 1
            for s in body_items:
                if s.get("section") != cur_label:
                    cur_chunk += 1
                    cur_label = s.get("section")
                s["section"] = f"body_{cur_chunk}"
            logger.info("[classify] body_N relabeled to time-ordered (max=%d)", cur_chunk)
    return out


def _build_planner_prompt(product_name: str, pain: str, desire: str, usps: list[dict], primary: dict, target_persona: dict | None) -> str:
    """플래너용 prompt — 참고 분석 → 우리 광고의 문장 단위 outline 생성."""
    props = analyze_reference_proportions(primary)
    body_class = classify_body_structure(primary)
    hook_sents = props.get("hook_sents_all") or []
    intro_sents = props.get("intro_sents_all") or []
    cta_sents = props.get("cta_sents_all") or []
    body_slots = props.get("body_slots") or []

    # 참고의 모든 문장을 위치별로 나열
    ref_lines = []
    for j, s in enumerate(hook_sents, 1):
        ref_lines.append(f"  HOOK#{j} [{s.get('start',0):.1f}-{s.get('end',0):.1f}s] [역할={s.get('role')}] \"{s.get('text','')}\"")
    for j, s in enumerate(intro_sents, 1):
        ref_lines.append(f"  INTRO#{j} [{s.get('start',0):.1f}-{s.get('end',0):.1f}s] [역할={s.get('role')}] \"{s.get('text','')}\"")
    tts = primary.get("tts_script") or []
    for slot_idx, slot in enumerate(body_slots, 1):
        s_start, s_end = slot[0], slot[1]
        for t in tts:
            ts = _mmss_to_sec(t.get("start", 0))
            te = _mmss_to_sec(t.get("end", ts))
            if ts >= s_start - 0.3 and te <= s_end + 0.3:
                role = _classify_sentence_role(t.get("text", ""))
                ref_lines.append(f"  BODY-{slot_idx} [{ts:.1f}-{te:.1f}s] [역할={role}] \"{t.get('text','')}\"")
    for j, s in enumerate(cta_sents, 1):
        ref_lines.append(f"  CTA#{j} [{s.get('start',0):.1f}-{s.get('end',0):.1f}s] [역할={s.get('role')}] \"{s.get('text','')}\"")

    import random as _rnd
    usps_str = ""
    for i, u in enumerate(usps, 1):
        is_main = " ⭐MAIN" if i == 1 else ""
        usps_str += f"\nUSP{i}{is_main}: {u.get('usp','')}\n"
        if u.get("pain_solved"):
            usps_str += f"  pain: {u['pain_solved']}\n"
        revs = [r for r in (u.get("reviews") or []) if r.strip()]
        if revs:
            _rnd.shuffle(revs)  # 매 호출마다 셔플 — Planner가 다른 키워드 surface
            usps_str += "  reviews:\n"
            for r in revs[:8]:
                usps_str += f"    · {r[:120]}\n"

    persona_str = ""
    if target_persona:
        persona_str = f"\n타깃 페르소나: {target_persona.get('name','')}\n"
        persona_str += f"시나리오: {target_persona.get('scenario','')}\n"
        _dests_p = target_persona.get("destinations") or []
        if _dests_p:
            persona_str += f"여행지: {', '.join(_dests_p)}\n"
        if target_persona.get("signals"):
            persona_str += f"시그널: {', '.join(target_persona['signals'])}\n"

    # 참고 문장 수 계산 (위 ref_lines 기반)
    expected_count = len(ref_lines)

    return f"""당신은 광고 카피 플래너입니다. 참고 릴스의 **각 문장을 skeleton + slot_fills로 분해**해 우리 광고 outline 만드세요.

⚠️⚠️⚠️ **가장 중요한 규칙 — 문장 수 정확히 {expected_count}개** ⚠️⚠️⚠️
- 위에 보이는 참고 문장 = **{expected_count}개**
- 우리 outline의 sections.sentences 합계 = **정확히 {expected_count}개**
- 합치기·생략 절대 금지. 각 참고 문장에 1:1 대응 spec 출력.
- 출력 전 문장 수를 직접 세고 {expected_count}와 일치하는지 확인.

⚠️ **추가 규칙**
- 각 참고 문장의 **시그니처(끝 어구)는 skeleton에 그대로 박아넣기** (slot 아님)
- 각 문장의 [SLOT_NAME] 자리에 채울 단어는 **우리 USP/리뷰에서**
- 참고 문장의 [역할=X] 그대로 role 필드에 사용

## 참고 릴스 (실제 문장)
{chr(10).join(ref_lines)}

## 우리 제품
{product_name}
{persona_str}
(페르소나 시나리오에 페인·데지러 함의 — 별도 라벨 없이 시나리오로 일관 처리)

## 우리 USP
{usps_str}

## 핵심 작업 — Planner는 **위치+골격**만 잡음, **단어 선택은 Writer가 함**

### 작업 흐름
0. **⭐ Ref-USP 정렬**: 참고 각 문장 → 어떤 USP와 연결되는지 판단 → usp_id 부여
   - 상황·trigger·CTA 결과 어구 = main USP
   - 디자인 디테일 = 해당 sub USP
   - 일반 전환·마무리 = null
1. **Skeleton 추출**: 참고 문장에서 **고정부(시그니처·연결어·조사)는 그대로** 박고, 바뀔 자리만 [SLOT_NAME]으로 표시
2. **Signature 추출**: 끝 어구 (잖아요/거든요/보여줄게 등)를 signature 필드에 복사

### Ref-USP 정렬 예시 (여름 잠옷, USP1=⭐시원, USP2=빅사이즈, USP3=세탁, USP4=커플)
- "갑자기 나갈 일 생기면" → main 시나리오 → **usp_id=1**
- "3피스 잠옷 보여줄게" → 제품 도입 → **usp_id=null**
- "길이 조절 스트랩이니까" → 사이즈 → **usp_id=2**
- "바로 외출 gogo!" → main benefit → **usp_id=1**

### Skeleton 추출 예시
참고: "잘 때는 편한 게 최고잖아요"
→ skeleton: "잘 때는 [형용사] 게 최고잖아요"
→ signature: "최고잖아요"

참고: "후들후들 가볍고 쫀득한 모찌 같은 촉감이라"
→ skeleton: "[의태어] [형용사1]고 [형용사2] [비유] 같은 촉감이라"
→ signature: "촉감이라"

### Slot 이름 규칙 (의미적)
- [형용사] / [형용사어간] / [의태어] / [비유] / [부위] / [디자인특징] / [동작]
- ⚠️ Slot의 **실제 단어는 Writer가 채움** — Planner는 빈 [SLOT_NAME]만 출력

## 각 문장 spec 필드
- section: hook/intro/body_N/cta
- position: 섹션 내 순서
- role: 참고 [역할=X] 그대로
- topic: 우리 제품 맥락의 주제 (한 줄)
- syllables: 참고 음절 ±2
- ref_text: 참고 원문
- skeleton: [SLOT]이 박힌 골격 (단어 채우지 X)
- signature: skeleton 끝의 시그니처 어구
- usp_id: 메인=1, 서브=2.. (null=USP 무관)

## 출력 JSON
{{
  "duration_sec": <참고 길이>,
  "total_sentences": <전체 문장 수>,
  "sections": [
    {{
      "name": "hook",
      "sentence_count": N,
      "sentences": [
        {{
          "position": 1,
          "role": "spec",
          "topic": "...",
          "syllables": 13,
          "ref_text": "잘 때는 편한 게 최고잖아요",
          "skeleton": "잘 때는 [형용사] 게 최고잖아요",
          "signature": "최고잖아요",
          "usp_id": 1
        }}
      ]
    }},
    {{"name": "intro", ...}},
    {{"name": "body_1", "main_usp_id": 1, "sentence_count": N, "sentences": [...]}},
    ...
    {{"name": "cta", ...}}
  ]
}}

JSON만. 설명 금지.
"""


def _section_specific_guidance(section_name: str, has_destination: bool = False) -> str:
    """섹션 타입별 미러링 가이드 — 톤·종결 prescription 없음, 참고 그대로."""
    name = (section_name or "").lower()
    if name == "hook":
        dest_rule = (
            "- **Hook에 destination(여행지) 1번 무조건 등장** — \"해외/세계/외국\" 같은 일반어 금지\n"
            if has_destination else ""
        )
        return """## 🎣 HOOK 자유 Transform 모드 (첫 3초) ⭐

⚠️ Hook은 **skeleton 강제 X — 자유 재작성**. **단, ref Hook의 구조·말투를 그대로 미러링** (페인 강제 X).

### ⭐⭐⭐ 가장 중요 — ref Hook 구조를 그대로 따라감
- ref가 **"조건/도입 → 행동 명령"**이면 우리도 **조건+명령**으로
- ref가 **"상황 + 공감 질문"**이면 우리도 **상황+질문**으로
- ref가 **"숫자/일화 도입"**이면 우리도 **숫자/일화**로
- ref가 **pain 톤**이면 우리도 **pain**으로
- ⚠️ ref에 페인 없으면 **억지로 페인 깔지 말 것** — ref 톤 그대로

### ⭐⭐ Hook 의무 룰
""" + dest_rule + """- **플랫폼 맥락어 (릴스/피드/화면/영상/스크롤) ref 그대로 유지** — product 도메인으로 치환 X

### 보존 (필수)
- **어절 수 + 어절별 음절 패턴 강제** (각 ±2 자 허용)
- **role은 ref에서 분류된 그대로** — pain·transition·spec·cta 모두 OK
- **종결 형태**(질문/명령/평서)는 ref 그대로

### 자유롭게
- skeleton·[SLOT] 골격 안 따라도 됨 — 단어·동사 자유 변형
- 우리 도메인 단어로 치환 (USP/페르소나/여행지)

### 예시 — ref 미러링
- ref: "일본 여행 가기 전에 당신의 피드에 이 릴스가 떴다면 / 지금 바로 저장하고 친구한테 공유해" (조건+명령)
  → 우리: "다낭 호텔 예약 전에 당신의 피드에 이 릴스가 떴다면 / 지금 바로 저장하고 친구한테 공유해" (조건+명령 미러, 릴스 보존)
- ref: "한 여름에 자다가 / 땀 때문에 찝찝해서 / 잠 깰 때 있지?" (pain+질문)
  → 우리: "여행 갈 때마다 / 호텔 비교 어려워서 / 가격 헷갈릴 때 있지?" (pain+질문 미러)

### 절대 금지
- ref가 명령형인데 우리가 pain 질문으로 바꿈 ❌
- ref가 도입형인데 우리가 pain 트리거 강제 ❌
- 마케팅 톤 ("최고잖아요/딱이죠")
- 도메인 충돌 비유 ("촉감/모찌/실크" 같은 잠옷 어휘를 여행앱에 박기)
"""
    if name == "intro":
        return """## 🚪 INTRO 자유 Transform 모드 ⭐ — ref 톤 미러링 + main USP 키워드 포함

⚠️ Intro는 **skeleton 강제 X — 자유 재작성**. 단, **ref Intro의 톤·구조·역할 그대로 미러링** (pain 강제 X).
⚠️ **각 Intro 문장에 main USP 핵심 키워드 1개 이상 자연스럽게 포함 필수**.

### ⭐⭐⭐ 가장 중요 — ref Intro 톤을 그대로 따라감
- ref가 **"자랑/강조"** ("~거든요", "~코드", "DM 폭주") → 우리도 **자랑/강조**
- ref가 **"제품 도입/소개"** ("~보여줄게", "~어플이야") → 우리도 **소개**
- ref가 **"pain 깔기"** ("~귀찮잖아", "~답답하지?") → 우리도 **pain**
- ref가 **"수치/근거"** ("3년 동안", "200만 다운") → 우리도 **수치**
- ⚠️ ref에 페인 없으면 **억지로 페인 깔지 말 것** — ref 톤 그대로

### 보존 (필수)
- **어절 수 + 어절별 음절 패턴 강제** (각 ±2 자 허용)
- **role은 ref에서 분류된 그대로** — pain·transition·spec·benefit 모두 OK
- **종결 형태**(평서/감탄/자랑) ref 그대로
- **main USP 키워드 매 문장 1개 이상**

### ⚠️ 비유·메타포 처리
ref Intro의 물리·감각 비유 ("모찌 같은")가 우리 도메인과 안 맞으면:
- ❌ 단어만 바꿔 미러 X ("주식 같은 가격")
- ✅ 비유 빼고 **제품 기능 직접 묘사**

### 예시 — ref 미러링
- ref: "여행 경비를 반이나 아껴줄 거거든." (자랑형, ~거든)
  → 우리: "**숙소값**을 반이나 아껴줄 거거든." (자랑 그대로 미러, main USP 키워드 포함)
- ref: "DM 폭주했던 일본 후보 할인 코드." (강조 명사구)
  → 우리: "DM 폭주했던 **다낭 숙소 가격 알람**." (강조 명사구 미러)
- ❌ "혹시 숙소값 손해볼 걱정에 찝찝해요?" (ref가 자랑인데 pain 질문 — ref 톤 위반)

### 절대 금지
- ref가 자랑/강조인데 우리가 pain 질문으로 바꿈 ❌
- main USP 키워드 누락된 문장
- 도메인 충돌 비유 (ref 비유를 단어 바꿔 강제 미러)
"""
    if name.startswith("body"):
        return """## 💪 BODY 자유 Transform 모드 (USP 분절) ⭐

⚠️ Body도 **skeleton 강제 X — USP 의미를 자연스러운 한국어로 풀기**. 단, 시그니처·문장 수·길이는 보존.

### ⚠️⚠️⚠️ 명사 어휘 화이트리스트 — 가장 빈번한 실수 차단
**Body의 모든 핵심 명사는 반드시 다음 source 중 하나에서만 가져옴:**
1. spec_block의 **해당 spec의 usp_id에 매핑된 USP description** (문제/해결/혜택)
2. **그 USP의 사용자 리뷰 텍스트**
3. **타깃 페르소나 signals + 여행지명**
4. spec_block의 **slot_topic** (Section Planner가 추출)

⚠️ **위 source에 없는 명사는 절대 출력하지 말 것** — ref 원문에 있는 단어라도 우리 USP source에 없으면 금지.

### ⭐ 플랫폼 맥락어는 ref 그대로 유지 (예외)
릴스/피드/화면/스크롤/영상/이미지/저장/공유/팔로우/댓글/DM/링크 같은 **Instagram(시청자가 지금 스크롤 중인 플랫폼) 맥락어**는 product 도메인 치환 금지. 그대로 유지.
- ✅ ref "당신의 피드에 이 **릴스**가 떴다면" → 우리 "당신의 피드에 이 **릴스**가 떴다면" (릴스 그대로)
- ❌ ref "당신의 피드" → 우리 "**여행앱 피드**" (피드는 Instagram 맥락 → 치환 금지)
- ❌ ref "이 릴스" → 우리 "이 그래프" (릴스도 platform 맥락 → 그대로 유지하고, 그래프는 다른 자리에)
- 룰 정리: 시청자가 "지금 이 화면(인스타)을 보고 있다"는 맥락어는 ref 그대로

### ❌ 자주 나오는 실패 케이스
- ref가 **음식/맛집/식당/카페/마사지/쇼핑/면세** 어휘를 쓸 때 우리 광고가 다른 도메인이면:
  - ❌ 잘못: ref "맛집 할인 쿠폰" → 우리 "맛집 제휴 / 식당 할인" (맛집·식당이 우리 USP에 없으면 금지)
  - ❌ 잘못: ref "이 사이트 들어가면 클룩 쿠폰" → 우리 "앱 들어가면 맛집 제휴" (맛집은 우리 USP 무관)
  - ✅ 정답: USP가 "숙소 가격 추적"이면 → "앱 들어가면 호텔 가격 그래프" / "앱 들어가면 30일 변동 차트"
  - ✅ 정답: USP가 "가격 알람"이면 → "앱 들어가면 목표가 알람 설정"

### 룰
- spec의 `usp_id`에 매핑된 USP의 description·리뷰만 명사 source
- ref의 도메인 명사 (맛집/식당/쇼핑몰/카페/제휴/쿠폰 등)는 우리 USP source에 명시 없으면 **무조건 USP source 명사로 치환**
- USP 도메인 단어가 부족하면 → 추상 명사 (혜택/기능/포인트) 사용 가능
- 절대 ref 원문 도메인 명사 차용 X (slot_topic 명시 케이스 외)

### 보존 (필수)
- **참고 분절 문장 수와 동일** (N문장이면 우리도 N문장)
- **각 문장 어절 수 + 어절별 음절 패턴 강제** (각 ±1 자 허용)
- **각 문장 어절 수** ±1 이내
- **분절 간 전환** 참고 패턴 따라 (참고가 "그리고"로 시작하면 우리도 그렇게)
- **각 spec의 usp_id에 맞는 USP 어휘만** — 다른 USP 어휘 침입 금지
- **⭐ 평가형 어구 보존** — ref의 "중요한/핵심/제일 좋은/마지막" 같은 추상명사 앞 평가어는 **그대로 유지**

### 종결어미 (강제 X)
- ref 종결어미는 참고용. **자연스러운 종결로 자유롭게 결정**

### 자유롭게
- skeleton의 [SLOT] 골격 안 따라도 OK
- 동사·구문 자유 변형 (ref 구문 못 따라도 의미만 같으면 OK)
- USP 리뷰의 vivid 표현·일화를 직접 사용
- 예: ref "안쪽은 모달까지 넣어 / 완전니 부드럽잖아" → "겉면은 실크 / 진짜 매끈하잖아" (자유, 의미 + "잖아" 시그니처 보존)

### 추상명사+형용사 매칭 룰 (⚠️ 핵심)
- **추상명사**(포인트/순간/이유/장점/매력/팁) 앞에는 **평가형 형용사**(중요한/좋은/핵심/대단한/특별한)
- ❌ 잘못: "제일 시원한 포인트" (시원한=물리감각, 포인트=추상명사 — mismatch)
- ✅ 정답: "제일 중요한 포인트" (ref 그대로 유지)
- ❌ 잘못: "찰랑한 매력" / "쿨링 이유"
- ✅ 정답: "은은한 매력" / "확실한 이유"

### 절대 금지
- 시그니처 변형
- 다른 분절 USP 어휘 침입
- 가짜 인과 어미로 두 USP 묶기
- 단어 → 명사구 확장 (예: "편한" → "편안한 활동성" ❌)
- 잠옷 광고에 "야외/등산" 같은 도메인 부정합
- 추상명사 앞 형용사를 USP 키워드로 치환 (위 룰 참조)
"""
    if name == "cta":
        return """## 📢 CTA 자유 Transform 모드 ⭐ — 도메인 적합 단어로 자유 재작성

⚠️ CTA도 **skeleton fixed text를 우리 도메인에 안 맞으면 변형 OK**.

### ⭐ usp_id가 null인 spec — 페르소나 + ref 톤 미러링
spec_block의 usp_id가 비어있는(null) CTA 문장은:
- **특정 USP에 묶지 말 것** — usp_block에 없으면 USP 어휘 도입 X
- **페르소나의 signals + scenario + tone_hint를 명사·동작 source로 사용**
- **ref 문장의 톤·구조·종결을 그대로 미러링** ("이 모든 ~ / 한 번에 / 받고 싶다면" 같은 통합 호소 패턴은 그대로)
- ref가 generic 행동 (팔로우/저장/댓글/DM/링크)을 쓰면 우리도 그대로 — 플랫폼 맥락어니까 도메인 치환 X
- 예: ref "이 모든 정보를 한 번에 받고 싶다면 / 팔로우하고 댓글에 일본 쿠폰 남겨줘 / DM으로 쏴줄게"
  → 우리(페르소나=임산부 잠옷): "이 모든 정보를 한 번에 받고 싶다면 / 팔로우하고 댓글에 임산부 잠옷 남겨줘 / DM으로 쏴줄게"
  (구조·종결·플랫폼 어휘 보존 + 페르소나 signal "임산부"만 치환)

### 보존 (필수)
- **어절 수 + 어절별 음절 패턴 강제** (각 ±2 자 허용)
- **CTA 패턴 구조** (행동 유도·마무리 흐름)
- 종결어미 강제 X — 자연스러운 종결로 자유 결정

### 도메인 mismatch 단어 변형 (⚠️ 핵심)
ref의 [SLOT] 외 fixed text 중 우리 제품 도메인과 안 맞는 단어는 **자유 변형**:
- ❌ ref "잘 때 [부위]도 안 불편" → 앱 광고에 "잘 때 눈도 안 불편" (앱은 "잘 때" 무관)
  - ✅ "사용할 때 [어디서]도 안 불편" / "비교할 때 헷갈림 없이"
- ❌ ref "노브라 [제품] 최고예요" → 앱에 "땡처리 잠옷 최고예요" ("잠옷" 그대로 박힘)
  - ✅ "정말 편한 가성비 멤버십 최고예요" (잠옷·노브라 도메인어 제거)

### 자유롭게
- skeleton fixed text 통째로 변경 가능
- 같은 emotion/intensity·CTA 흐름만 유지

### 절대 금지
- ref 도메인 특정 단어 그대로 박기 ("잠옷", "잘 때", "꿀잠" 같이 우리 도메인과 안 맞는 단어)
- 새 CTA 패턴 (예약·구독·다운로드 등 ref에 없는 패턴 금지)
- usp_id가 null인 spec에 USP 어휘를 억지로 끼워넣기
"""
    return ""


def _eojeol_syllable_pattern(text: str) -> list[int]:
    """어절별 한글 음절수 리스트 반환.
    예: "잘 때는 편한 게 최고잖아요" → [3, 2, 1, 5]
    """
    if not text:
        return []
    return [_count_kor_syllables(w) for w in text.split() if w.strip()]


def _parse_usp_description(desc: str) -> dict[str, str]:
    """USP description을 문제/해결/혜택 3단으로 파싱.
    "문제: X\n해결: Y\n혜택: Z" 패턴 인식. 패턴 없으면 raw에 통째로.
    """
    if not desc or not desc.strip():
        return {"raw": "", "문제": "", "해결": "", "혜택": ""}
    import re as _re
    out = {"raw": desc.strip(), "문제": "", "해결": "", "혜택": ""}
    # 라인 단위 또는 마커 단위 파싱
    pattern = _re.compile(r"(문제|해결|혜택|기능|효과)\s*[:：]\s*(.+?)(?=\n\s*(?:문제|해결|혜택|기능|효과)\s*[:：]|\Z)", _re.S)
    for m in pattern.finditer(desc):
        key = m.group(1).strip()
        val = m.group(2).strip()
        # alias 매핑
        if key == "기능":
            out["해결"] = val
        elif key == "효과":
            out["혜택"] = val
        else:
            out[key] = val
    return out


def _extract_main_usp_keywords(usps: list[dict], target_persona: dict | None) -> list[str]:
    """main USP의 핵심 키워드 추출 — Writer/Refine에서 강제 포함용."""
    kws: list[str] = []
    # 1) persona signals 우선 (가장 구체적)
    if target_persona and target_persona.get("signals"):
        kws.extend([s for s in target_persona["signals"] if s and len(s) <= 6][:5])
    # 2) main USP text 분해
    if usps:
        main_txt = usps[0].get("usp", "")
        import re as _re
        for w in _re.split(r"[\s/,·:()·\-—]+", main_txt):
            w = w.strip()
            if w and 2 <= len(w) <= 6 and w not in kws:
                kws.append(w)
    return kws[:6]


def _detect_speech_level(texts: list[str]) -> str:
    """ref 텍스트들의 dominant 어투 감지 — '반말' / '존댓말' / '혼합'.
    존댓말 시그니처: ~요/~예요/~세요/~입니다/~죠/~네요/~거든요/~잖아요/~려고요
    반말 시그니처: ~다/~지/~어/~야/~해/~잖아/~거든/~네/~지?/~려고/명령형(~해/~봐/~줘)
    """
    import re as _re
    polite_pat = _re.compile(r"(요|예요|세요|입니다|죠|네요|거든요|잖아요|려고요|어요|아요|에요|이에요)\s*[.\?!~]?\s*$")
    plain_pat = _re.compile(r"(거든|잖아|려고|는데|는다|한다|이다|어\b|아\b|야\b|지\b|해\b|봐\b|줘\b|네\b|구나)\s*[.\?!~]?\s*$")
    polite = 0
    plain = 0
    for t in texts:
        t = (t or "").strip()
        if not t:
            continue
        if polite_pat.search(t):
            polite += 1
        elif plain_pat.search(t):
            plain += 1
    if polite == 0 and plain == 0:
        return "혼합"
    if polite >= plain * 2:
        return "존댓말"
    if plain >= polite * 2:
        return "반말"
    return "혼합"


def _build_section_writer_prompt(section: dict, product_name: str, target_persona: dict | None, usps: list[dict], pain: str, desire: str, speech_level: str = "혼합") -> str:
    """섹션별 작성자 prompt — outline 받아 문장 N개 작성. 섹션 타입별 가이드 추가."""
    section_name = section.get("name", "")
    sentences_spec = section.get("sentences") or []
    main_usp_id = section.get("main_usp_id")

    # 어떤 USP가 사용되는지 — 해당 USP 정보만 컴팩트하게
    usp_ids_in_section = set()
    for s in sentences_spec:
        if s.get("usp_id"):
            usp_ids_in_section.add(s["usp_id"])
    if main_usp_id:
        usp_ids_in_section.add(main_usp_id)
    relevant_usps = []
    for uid in sorted(usp_ids_in_section):
        if 1 <= uid <= len(usps):
            relevant_usps.append((uid, usps[uid - 1]))

    import random as _rnd
    usps_block = ""
    for uid, u in relevant_usps:
        usps_block += f"\nUSP{uid}: {u.get('usp','')}\n"
        desc_parsed = _parse_usp_description(u.get("description") or "")
        if desc_parsed["문제"]:
            usps_block += f"  📌 문제 (role=pain용): {desc_parsed['문제'][:200]}\n"
        if desc_parsed["해결"]:
            usps_block += f"  🛠 해결/기능 (role=spec용): {desc_parsed['해결'][:200]}\n"
        if desc_parsed["혜택"]:
            usps_block += f"  ✨ 혜택 (role=benefit용): {desc_parsed['혜택'][:200]}\n"
        if not (desc_parsed["문제"] or desc_parsed["해결"] or desc_parsed["혜택"]) and desc_parsed["raw"]:
            usps_block += f"  설명: {desc_parsed['raw'][:300]}\n"
        revs = [r for r in (u.get("reviews") or []) if r.strip()]
        if revs:
            _rnd.shuffle(revs)
            usps_block += "  사용 가능 리뷰 (vivid 표현·proof 영감):\n"
            for r in revs[:8]:
                usps_block += f"    · {r[:120]}\n"

    # slot 그룹핑 — slot-mate specs를 시각적으로 묶음
    from itertools import groupby as _gby
    spec_block = ""
    # slot_id별 그룹화 (순서 유지)
    grouped: list[tuple[int | None, list[dict]]] = []
    current_slot = object()
    current_group: list[dict] = []
    for s in sentences_spec:
        sid = s.get("slot_id")
        if sid != current_slot:
            if current_group:
                grouped.append((current_slot, current_group))
            current_slot = sid
            current_group = [s]
        else:
            current_group.append(s)
    if current_group:
        grouped.append((current_slot, current_group))

    for slot_id, group in grouped:
        slot_topic = group[0].get("slot_topic", "") if group else ""
        if slot_id is not None and len(group) > 1:
            spec_block += f"\n━━━ slot {slot_id} ({len(group)}문장) — 같은 토픽 공유 ━━━"
            if slot_topic:
                spec_block += f"  slot_topic_ref=\"{slot_topic}\" ⭐ 우리 제품에서 동일 명사 1개 정해서 {len(group)}문장 모두에 사용\n"
            else:
                spec_block += "\n"
        for s in group:
            usp_tag = f" [USP{s.get('usp_id')}]" if s.get("usp_id") else ""
            slot_tag = f" slot={slot_id}" if slot_id is not None else ""
            ref_text = s.get("ref_text", "")
            ref_syl = _count_kor_syllables(ref_text) if ref_text else (s.get('syllables', 10))
            ref_eojeol_pattern = _eojeol_syllable_pattern(ref_text)
            ref_eojeol_n = len(ref_eojeol_pattern)
            spec_block += f"\n  문장 {s['position']}{usp_tag}{slot_tag}\n"
            spec_block += f"    역할: {s.get('role','')}\n"
            spec_block += f"    토픽: {s.get('topic','')}\n"
            spec_block += f"    음절 합계: {ref_syl}\n"
            if ref_eojeol_pattern:
                pattern_str = "-".join(str(p) for p in ref_eojeol_pattern)
                spec_block += f"    ⭐ 어절 수: {ref_eojeol_n}개 (강제) / 어절별 음절 패턴: {pattern_str} (각 ±2 허용)\n"
            spec_block += f"    참고: \"{s.get('ref_text','')}\"\n"
        # skeleton + signature 모두 표시 X — 자유 transform 모드 (Hook/Intro/Body/CTA 모두)
        # Writer는 ref_text + role + slot_topic + 페르소나 + USP description으로 자유 작성

    persona_str = ""
    if target_persona:
        persona_str = f"타깃: {target_persona.get('name','')} ({target_persona.get('scenario','')})\n"
        _dests = target_persona.get("destinations") or []
        if _dests:
            chosen_dest = _dests[0]  # _generate_multistep에서 이미 1개로 선택됨
            persona_str += f"""
⭐ **이 대본의 여행지 = "{chosen_dest}"** ⭐

⚠️ 반복 방지 룰 — **각 섹션마다 도메인 키워드 딱 1번**:
- **다른 장소 (푸꾸옥/나트랑/다낭/보라카이) 절대 X**
- **"{chosen_dest}"는 Hook에서 1번만** (맥락 셋업)
- **각 body 섹션 내에서 도메인 핵심명사("{chosen_dest}", "호텔", "숙소") 통틀어 1번만 등장**
  - body_1 첫 문장에 "호텔" 1번 → body_1의 다른 문장은 도메인 명사 생략 (기능명/대명사만)
  - body_2 첫 문장에 "{chosen_dest}" 또는 "호텔" 1번 → 나머지는 생략
  - body_3 첫 문장에 1번 → 나머지는 생략
- Hook이 맥락 깔아주니까 뒷 문장에서 명사 통째로 빼도 의미 통함

### ✅ 좋은 예 (각 섹션 1번)
- Hook: "**{chosen_dest} 호텔** 예약 전에 당신의 화면에 이 영상이 떴다면" ({chosen_dest}+호텔 1회 — 맥락 셋업)
- Hook 2: "지금 당장 확인하고 친구한테 알려줘" (생략)
- Intro: "비싼 **숙소값** 새는 거 막아줄 거거든" (숙소 1회)
- Body_1 문장1: "예약 폭주했던 **호텔 가격 알람**" (호텔 1회)
- Body_1 문장2: "매일 가격 바뀌는 거 알지?" (생략 — 알람 맥락 이미 깔림)
- Body_1 문장3: "여기 알람 설정하고 새로고침은 말자" (생략)
- Body_2 문장1: "여행 가면 **특가** 잡아야 되잖아" (특가 1회)
- Body_2 문장2-3: 생략
- Body_3 문장1: "**가격 그래프** 한눈에 비교" (그래프 1회)
- Body_3 문장2-3: 생략

### ❌ 나쁜 예 (반복 지루)
- "{chosen_dest} 숙소 매일 비싸" · "{chosen_dest} 호텔 가격 그래프" · "{chosen_dest} 숙소 알람" — 매 문장 도메인 명사 박힘 → 지루
"""

    has_dest = bool((target_persona or {}).get("destinations"))
    section_guidance = _section_specific_guidance(section_name, has_destination=has_dest)
    _sn = section_name.lower()
    is_free = _sn in ("hook", "intro", "cta") or _sn.startswith("body")

    # Hook은 skeleton 강제 우회 — section_guidance에 자유 transform 룰 명시됨
    skeleton_mode_block = "" if is_free else """

## 작성 방식 — Skeleton 조립 + Slot Fill (당신이 단어 선택)"""

    # Intro 섹션 한정 — main USP 키워드 명시 (사용자가 입력한 main USP 텍스트 + 페르소나 시그널)
    main_kw_block = ""
    if _sn == "intro":
        main_kws = _extract_main_usp_keywords(usps, target_persona)
        main_usp_text = (usps[0].get("usp", "") if usps else "")
        if main_kws or main_usp_text:
            kw_str = ", ".join(f'"{k}"' for k in main_kws[:6])
            main_kw_block = f"""
## ⭐⭐ Intro 한정 — Main USP 키워드 강제 ⭐⭐
- main USP: "{main_usp_text}"
- 핵심 키워드: {kw_str}
- **각 Intro 문장 출력에 위 키워드 중 1개 이상 자연스럽게 포함 필수** (음절·어절 보존하면서)
- 예: main USP="숙소 알람" → 모든 Intro 문장에 "알람/알림/숙소/푸쉬" 중 1개 등장
"""

    # 어투 강제 블록
    speech_block = ""
    if speech_level == "반말":
        speech_block = """
## 🗣 어투 강제 — **반말** (⭐⭐⭐)
- ref가 반말 톤 → 우리도 **반말**
- ✅ 허용: "~해", "~지", "~잖아", "~거든", "~야", "~네", "~어", "~다", "~지?", "~려고"
- ❌ 금지: "~요", "~예요", "~세요", "~죠", "~네요", "~거든요", "~잖아요", "~려고요", "~어요", "~아요"
- 명령형: "~해", "~봐", "~줘" (✅) / "~하세요", "~봐요", "~주세요" (❌)
- 질문형: "~지?", "~잖아?" (✅) / "~죠?", "~잖아요?" (❌)
"""
    elif speech_level == "존댓말":
        speech_block = """
## 🗣 어투 강제 — **존댓말** (⭐⭐⭐)
- ref가 존댓말 톤 → 우리도 **존댓말**
- ✅ 허용: "~요", "~예요", "~세요", "~죠", "~네요", "~거든요", "~잖아요", "~어요", "~아요"
- ❌ 금지: "~해", "~지", "~잖아", "~거든", "~야", "~다", "~지?" (반말)
- 명령형: "~하세요", "~봐요", "~주세요" (✅) / "~해", "~봐", "~줘" (❌)
"""
    else:
        speech_block = """
## 🗣 어투 강제 — **ref 각 문장 그대로**
- 각 ref 문장의 어투(반말/존댓말) **그대로 미러링**
- ref가 "~잖아"면 우리도 반말 종결, ref가 "~잖아요"면 존댓말
"""

    return f"""당신은 한국어 광고 카피라이터입니다. 아래 outline에 따라 **{section_name} 섹션의 문장 {len(sentences_spec)}개**만 작성.

⚠️⚠️ **direction 필드는 TTS 연기 cue 한 줄 (6자 이내)** ⚠️⚠️
- ✅ 허용: "자연스럽게", "친근하게 묻듯", "확신에 차서", "공감하듯", "장난스럽게", "단호하게", "속삭이듯"
- ❌ 절대 금지: 마케팅 지시문 ("X를 강조하여 공감을 유도하세요", "USP를 부각시키고...", "도입부를 작성하세요" 등)
- ❌ 절대 금지: 광고 전략 설명, 작성 방법 지시
direction은 **성우가 어떻게 읽을지**만. 마케팅 전략 X.

{speech_block}
{section_guidance}
{main_kw_block}
{skeleton_mode_block}

## 🔢 숫자 구체성 (⭐⭐ ref에 숫자 있으면 미러링 권장)

### 룰 1 — ref에 숫자 있으면 우리도 숫자 (강제에 가까운 권장)
ref 문장에 **숫자(%, 만원, 일, 번, 분, 시간, kg, cm 등)**가 있으면:
- 우리 출력도 **같은 자리에 숫자** 사용 — USP description / 리뷰의 실제 수치 차용
- ❌ 잘못: ref "기본 면세 **10%**에 추가 할인까지 되는 쿠폰들" → 우리 "과거 내역 싹 모아 가격까지 알려 주잖아" (숫자 누락)
- ✅ 정답: → "지난 **30일** 최저가에 추가 알람까지 받는 어플이라" / "최근 **6개월** 가격에 추가 알림까지 보내주잖아"
- 숫자가 USP description·리뷰에 없으면 → **합리적 추정치** OK (단, 과장 금지)

### 룰 2 — ref에 숫자 없으면 (선택)
- 굳이 안 넣어도 됨 — ref 톤 미러링 우선
- 단, **Pain 빈도 / Proof 시나리오 / Benefit 비교 / 여행지+가격**에 자연스러운 자리면 끼워도 OK

### ❌ 숫자 끼우지 말 것
- **Hook 도입/조건/명령** ("일본 여행 가기 전에..." 같이 숫자 자체가 어색한 자리)
- **자랑형 명사구** ("DM 폭주했던 할인 코드" 같이 숫자 빼고 더 강한 자리)
- **추상 CTA** ("지금 바로 저장해")
- 숫자 끼우려고 어절 패턴 깨질 때

### 출처
- 숫자는 **USP description · 리뷰 · persona signals**에서 차용
- 가짜 숫자·과장 숫자 X (브랜드 신뢰 깨짐)

## 🔗 문장 종결 형태 보존 (⭐⭐⭐ 매우 중요)
ref 각 spec의 ref_text 끝 어미를 보고 **종결인지 연결인지** 정확히 미러링.

### 종결 vs 연결 — 끝나면 마침표·물음표·느낌표, 안 끝나면 마침표 없이 연결
- **종결 어미 (다음 문장과 분리)**: ~다 / ~요 / ~지 / ~까? / ~네 / ~어 / ~네요 / ~잖아 / ~거든 / ~봐 / ~줘 등
- **연결 어미 (다음 문장과 한 호흡)**: ~면 / ~서 / ~고 / ~데 / ~며 / ~지만 / ~니까 / ~려고 / ~다가 등

### 룰
- ref spec의 ref_text가 **연결 어미**로 끝나면 → 우리 출력도 **연결 어미** 유지 (마침표 X)
- ref spec의 ref_text가 **종결 어미**로 끝나면 → 우리도 **종결 어미** + 마침표·?·!
- ⚠️ 연결 → 종결로 임의 변환 금지 — 연결되어야 할 두 spec이 분리되면 의미 흐름 깨짐

### 예시
- ref spec1 = "잠옷을 **입으면**" (연결) / spec2 = "집중하게 **돼요**." (종결)
  → ref의 1문장 = spec1 + spec2 합쳐서 1문장
  - ✅ 우리 spec1 = "잠옷을 **입으면**" (연결, 마침표 X) / spec2 = "집중하게 **돼요**." (종결)
  - ❌ 우리 spec1 = "잠옷을 **입어요**." (연결을 종결로 바꿔서 분리) / spec2 = "안 답답해서 **좋아요**." (별개 문장)

### 어절 패턴 충돌 시
- ref spec의 마지막 어절이 "입으면"(3음절)이면 우리도 3음절 ±2 + **연결 어미** 유지 (예: "신으면" / "쓰면" / "입으면")
- 어절 강제와 종결 형태 강제가 둘 다 충족돼야 함

## 📐 ref 의미 구조 보존 (⭐⭐⭐⭐ 가장 빈번한 위반)

### 룰 0 — ref [N] 핵심 정보 추출 → 우리 [N]에 반드시 보존 ⭐⭐⭐⭐⭐
**작성 전 ref_text를 읽고 다음 정보를 마음속으로 추출:**
1. **숫자/수치** (가격·%·개수·시간 등)
2. **명사 entity** (제품·서비스·장소·앱 이름 등)
3. **비교 대상** ("A에서 X / B에서 Y" 같은 두 주어)
4. **새 케이스/시나리오** ("심지어~", "또~", "그리고~" 같은 추가 케이스 도입 신호)
5. **종결 형태** (체언 종결 / 동사 종결 / 연결 어미)

**우리 [N] 출력 전 자가 점검: 위 5개 정보가 모두 보존됐는가?**
- ref [N]에 숫자 있는데 우리 [N]에 숫자 없음 = 위반
- ref [N]이 비교 (A vs B) 인데 우리 [N]이 단일 entity = 위반
- ref [N]이 새 케이스 도입인데 우리 [N]이 이전 메시지 반복 = 위반

### 룰 1 — ref text의 **의미 구조 그대로 미러링** (메타 코멘트 추가 금지)
- ref가 "단순 가격 나열" 형식이면 → 우리도 단순 가격 나열
- ref가 "사실 진술 → 결과 진술"이면 → 우리도 사실+결과 그대로
- ref가 시청자에게 **추론 여지**를 남기는 미니멀 형식이면 → 우리도 그 미니멀함 유지
- ⛔ ref에 **없는** 메시지(메타 코멘트, 비교 결론, 부연 설명) **절대 추가 금지**

### ❌ 자주 나오는 위반
- ref [N] = "네이버 항공권에서는 62만원" / ref [N+1] = "이곳에서는 37만원입니다." (단순 가격 나열, 비교 결론은 시청자가 추론)
  - ❌ 우리: "가격이 10만원이나 달라요" + "이곳은 20만원이죠" + "10만원 더 저렴해요" (3문장 — ref엔 없는 비교 메타 코멘트 + 결론 추가)
  - ✅ 우리: "네이버에서는 62만원" + "C멤버십에서는 37만원입니다" (2문장 — ref 그대로, 비교 결론은 시청자가 알아서 추론)

### 룰 2 — ref 문장 수 = 우리 문장 수 (정확히 1:1)
- ref가 N 문장이면 우리도 정확히 **N 문장** — 합치기·쪼개기·추가 절대 금지
- ref [idx]의 의미를 우리 [idx]가 그대로 미러링 (위치 매칭)
- ref에 없는 "결론/요약/메타 코멘트" 문장 추가 = 위반

### ❌ 자주 나오는 위반 — 문장 추가
- ref 3문장: 조건 / 가격 A / 가격 B
- ❌ 우리 4문장: 조건 / **메타 (다르다)** / 가격 A / **결론 (저렴)** — 메타·결론 2문장 추가
- ✅ 우리 3문장: 조건 / 가격 A / 가격 B (1:1 매칭)

### ⭐ 자가 점검
출력 전 ref와 우리를 줄줄이 비교:
- ref 1번 = 우리 1번? (의미·역할 일치)
- ref 2번 = 우리 2번?
- ref 3번 = 우리 3번?
- ref에 없는 의미가 우리 출력에 추가됐는지?

## 🧩 의미 호응 검증 (⭐⭐⭐ 어절 강제 다음으로 중요)
어절 수·음절·시그니처 다 맞아도 **수식어-명사 조합이 의미적으로 어색하면 실패**.

### 룰: 수식어가 핵심 명사를 자연스럽게 수식해야 함
ref의 **"X했던 Y"** / **"X하는 Y"** / **"X 없는 Y"** 같은 패턴 미러링 시:
- X(동사·동작·상태)와 Y(핵심 명사)의 **의미 결합이 자연스러운지** 반드시 확인
- ref의 X가 우리 도메인에 안 맞으면 X 자체를 새로 골라야 함 (단어만 바꾸지 X)

### 자가 점검 — 출력 전 마음속으로 읽어보기
한국어 모어 화자가 들었을 때 "어색하다"는 느낌이 들면 → 수식어 다시 고름

### ❌ 어색한 결합 (의미 호응 실패) — 자주 나오는 실수
- **❌ "특가 예약했던 도쿄 숙소 가격 푸시"**
  - "특가 예약하다"는 사람·숙소가 주체인데 "푸시"(알림 시스템)와 결합 X
  - ✅ 정답: "예약 폭주했던 도쿄 숙소 가격 알람" / "다들 기다렸던 도쿄 숙소 가격 푸시" / "DM 폭주했던 도쿄 숙소 가격 알람"
- **❌ "비싼 숙소값 손해를 막아줄"**
  - "숙소값 손해"가 stiff (손해는 추상명사라 결합 어색)
  - ✅ 정답: "비싼 숙소값 새는 거 막아줄" / "도쿄 숙소 호구 잡힘 막아줄" / "도쿄 숙소값 30% 아껴줄"
- **❌ "맛집 제휴 통합 사이트"** (도메인 무관 + 의미 결합)
  - "맛집"과 "제휴"가 우리 USP와 무관, "통합 사이트"가 추상
  - ✅ 정답: "도쿄 호텔 가격 통합 알람" / "다섯 사이트 가격 모은 그래프"

### ✅ 자연스러운 결합 패턴 (ref 미러링 시 참고)
- "**[행동/상태]했던 [핵심 명사구]**": "DM 폭주했던 일본 우버 할인 코드" → "예약 폭주했던 도쿄 숙소 가격 알람"
- "**[부사] [동사] [핵심 명사]**": "여기저기 흩어진 쿠폰" → "여기저기 흩어진 가격 정보"
- "**[형용사] [핵심 명사]**": "기본 면세 10%" → "최근 30일 최저가" (수식어가 명사를 자연스럽게 한정)

### 룰 정리
1. ref 패턴 골격 (X했던 Y, X하는 Y 등) **유지 OK**
2. 단, X는 **우리 USP·페르소나 도메인에서 자연스러운 동사·상태**로 바꿈
3. X-Y 결합이 어색하면 X **통째로 새 동사** 선택 (단어만 바꾸기 X)
4. 어절 수·음절 패턴 강제와 충돌하면 → 의미 호응 우선, 어절은 ±2 범위 내 조정

## 🎯 어절·음절 강제 (⭐⭐⭐ 가장 중요)
각 spec의 **"어절 수"와 "어절별 음절 패턴"은 강제** — ±2자 허용.

### 룰
1. **어절 수**: 출력 = ref와 정확히 동일 (띄어쓰기 단위 개수 동일)
2. **각 어절의 음절 수**: ref 어절별 ±2 음절 허용
3. **어절 순서**: ref와 동일 위치에 동일 의미 어절 배치

### 예시
- ref: "잘 때는 편한 게 최고잖아요" → 어절 4개, 패턴 3-2-1-5
- ✅ "여행 갈 때 싼 게 최고예요" (어절 5개 ❌ — 5개)
- ✅ "잘 때는 시원한 게 최고잖아요" (어절 4개 ✅, 패턴 3-3-1-5 ✅ 모두 ±2)
- ✅ "쓸 때는 편하면 게 좋아요" (어절 4개 ✅, 패턴 3-3-1-3 — 마지막 5↔3 차이 2 = ±2 허용 ✅)
- ❌ "쓸 때는 편 게 짱" (어절 4개 ✅, 패턴 3-3-1-1-2 — 마지막 5↔2 차이 3 ❌)
- ❌ "엄청 쓸 때 편한 게 최고예요" (어절 5개 ❌)

⚠️ 음절 합계뿐 아니라 **어절 단위로 ±2 검증** — 길이 균형 무너지면 호흡 깨짐

## 🔗 Slot 일관성 ⭐⭐⭐ (같은 slot 안의 모든 문장은 같은 핵심 명사 1개 공유)
- spec_block의 **`━━━ slot N ━━━` 묶음**은 같은 토픽을 다룸
- **우리 제품 맥락에서 핵심 명사 1개 정해서 slot 전체 문장에 동일하게 사용**

### ⚠️ 같은 slot 내 = 핵심명사 1번만
- slot 첫 문장에서 핵심명사 1번 박고, 뒷 문장은 생략 (대명사·기능 동작만으로 풀기)
- 예: slot_topic="알람" → 문장1 "예약 폭주했던 호텔 가격 알람" / 문장2 "매일 가격 바뀌는 거 알지?" / 문장3 "여기 설정하고 새로고침은 말자"
  - 알람·호텔이 1번씩만, 뒷 문장은 자연스럽게 생략

### ⚠️ 다른 slot은 다른 토픽 (slot_topic 명시값 따름)
- body_1 slot_topic="알람", body_2="특가", body_3="그래프" 등 — Section Planner가 이미 결정해 spec_block에 박혀 있음
- 각 slot의 핵심명사는 **그 slot 첫 문장에만 1번**, 그 외 문장은 슬롯 토픽 동작·기능으로 풀어냄

### ❌ 잘못된 예 (slot 토픽 흩어짐)
ref slot 2: "캡내장인데 캡이 박음질돼 있어서 / 세탁하고 캡이 돌아갈 걱정도 없었고" (slot_topic="캡")
- ❌ "푸시알림인데 목표가가 설정돼 있어서 / 예약하고 알림을 놓칠 걱정도 없었고"
  - 한 문장 안에 "푸시알림" + "목표가" 두 토픽 → 어색
  - 다음 문장 "예약" → 또 다른 토픽 → slot 깨짐

### ✅ 올바른 예 (slot_topic="알림"으로 일관)
- ✅ "알림 기능인데 가격이 알림으로 와서 / 설정해두고 알림이 빗나갈 걱정도 없었고"
- ✅ "푸시 알람인데 목표가에 푸시가 와서 / 설정해놓고 푸시 놓칠 걱정도 없었고"
- 한 토픽("알림" 또는 "푸시") 정하고 slot 내 모든 문장에 반복

### 적용 룰
1. 첫 spec에서 핵심 명사 1개 결정 (ref slot_topic 참고하되 우리 제품 맥락에 맞게)
2. 같은 slot의 다음 spec에서도 그 명사 사용
3. 다른 토픽 단어 침입 금지 (특히 [부위]/[디자인특징] 자리에 다른 단어 X)
- slot_topic이 빈 문자열이면 자유 (전환·인사 슬롯)

## 🎤 종결어미 — 완전 종결 강제 ⭐⭐⭐

⚠️ 모든 출력 문장은 **완전 종결어미**로 끝나야 함. 연결어로 끝나면 안 됨.

### ❌ 사용 금지 (불완전 연결어 종결)
- `~니까` (요 없이) — "푸시 오니까" ❌
- `~서` (요 없이) — "도달하면 서" ❌
- `~고` (요 없이) — "이만큼 쏠쏠해서 부담이 없고" ❌
- `~며` — "오며" ❌

### ✅ 사용해야 할 완전 종결 (말 끝)
- `~요` — "와요", "있어요", "좋아요"
- `~잖아요` — "있잖아요", "오잖아요"
- `~거든요` — "오거든요"
- `~더라고요` — "오더라고요"
- `~예요`, `~인데요` — "푸시예요", "어플인데요"
- `~네요` — "오네요"
- `~지?` (반말 의문) — "있지?"

### 변환 예시
- ❌ "도달할 때 알림 오니까" → ✅ "도달할 때 알림 와요"
- ❌ "이만큼 쏠쏠해서 부담이 없고" → ✅ "이만큼 쏠쏠해서 부담 없어요"
- ❌ "비교하러 따로 사이트 뒤질 일 없고요" → ✅ "비교하러 따로 사이트 뒤질 일 없어요"

### ref의 연결어 종결("있어서", "없었고")이 우리 카피로 가져올 때
- 그대로 mirror X
- "있어서" → "있어요" / "있더라고요"
- "없었고" → "없었어요" / "없더라고요"

## 🎯 구체 시나리오 강제 (가장 중요 ⭐⭐⭐)

⚠️ 추상적 표현 금지 — **구체 상황/숫자/고유명사 vivid 묘사** 필수.

### ❌ 추상 표현 (사용 금지)
- "이 가격 맞는지 찝찝", "매일 부담", "쏠쏠한 혜택", "편한 기능"
- "원하는 가격에 알림", "한눈에 모이는", "굳이 안 봐도"
- 수식어만 늘어놓고 구체성 없음

### ✅ 구체 시나리오 (사용 권장)
- 페르소나 scenario + USP description + 리뷰의 vivid 일화·숫자 활용
- 일상의 구체 장면·시점·수치
- 예시:
  - 추상: "매일 가격 확인 부담"
  - ✅ "도쿄 5성급 호텔 매일 새로고침해도 가격 안 떨어질 때 있지?"
  - 추상: "원하는 가격에 알림"
  - ✅ "30만원에 알람 걸어두니까 22만원 됐을 때 푸시가 와서"
  - 추상: "할인 쏠쏠"
  - ✅ "현지 라멘집 1만원 할인쿠폰까지 들어가서 5천원 만에 먹었더라고"

### 활용 자료
1. **페르소나 scenario** — 누가, 언제, 어디서, 왜 이 USP를 씀
2. **USP description의 문제/해결/혜택** — 시스템 정보 → 일상 풀어쓰기
3. **USP 리뷰** — 실제 사용자의 vivid 일화·숫자 그대로 가져오기 (단어 단위 추출)

### 룰 (모든 role에 적용)
- 부사/형용사 늘어놓지 X. **명사·동사로 장면 그리기**
- "찝찝/부담/귀찮" 추상 감정만 X. **왜 그런지 구체 상황** 추가
- 숫자·고유명사·시점 1개 이상 활용 (가능하면)

## 📋 Role별 작성 가이드 (USP description 활용 + 소비자 언어 변환)

⚠️⚠️ **USP description은 시스템 이해용 — 출력 문장은 100% 소비자 일상 어휘로 변환** ⚠️⚠️

### ❌ 절대 사용 금지 어휘 (시스템·기능·마케팅 전문어)
- 통합사이트, 플랫폼, 시스템, 솔루션, 인터페이스, 알고리즘
- 기능, 서비스, 모듈, 컴포넌트
- "X에 도달", "X가 트리거", "활성화", "최적화"
- 명사형 추상화: "활동성", "편의성", "효율성", "쾌적함"

### ✅ 사용해야 할 소비자 언어
- "한 번에 보이는", "한 곳에 다 모여있는", "한 화면에서"
- "딱 그 가격 되면 알려주는", "원하는 값에 알람 오는"
- "5개 사이트 안 뒤지고", "굳이 들어가서 안 봐도"
- "진짜", "엄청", "딱", "쏙", "착", "탁" 같은 vivid 부사

### Role별 활용
- **transition**: USP 직접 언급 X, 흐름 유도 ("오늘은~", "그리고 제일~")
- **pain**: USP의 **📌 문제** vivid 묘사 (공감 톤)
  - description: "매일 가격 확인 부담"
  - ❌ "가격 확인 부담스럽지?" (description 그대로)
  - ✅ "매일 호텔값 들여다보기 진짜 귀찮을 때 있지?" (소비자 vivid 언어)
- **spec**: USP의 **🛠 해결** 부분 — **소비자 시점** 묘사
  - description: "5개 사이트 정보를 하나에 모았음"
  - ❌ "통합사이트라서" / "통합플랫폼이라" (시스템 언어)
  - ✅ "5개 사이트 한 번에 보이니까" / "한 곳에 다 모여 있어서" (소비자 언어)
- **benefit**: USP의 **✨ 혜택** — 체감 결과
  - description: "평균 20% 할인"
  - ✅ "20% 싸게 예약돼서 진짜 좋아요" / "10만 원 아꼈더라고요"
- **proof**: USP 리뷰의 구체 수치·일화 ("일주일 만에 X번")
- **cta**: 행동 유도 ("저장/링크/구독/남기면")

⚠️ spec.role + USP description의 일부 + 소비자 일상 어휘 변환 = 자연 카피

### 🔑 핵심 작업
Planner가 각 문장에 **skeleton + signature + usp_id**를 줍니다.
당신의 작업:
1. skeleton의 [SLOT_NAME]에 들어갈 **단어를 USP 리뷰에서 추출** (해당 spec의 usp_id에 매핑된 USP 리뷰)
2. **slot 타입에 맞게 grammatical 변환** (형용사 어간/의태어/비유 등)
3. skeleton의 **고정 부분(시그니처·연결어·조사)은 한 글자도 바꾸지 말 것**
4. 추출 단어를 [SLOT] 자리에 박아 자연스러운 한국어로 조립

### Slot 타입별 채우기
- [형용사] → 형용사 (시원한, 부드러운, 쾌적한)
- [형용사어간] → 어간만 ("시원하", "가볍")
- [의태어] → 의태어 (챱챱, 부들부들, 촤르르)
- [비유] → 비유 명사 (실크, 모찌, 구름)
- [부위] → 신체/제품 부위 (목, 등, 허리)
- [디자인특징] → 디자인 특징 (노카라, 셔링, 절개)
- [동작] → 동사 (꿀잠, 외출, 휴식)

### 작성 예시
**예시 1** — 1 slot:
- skeleton: "잘 때는 [형용사] 게 최고잖아요"
- signature: "최고잖아요" / usp_id=1 (시원감)
- 리뷰 풀: "땀이 안 차서 시원해요", "쿨링감 좋아요"
- → 추출: "시원한"
- ✅ 조립: "잘 때는 시원한 게 최고잖아요"

**예시 2** — multi-slot:
- skeleton: "[의태어] [형용사1]고 [형용사2] [비유] 같은 촉감이라"
- signature: "촉감이라" / usp_id=1
- 리뷰 풀: "받자마자 시원하고 부들부들한 재질에 놀랐어요"
- → 추출: 의태어="챱챱", 형용사1="시원하", 형용사2="부드러운", 비유="실크"
- ✅ 조립: "챱챱 시원하고 부드러운 실크 같은 촉감이라"

**예시 3** — slot 없는 경우 (skeleton에 [SLOT] 0개):
- skeleton·ref가 같으면 그대로 사용 — 새 단어 추가 X

### 🔧 Slot에 맞는 리뷰 단어 없을 때 (Fallback)
1. **가장 가까운 의미 단어** 가져와 slot 타입에 맞게 변환
   - 예: 리뷰 "쾌적" + slot [의태어] → "쾌적쾌적" / "산뜻하게" 같은 의태어형으로 변환
   - 예: 리뷰 "부드럽다" + slot [비유] → "실크 같은" / "구름 같은" 같은 비유로 변환
2. 그래도 없으면 **제품·도메인 일반어** 사용
   - 예: 잠옷 광고 [의태어] → "찰랑" / "부들부들" / "매끈"
   - 예: 여행앱 광고 [의태어] → "사르르" / "쏙쏙" / "착착"
3. **다른 USP 도메인 단어 침입 절대 X** — usp_id에 매핑된 리뷰 + 제품 도메인 일반어로만

### ⚠️ 절대 규칙
1. **skeleton의 고정 부분(SLOT 외)은 자연스러우면 그대로 / 도메인 mismatch면 변형 OK**
2. **종결어미 강제 X** — 자연 한국어 우선, 톤만 유지
3. **단어는 USP 리뷰에서 추출** — 리뷰 문장 verbatim 금지, **단어/개념만**
4. **slot 타입에 맞게 grammatical 변환** ([형용사] → 형용사 어미, [의태어] → 부사형)
5. 추상 명사구 금지 ("쾌적함/편의성/효율성/만족도" X)
6. 같은 spec의 usp_id에 해당하는 USP 리뷰만 사용 — 다른 USP 어휘 침입 X
7. 리뷰가 안 맞으면 Fallback 룰 적용 (의미 가까운 단어 → slot 타입 변환 → 도메인 일반어)

## 제품
{product_name}
{persona_str}{usps_block}

## 이 섹션의 문장 outline (각 spec)
{spec_block}

## 절대 규칙

### 1. Skeleton 고정 부분 = 한 글자도 바꾸지 말 것
- skeleton의 [SLOT] 외 모든 부분 (조사·연결어·시그니처)은 그대로
- signature 변경 절대 금지

### 2. Slot fill = USP 리뷰에서 단어 추출
- 리뷰 verbatim 금지, 단어/개념만
- slot 타입에 맞게 grammatical 변환

### 3. 자연 한국어 변형 = 조사·어미 활용 정도만
- "시원한 게" vs "시원해야" — 게 생략 가능 (자연스러우면)
- "시원하고" — 형용사1+고 결합
- 단, 의미·시그니처 변경 X

### 4. 추상 명사구 / 격식 종결 금지
- "활동성/편의성/효율성/쾌적함/만족도/신축성/최상의/탁월한/프리미엄" 등 단어 사용 X
- 참고 동사·명사·고유어 그대로 복사 X

### 5. 토픽 점프 / 가짜 인과 X
- 다른 USP 어휘 침입 X
- 무관한 두 USP를 "라서/하면"으로 묶기 X

## 출력 JSON
{{
  "sentences": [
    {{
      "position": 1,
      "text": "문장 내용",
      "direction": "TTS 연기 지시 (한 줄, 6자 이내)",
      "emotion": "curious / cheerful / happy / excited / surprised / calm / proud / frustrated 등",
      "intensity": 0.7,
      "delivery": "normal / whispers / shouts / slowly / very_fast"
    }},
    ...
  ]
}}

### direction 필드 — TTS 연기 지시 (마케팅 지시 X)
✅ 좋은 direction (TTS 연기 cue):
- "자연스럽게", "친근하게 묻듯", "확신에 차서", "공감하듯", "장난스럽게", "단호하게", "속삭이듯", "빠르게", "강조하며"

❌ 잘못된 direction (마케팅 지시문):
- "여름 잠옷은 시원함이 가장 중요하다는 점을 강조하여 공감을 유도하세요"
- "고객의 페인을 자극하여..."
- "USP를 부각시키고..."

→ direction은 **성우가 어떻게 읽을지 한 줄 cue**. 광고 전략 지시문 절대 금지.

정확히 {len(sentences_spec)}개. JSON만.
"""


def _build_critic_prompt(draft: dict, plan: dict) -> str:
    """critic prompt — 룰 위반 검출."""
    sents = draft.get("sentences") or []
    sent_lines = []
    for i, s in enumerate(sents, 1):
        sent_lines.append(f"  [{i}] {s.get('text','')}")

    return f"""당신은 광고 카피 검토관입니다. 아래 초안에서 **명확한 위반**만 검출하세요.

## 초안
{chr(10).join(sent_lines)}

## 검출할 위반
1. **마케터 어휘**: "정말 좋아요/최고예요/딱이죠/찾거든요/어때요" 등
2. **추상 명사구**: "활동성/편의성/효율성/안정성/쾌적함/만족도/신축성" 등 (친구 카톡에 안 씀)
3. **격식 종결**: "~중요하죠/~필수죠/~합니다/~입니다/~도와줘요/~추구합니다" (친구 톤 아님)
4. **가짜 인과 어미**: 무관한 두 USP를 "라서/하면"으로 묶음
5. **토픽 점프**: 인접 문장이 연결 안 되고 다른 토픽으로 점프
6. **같은 종결 반복**: ~좋아요 / ~좋아요 같이 인접 종결 동일
7. **참고 단어 표절**: 참고에만 있을 법한 고유 단어를 그대로 차용
8. **역할 위반**: spec 자리에 평가어, benefit 자리에 단순 묘사 등
9. **단어 확장**: 참고 1단어를 우리 문장에서 명사구로 확장 (예: "편한"→"편안한 활동성")

## 출력 JSON
{{
  "violations": [
    {{"sentence_index": <1-based>, "issue": "...", "suggestion": "..."}}
  ],
  "severity": "low/medium/high"
}}
위반 없으면 violations: []. JSON만.
"""


def _build_pre_planner_prompt(usps: list[dict], ref_usps: list[dict], section_chunks: list[dict]) -> str:
    """K-USP 매핑: ref_usp_id → user_usp_id.

    ref USP 각각을 우리 USP 중 의미가 가장 가까운 1개로 매핑 (또는 null).
    Hook/Intro 강제·body 강제·slot 생성 없음 — chunks가 이미 sentence 그룹과 ref USP를 정의.
    """
    usps_str = ""
    for i, u in enumerate(usps, 1):
        tag = " ⭐MAIN" if i == 1 else f" (SUB {i})"
        usps_str += f"USP{i}{tag}: {u.get('usp','')}\n"
        desc_parsed = _parse_usp_description(u.get("description") or "")
        if desc_parsed["문제"]:
            usps_str += f"  문제: {desc_parsed['문제'][:160]}\n"
        if desc_parsed["해결"]:
            usps_str += f"  해결: {desc_parsed['해결'][:160]}\n"
        if desc_parsed["혜택"]:
            usps_str += f"  혜택: {desc_parsed['혜택'][:160]}\n"
        if not (desc_parsed["문제"] or desc_parsed["해결"] or desc_parsed["혜택"]) and desc_parsed["raw"]:
            usps_str += f"  설명: {desc_parsed['raw'][:240]}\n"

    ref_usps_str = ""
    for ru in ref_usps or []:
        rid = ru.get("id")
        label = ru.get("label", "")
        desc = ru.get("description", "")
        appears = ", ".join(ru.get("appears_in") or [])
        ref_usps_str += f"\nref USP{rid} ({label}): {desc}\n"
        if appears:
            ref_usps_str += f"  등장 섹션: {appears}\n"

    chunk_lines = ""
    for c in section_chunks or []:
        sec = c.get("section", "?")
        primary = c.get("primary_usp_id")
        topic = c.get("topic", "")
        role = c.get("role", "")
        summary = c.get("summary", "")
        ref_tag = f"ref USP{primary}" if primary else "engagement (no USP)"
        chunk_lines += f"\n  [{sec}] {ref_tag} · role={role} · topic={topic}"
        if summary:
            chunk_lines += f"\n    summary: {summary}"

    return f"""당신은 광고 카피 플래너입니다. **ref의 각 USP를 우리 USP 중 어느 것에 매핑할지** 판단.

ref USP는 이미 분석되어 있고, 각 chunk가 어느 ref USP를 다루는지도 정해져 있습니다. 당신의 일은 **K-USP 매핑** — ref USP 하나당 우리 USP id 하나(또는 null).

## 우리 USPs
{usps_str}

## ref USPs (분석 완료)
{ref_usps_str or '(없음)'}

## ref Section Chunks (각 chunk가 다루는 ref USP — 컨텍스트)
{chunk_lines or '(없음)'}

## 매핑 룰
1. **각 ref USP id별로 1개의 user_usp_id 선택** (또는 null = 매칭 불가)
2. 의미·기능이 가까운 USP를 매칭. 표면 키워드보다 **mechanism/혜택의 일치**.
3. ref MAIN이라고 무조건 우리 USP1로 가지 말 것 — 우리 USP 중 의미가 가장 가까운 것이 sub여도 OK.
4. 여러 ref USP가 같은 user USP로 매핑돼도 OK (우리 카피가 그 angle을 강조).
5. **ref USP가 우리 어느 USP와도 안 맞으면 null** — null인 ref USP의 chunks는 generic 시나리오로 처리됨.
6. 우리 USP 중 매핑 안 받는 게 있어도 OK (writer 단계에서 보강 가능).

## 출력 JSON
{{
  "usp_mapping": [
    {{"ref_usp_id": 1, "user_usp_id": 1, "reason": "..."}},
    ...
  ]
}}

⚠️ reason은 **40자 이내** 한 줄. 모든 ref_usp_id 포함 (총 {len(ref_usps or [])}개). JSON만, 설명 X."""


def _build_section_planner_prompt(section_name: str, ref_subset: list[dict], usps: list[dict], product_name: str, target_persona: dict | None, pain: str, desire: str) -> str:
    """Pro: 한 섹션의 ref 문장들 → skeleton + signature 추출.

    ref_subset: 각 문장 {idx, ref_text, usp_id, role}.
    USP 정보는 받지 않음 — Pre-Planner가 이미 usp_id 할당, Skeleton 추출은 USP 무관.
    """
    ref_lines = "\n".join(
        f"  [pos {i+1}] slot={s.get('slot_id')} usp_id={s.get('usp_id')} 역할={s.get('role','')} \"{s['ref_text']}\""
        for i, s in enumerate(ref_subset)
    )

    expected_n = len(ref_subset)

    return f"""당신은 광고 카피 구문 분석가입니다. **{section_name} 섹션의 ref 문장 {expected_n}개**를 각각 skeleton + signature + slot_topic으로 분해.

⚠️ 정확히 {expected_n}개 spec 출력. 합치기·생략 절대 금지.

## 작업
참고 문장에서:
1. **고정부 식별**: 시그니처(끝 punchy 어구)·연결어·조사는 그대로 → skeleton에 박음
2. **Slot 표시**: 도메인·USP에 따라 바뀔 자리만 [SLOT_NAME] (의미적: 형용사/의태어/비유/부위/디자인특징/동작)
3. **Signature**: skeleton 끝의 punchy 어구 (잖아요/거든요/보여줄게/예요/이라 등)
4. **Role 분류** (문맥 기반):
   - **transition**: 도입·전환 ("오늘은~", "그리고 제일~", "마지막으로~")
   - **pain**: 사용자 고통·페인 ("귀찮/답답/짜증/스트레스/지?")
   - **spec**: 제품 속성·재료·기능 ("~라/이라/까지/~인데")
   - **benefit**: 사용자 체감·결과 ("~좋아요/편해요/잖아요/거든요")
   - **proof**: 구체 수치·일화 (숫자 + 단위, "샀더니/돌렸더니")
   - **cta**: 행동 유도 ("저장/구독/링크/남기면")
5. **⭐ Slot Topic 추출** (NEW): 각 문장의 **slot_topic** = 해당 slot의 핵심 명사 (ref에서 반복되는 토픽 단어)
   - **같은 slot_id의 모든 문장은 같은 slot_topic 가짐** (필수)
   - 예: ref slot 2가 "캡내장인데 캡이 박음질돼/세탁하고 캡이 돌아갈" → slot_topic="캡"
   - 예: ref slot 3이 "허리밴드 늘어나서 조이지" → slot_topic="허리밴드"
   - 일반 도입 슬롯 (전환·인사) → slot_topic="" (빈 문자열)

⚠️ slot 단어는 **출력하지 말 것** — Writer가 USP 리뷰에서 채움. Planner는 빈 [SLOT]만.

## 예시
참고: "잘 때는 편한 게 최고잖아요" (Hook 일반 진술)
→ skeleton: "잘 때는 [형용사] 게 최고잖아요"
→ signature: "최고잖아요"
→ role: "transition" (도입형 Hook — pain 키워드 없으면 transition/spec)

참고: "일본 여행 가기 전에 당신의 피드에 이 뉴스가 떴다면" (조건/도입형 Hook)
→ skeleton: "[목적지] 여행 가기 전에 당신의 피드에 이 [알림]이 떴다면"
→ signature: "떴다면"
→ role: "transition" (조건/도입 — pain 아님)

⚠️ Hook role은 **ref 텍스트 톤 그대로** — pain 키워드 명확할 때만 pain. 도입·조건·명령형이면 transition/spec/cta.

참고: "후들후들 가볍고 쫀득한 모찌 같은 촉감이라" (Body, 제품 묘사)
→ skeleton: "[의태어] [형용사1]고 [형용사2] [비유] 같은 촉감이라"
→ signature: "촉감이라"
→ role: "spec" (제품 속성 묘사)

참고: "몸에 닿는 느낌이 진짜 좋아요" (Body, 체감)
→ skeleton: "[부위]에 [동작] 느낌이 진짜 좋아요"
→ signature: "좋아요"
→ role: "benefit"

## 이 섹션의 ref 문장
{ref_lines}

## 출력 JSON
{{
  "sentences": [
    {{
      "position": 1,
      "ref_text": "...",
      "skeleton": "...",
      "signature": "...",
      "role": "spec | benefit | pain | proof | transition | cta",
      "slot_topic": "캡",
      "usp_id": 1
    }},
    ... ({expected_n}개 모두)
  ]
}}

⚠️ 같은 slot_id의 specs는 **반드시 같은 slot_topic**. JSON만. 설명 X."""


def _classify_ref_sections(primary: dict) -> list[tuple[str, list[dict]]]:
    """ref 문장을 hook/intro/body_N/cta로 분류.

    우선순위:
    1. sentences[i].section override 있으면 그대로 사용 (body_1, body_2 등 세분화 라벨 포함)
    2. 없으면 시간 범위 기반 + body 단일 처리
    """
    all_sents = sorted(
        [s for s in (primary.get("sentences") or []) if s.get("text", "").strip()],
        key=lambda x: float(x.get("start", 0)),
    )
    if not all_sents:
        return []

    # 1. Override 우선 — 모든 sentence가 section을 가지고 있으면 그대로 사용
    overrides = [str(s.get("section") or "").strip().lower() for s in all_sents]
    if all(o for o in overrides):
        # section name → list[sent dict] (입력 순서 보존, body_N별 그룹화)
        from collections import OrderedDict
        groups: "OrderedDict[str, list[dict]]" = OrderedDict()
        for s, sec in zip(all_sents, overrides):
            ts = float(s.get("start", 0))
            te = float(s.get("end", ts))
            text = s.get("text", "")
            role = _classify_sentence_role(text)
            item = {"start": ts, "end": te, "text": text, "role": role}
            groups.setdefault(sec, []).append(item)
        # 정렬 — hook → intro → body_N (N 오름차순) → cta
        def _order_key(name: str) -> tuple[int, int]:
            if name == "hook": return (0, 0)
            if name == "intro": return (1, 0)
            if name == "cta": return (3, 0)
            if name.startswith("body_"):
                try: return (2, int(name.split("_", 1)[1]))
                except Exception: return (2, 99)
            if name == "body": return (2, 0)
            return (4, 0)
        ordered = sorted(groups.items(), key=lambda kv: _order_key(kv[0]))
        logger.info("[classify] using sentence overrides: %s", [(k, len(v)) for k, v in ordered])
        return ordered

    # 2. Fallback — 시간 범위 기반
    props = analyze_reference_proportions(primary)

    def _range(key: str) -> tuple[float, float] | None:
        sents = props.get(f"{key}_sents_all") or []
        if not sents:
            return None
        starts = [float(s.get("start", 0)) for s in sents]
        ends = [float(s.get("end", 0)) for s in sents]
        return (min(starts), max(ends))

    hook_range = _range("hook")
    intro_range = _range("intro")
    cta_range = _range("cta")

    def _in_range(t_start: float, t_end: float, rng: tuple[float, float] | None) -> bool:
        if not rng: return False
        return t_start >= rng[0] - 0.3 and t_end <= rng[1] + 0.3

    hook_sents: list[dict] = []
    intro_sents: list[dict] = []
    body_sents: list[dict] = []
    cta_sents: list[dict] = []
    for s in all_sents:
        ts = float(s.get("start", 0))
        te = float(s.get("end", ts))
        text = s.get("text", "")
        role = _classify_sentence_role(text)
        item = {"start": ts, "end": te, "text": text, "role": role}
        if _in_range(ts, te, hook_range):
            hook_sents.append(item)
        elif _in_range(ts, te, intro_range):
            intro_sents.append(item)
        elif _in_range(ts, te, cta_range):
            cta_sents.append(item)
        else:
            body_sents.append(item)

    if not cta_sents and len(body_sents) >= 5:
        moved = body_sents[-3:]
        body_sents = body_sents[:-3]
        cta_sents = moved
        logger.info("[classify] CTA fallback: moved last 3 body sentences to CTA")

    # ⭐ body_slots 시간 정보 있으면 단일 body를 body_1/body_2/.../body_N으로 자동 분할
    body_slots = props.get("body_slots") or []
    if body_sents and len(body_slots) >= 2:
        # 각 body_sent를 어느 slot에 속하는지 시간 기준 매칭
        slot_groups: list[list[dict]] = [[] for _ in body_slots]
        for s in body_sents:
            ts = s["start"]
            te = s["end"]
            best_k = 0
            best_overlap = -1.0
            for k, slot in enumerate(body_slots):
                slot_start, slot_end = slot[0], slot[1]
                overlap = max(0.0, min(te, slot_end) - max(ts, slot_start))
                if overlap > best_overlap:
                    best_overlap = overlap
                    best_k = k
            slot_groups[best_k].append(s)
        # 빈 slot 제거
        out = [("hook", hook_sents), ("intro", intro_sents)]
        body_idx = 0
        for grp in slot_groups:
            if grp:
                body_idx += 1
                out.append((f"body_{body_idx}", grp))
        out.append(("cta", cta_sents))
        logger.info("[classify] auto-split body → %d body_N sections (from body_slots)", body_idx)
        return out

    return [
        ("hook", hook_sents),
        ("intro", intro_sents),
        ("body", body_sents),
        ("cta", cta_sents),
    ]


def _generate_multistep(product_name: str, pain: str, desire: str, usps: list[dict], primary: dict, target_persona: dict | None, usp_mapping_override: dict[int, int] | None = None) -> dict:
    """v4 = B버전: Pre-Planner Flash + Section Planners parallel + Writers parallel."""
    import concurrent.futures as _cf

    # destinations 1개 random 선택 — 전체 대본 일관 사용
    if target_persona and target_persona.get("destinations"):
        import random as _rnd_d
        dests = target_persona["destinations"]
        if isinstance(dests, list) and dests:
            chosen = _rnd_d.choice(dests)
            target_persona = {**target_persona, "destinations": [chosen]}
            logger.info("[multistep-B] destination chosen: %s", chosen)

    # 1a. Section 분류 (deterministic)
    classified = _classify_ref_sections(primary)
    all_ref_sents: list[dict] = []
    section_idx_ranges: list[tuple[str, int, int]] = []  # (section_name, start_idx, end_idx)
    for sec_name, sents in classified:
        start = len(all_ref_sents)
        all_ref_sents.extend([{**s, "_section": sec_name} for s in sents])
        end = len(all_ref_sents)
        if end > start:
            section_idx_ranges.append((sec_name, start, end))

    expected_total = len(all_ref_sents)
    logger.info("[multistep-B] sections classified: %s",
                [(n, e - s) for n, s, e in section_idx_ranges])

    if expected_total == 0:
        raise RuntimeError("Section classification yielded 0 sentences")

    # ⭐ 어투 감지 — ref 전체 텍스트로 dominant 반말/존댓말 결정 (Writer 강제용)
    speech_level = _detect_speech_level([s.get("text", "") for s in all_ref_sents])
    logger.info("[multistep-B] speech_level=%s", speech_level)

    # 1b. PRE-PLANNER — chunk 기반 K-USP 매핑 (ref USP → 우리 USP)
    logger.info("[multistep-B] 1b. pre-planner (chunk-based K-USP mapping)")

    # ref_usps + section_chunks 가져오기 (없으면 즉석 분석)
    _overall = ((primary.get("structure") or {}).get("overall") or {})
    ref_usps_layout = _overall.get("usp_layout") if isinstance(_overall, dict) else None
    section_chunks = _overall.get("section_chunks") if isinstance(_overall, dict) else None
    if not section_chunks:
        logger.info("[multistep-B] section_chunks 없음 — 즉석 분석")
        try:
            section_chunks = analyze_section_chunks(primary)
        except Exception as e:
            logger.warning("[multistep-B] analyze_section_chunks 실패: %s", e)
            section_chunks = []
    logger.info("[multistep-B] ref USPs: %d, chunks: %d",
                len(ref_usps_layout or []), len(section_chunks or []))

    # idx → chunk_index 매핑 (start/end/text 기준)
    chunk_for_idx: dict[int, int] = {}
    for ci, c in enumerate(section_chunks or []):
        for cs in c.get("sentences") or []:
            cs_start = float(cs.get("start", -1))
            cs_text = (cs.get("text") or "").strip()
            for i, s in enumerate(all_ref_sents):
                if i in chunk_for_idx:
                    continue
                if abs(float(s.get("start", -2)) - cs_start) < 0.05 and (s.get("text") or "").strip() == cs_text:
                    chunk_for_idx[i] = ci
                    break

    # Pre-planner 호출 — ref_usp → user_usp 매핑
    usp_mapping: dict[int, int | None] = {}
    usp_mapping_full: list[dict] = []  # UI 노출용 (ref/user 라벨 + reason)
    if ref_usps_layout:
        try:
            pre_prompt = _build_pre_planner_prompt(usps, ref_usps_layout, section_chunks or [])
            pre_result = call_gemini(pre_prompt, model="gemini-3-flash-preview", max_tokens=2048)
            if isinstance(pre_result, list) and pre_result:
                pre_result = pre_result[0]
            ref_by_id = {ru.get("id"): ru for ru in ref_usps_layout if isinstance(ru.get("id"), int)}
            for m in (pre_result.get("usp_mapping") or []):
                rid = m.get("ref_usp_id")
                uid = m.get("user_usp_id")
                reason = m.get("reason", "")
                if not isinstance(rid, int):
                    continue
                resolved_uid = uid if isinstance(uid, int) and 1 <= uid <= len(usps) else None
                usp_mapping[rid] = resolved_uid
                ref_meta = ref_by_id.get(rid) or {}
                user_name = usps[resolved_uid - 1].get("usp", "") if resolved_uid else None
                usp_mapping_full.append({
                    "ref_usp_id": rid,
                    "ref_label": ref_meta.get("label", ""),
                    "ref_description": ref_meta.get("description", ""),
                    "ref_appears_in": ref_meta.get("appears_in") or [],
                    "user_usp_id": resolved_uid,
                    "user_usp_name": user_name,
                    "reason": reason,
                })
            logger.info("[pre-planner] %d USP mappings: %s", len(usp_mapping), usp_mapping)
        except Exception as e:
            logger.warning("[pre-planner] failed: %s — usp_mapping empty", e)
    else:
        logger.info("[pre-planner] skipped — no ref_usps_layout")

    # ⭐ wizard 수동 override 적용 (사용자가 null 자리에 user USP 직접 매핑)
    if usp_mapping_override:
        for rid, uid in usp_mapping_override.items():
            if not isinstance(rid, int) or not isinstance(uid, int):
                continue
            if not (1 <= uid <= len(usps)):
                continue
            prev = usp_mapping.get(rid)
            usp_mapping[rid] = uid
            # full record도 동기화
            for rec in usp_mapping_full:
                if rec["ref_usp_id"] == rid:
                    rec["user_usp_id"] = uid
                    rec["user_usp_name"] = usps[uid - 1].get("usp", "")
                    rec["reason"] = (rec.get("reason", "") + " · 사용자 수동 매핑").strip(" ·")
                    break
            logger.info("[override] ref USP%d: %s → user USP%d", rid, prev, uid)

    # idx별 usp_id/slot_id 도출 — chunk가 권한
    usp_map: dict[int, int | None] = {}
    slot_map: dict[int, int] = {}
    for i in range(len(all_ref_sents)):
        ci = chunk_for_idx.get(i)
        if ci is None:
            usp_map[i] = None
            continue
        chunk = section_chunks[ci]
        chunk_ref_usp = chunk.get("primary_usp_id")
        usp_map[i] = usp_mapping.get(chunk_ref_usp) if isinstance(chunk_ref_usp, int) else None
        slot_map[i] = ci  # chunk index = slot

    role_override: dict[int, str] = {}

    # 1c. SECTION PLANNERS (Pro × parallel)
    logger.info("[multistep-B] 1c. section planners (Pro parallel × %d)", len(section_idx_ranges))

    def _plan_section(sec_info: tuple[str, int, int]) -> tuple[str, list[dict]]:
        sec_name, start, end = sec_info
        ref_subset = []
        for i in range(start, end):
            s = all_ref_sents[i]
            ref_subset.append({
                "idx": i,
                "ref_text": s["text"],
                "usp_id": usp_map.get(i),
                "slot_id": slot_map.get(i),
                "role": role_override.get(i) or s.get("role", "spec"),
            })
        try:
            sp_prompt = _build_section_planner_prompt(sec_name, ref_subset, usps, product_name, target_persona, pain, desire)
            sp_result = call_gemini(sp_prompt, model=MODEL, max_tokens=16384)
            sents = sp_result.get("sentences") or []
            # Slot 별 slot_topic 일관성 강제 + role_override 강제 적용
            from collections import Counter as _Cnt
            slot_topics: dict[int, list[str]] = {}
            for j, spec in enumerate(sents):
                if j < len(ref_subset):
                    rs = ref_subset[j]
                    sid = rs.get("slot_id")
                    if sid is not None:
                        spec["slot_id"] = sid
                        topic = (spec.get("slot_topic") or "").strip()
                        if topic:
                            slot_topics.setdefault(sid, []).append(topic)
                    # ⭐⭐ usp_id 강제 — Pre-Planner에서 강제한 값을 spec에 박아넣음
                    if rs.get("usp_id") is not None:
                        spec["usp_id"] = rs["usp_id"]
                    # role_override 강제 — code-level pain 강제
                    rs_idx = rs.get("idx")
                    if rs_idx in role_override:
                        spec["role"] = role_override[rs_idx]
            for sid, topics in slot_topics.items():
                if topics:
                    majority = _Cnt(topics).most_common(1)[0][0]
                    for j, spec in enumerate(sents):
                        if spec.get("slot_id") == sid:
                            spec["slot_topic"] = majority
            logger.info("[section-planner %s] expected=%d got=%d slots=%d", sec_name, len(ref_subset), len(sents), len(slot_topics))
            return sec_name, sents
        except Exception as e:
            logger.warning("[section-planner %s] failed: %s", sec_name, e)
            return sec_name, []

    section_plans: dict[str, list[dict]] = {}
    with _cf.ThreadPoolExecutor(max_workers=min(4, len(section_idx_ranges))) as ex:
        for sec_name, sents in ex.map(_plan_section, section_idx_ranges):
            section_plans[sec_name] = sents

    # 1d. plan 객체 조립 (single Planner 호환 포맷)
    plan = {
        "duration_sec": max((s.get("end", 0) for s in all_ref_sents), default=0),
        "total_sentences": expected_total,
        "sections": [],
    }
    for sec_name, _, _ in section_idx_ranges:
        sents = section_plans.get(sec_name) or []
        sec_obj = {
            "name": sec_name,
            "sentence_count": len(sents),
            "sentences": sents,
        }
        # body의 경우 main_usp_id 추정 (usp_map에서 가장 빈도 높은 usp_id)
        if sec_name == "body" and sents:
            from collections import Counter
            uc = Counter([s.get("usp_id") for s in sents if s.get("usp_id")])
            if uc:
                sec_obj["main_usp_id"] = uc.most_common(1)[0][0]
        plan["sections"].append(sec_obj)

    plan_total = sum(len(sec.get("sentences") or []) for sec in plan["sections"])
    logger.info("[multistep-B] plan: %d sentences (expected %d)", plan_total, expected_total)

    sections = plan.get("sections") or []
    if not sections:
        raise RuntimeError("Section Planners failed: no sections")

    # 2. SECTION WRITERS (Pro, 병렬, 시그니처 검증 + 자동 재요청)
    logger.info("[multistep] 2. section writers (parallel)")

    # 시그니처 패턴 — 이 패턴들이 참고 끝에 있으면 우리도 보존해야 함
    _SIGNATURE_PATTERNS = ["잖아요", "거든요", "있지", "있어", "보여줄게", "예요", "네요", "이라", "라요", "끝", "이지", "지롱"]

    def _extract_signature(text: str) -> str:
        """참고문장 끝이 'punchy 시그니처'인 경우만 시그니처 어구 반환.
        연결 어미(~면/~고/~서 등)이면 빈 문자열 반환 (검증 skip)."""
        if not text:
            return ""
        t = text.rstrip(' .!?~❤️♥️🥰😊😄').strip()
        # 마지막 8자에 시그니처 패턴이 있는지 확인
        tail = t[-10:] if len(t) >= 10 else t
        for pat in _SIGNATURE_PATTERNS:
            if pat in tail:
                # 시그니처 패턴 등장 위치부터 끝까지 추출
                idx = tail.rfind(pat)
                return tail[idx:]
        return ""  # 연결 어미 → 검증 skip

    def _validate_sentences(spec_list: list[dict], generated: list[dict], section_name: str = "") -> list[tuple[int, str]]:
        """미러링 위반 인덱스 + 위반 사유 반환.
        사유: 'eojeol_count' | 'eojeol_pattern' | 'length'
        모든 섹션 — 어절 수 강제, 어절별 음절 패턴 ±2.
        """
        violations = []
        for i, spec in enumerate(spec_list):
            ref = spec.get("ref_text", "")
            if not ref or i >= len(generated):
                continue
            gen_text = generated[i].get("text", "")
            if not gen_text.strip():
                continue
            reasons = []
            ref_pat = _eojeol_syllable_pattern(ref)
            gen_pat = _eojeol_syllable_pattern(gen_text)
            # 어절 수 검증
            if ref_pat and len(gen_pat) != len(ref_pat):
                reasons.append(f"eojeol_count(ref={len(ref_pat)},gen={len(gen_pat)})")
            elif ref_pat:
                # 어절별 음절 ±2 검증
                bad = [j for j in range(len(ref_pat)) if abs(ref_pat[j] - gen_pat[j]) > 2]
                if bad:
                    reasons.append(f"eojeol_pattern(diff at {bad})")
            # 음절 합계 검증 — 너무 짧으면 표시 (보조)
            ref_syl = sum(ref_pat)
            gen_syl = sum(gen_pat)
            if ref_syl > 0 and gen_syl < ref_syl * 0.5:
                reasons.append("length(too short)")
            if reasons:
                violations.append((i, "+".join(reasons)))
        return violations

    def _write_section(sec):
        prompt = _build_section_writer_prompt(sec, product_name, target_persona, usps, pain, desire, speech_level=speech_level)
        spec_list = sec.get("sentences") or []
        n_required = len(spec_list)
        try:
            # min_sentences로 schema minItems 강제 — Pro가 spec 수 만큼 출력
            r = call_gemini(prompt, model=MODEL, max_tokens=8192, min_sentences=n_required)
            sentences = r.get("sentences") or []
            # count retry — 부족하면 한 번 더 (강조 prompt)
            if len(sentences) < n_required:
                logger.warning("[writer] section=%s count short %d<%d — retry", sec.get("name"), len(sentences), n_required)
                retry_prompt = prompt + f"\n\n## ⚠️ 재시도 — 정확히 {n_required}개 sentence 출력 필수\n이전 시도에서 {len(sentences)}개만 나왔습니다. 모든 spec({n_required}개)에 1:1 대응하는 sentence 객체를 만드세요. 합치기·생략 금지."
                try:
                    r2 = call_gemini(retry_prompt, model=MODEL, max_tokens=8192, min_sentences=n_required)
                    s2 = r2.get("sentences") or []
                    if len(s2) > len(sentences):
                        sentences = s2
                except Exception as e2:
                    logger.warning("[writer] count retry failed: %s", e2)
            # 미러링 검증 (시그니처 + 길이)
            violations = _validate_sentences(spec_list, sentences, sec.get("name", ""))
            if violations:
                logger.warning("[writer] section=%s violations: %s", sec.get("name"), violations)
                bad_lines = []
                for i, reason in violations:
                    spec_i = spec_list[i] if i < len(spec_list) else {}
                    ref_text = spec_i.get("ref_text", "")
                    sig = _extract_signature(ref_text)
                    gen_text = sentences[i].get("text", "") if i < len(sentences) else ""
                    ref_syl = _count_kor_syllables(ref_text)
                    gen_syl = _count_kor_syllables(gen_text)
                    issue_parts = []
                    if "signature" in reason and sig:
                        issue_parts.append(f"시그니처 \"{sig}\" 누락 — 반드시 \"{sig}\"로 끝나야 함")
                    if "length" in reason:
                        issue_parts.append(f"음절 {gen_syl} (참고 {ref_syl}) — {ref_syl}±2 음절로 압축")
                    bad_lines.append(
                        f"  문장 {i+1}: 참고 \"{ref_text}\" → 우리 \"{gen_text}\" "
                        f"({'; '.join(issue_parts)})"
                    )
                retry_prompt = prompt + f"\n\n## ⚠️ 재시도 — 미러링 위반 검출\n{chr(10).join(bad_lines)}\n\n위 문장들을 다시 쓰세요. 시그니처(끝 어구) 보존 + 음절 수를 참고와 맞추기."
                try:
                    r2 = call_gemini(retry_prompt, model=MODEL, max_tokens=4096)
                    s2 = r2.get("sentences") or []
                    if s2 and len(s2) == len(sentences):
                        sentences = s2
                except Exception as e:
                    logger.warning("[writer] retry failed: %s", e)
            return sec["name"], sentences
        except Exception as e:
            logger.warning("section %s failed: %s", sec.get("name"), e)
            return sec["name"], []

    # 큰 섹션(>10 specs) chunk로 분할 → 병렬 Writer 처리량 ↑, MAX_TOKENS 회피
    CHUNK_SIZE = 10
    write_units: list[tuple[str, dict]] = []  # (chunk_id, sec_dict)
    for sec in sections:
        spec_list = sec.get("sentences") or []
        if len(spec_list) <= CHUNK_SIZE:
            write_units.append((sec["name"], sec))
        else:
            for i in range(0, len(spec_list), CHUNK_SIZE):
                chunk_specs = spec_list[i:i + CHUNK_SIZE]
                chunk_id = f"{sec['name']}#{i//CHUNK_SIZE + 1}"
                chunk_sec = {**sec, "name": chunk_id, "_orig_section": sec["name"], "sentences": chunk_specs}
                write_units.append((chunk_id, chunk_sec))
    logger.info("[multistep-B] writer units: %d (after chunking)", len(write_units))

    chunk_results: dict[str, list[dict]] = {}
    with _cf.ThreadPoolExecutor(max_workers=min(8, len(write_units))) as ex:
        for name, sents in ex.map(lambda u: _write_section(u[1]), write_units):
            chunk_results[name] = sents

    # chunk 결과를 원래 섹션 순서로 재조립
    section_results: dict[str, list[dict]] = {}
    for sec in sections:
        sec_name = sec["name"]
        spec_list = sec.get("sentences") or []
        if len(spec_list) <= CHUNK_SIZE:
            section_results[sec_name] = chunk_results.get(sec_name) or []
        else:
            merged: list[dict] = []
            for i in range(0, len(spec_list), CHUNK_SIZE):
                chunk_id = f"{sec_name}#{i//CHUNK_SIZE + 1}"
                merged.extend(chunk_results.get(chunk_id) or [])
            section_results[sec_name] = merged

    # 3. ASSEMBLE — sentences 합치고 ref timing 그대로 사용
    logger.info("[multistep] 3. assemble (using ref timing per position)")
    # ref의 모든 sentence를 순서대로 (start 시간 기준 정렬)
    ref_sentences_all = sorted(
        [s for s in (primary.get("sentences") or []) if s.get("text", "").strip()],
        key=lambda x: float(x.get("start", 0))
    )
    final_sents: list[dict] = []
    flat_idx = 0  # ref sentence 위치 인덱스
    for sec in sections:
        sents = section_results.get(sec["name"]) or []
        for s in sents:
            # ref timing 그대로 사용
            ref_s = ref_sentences_all[flat_idx] if flat_idx < len(ref_sentences_all) else None
            if ref_s:
                start = round(float(ref_s.get("start", 0)), 1)
                end = round(float(ref_s.get("end", start + 1)), 1)
            else:
                # fallback: 음절 기반 시간 추정
                syllables = s.get("syllables") or 10
                start = final_sents[-1]["end"] if final_sents else 0.0
                end = round(start + max(0.5, syllables / _KOR_SYL_PER_SEC), 1)
            final_sents.append({
                "start": start,
                "end": end,
                "text": s.get("text", ""),
                "direction": s.get("direction", ""),
                "emotion": s.get("emotion", "neutral"),
                "intensity": s.get("intensity", 0.7),
                "delivery": s.get("delivery", "normal"),
            })
            flat_idx += 1

    total_duration = final_sents[-1]["end"] if final_sents else 0
    draft = {
        "duration_target_sec": round(total_duration, 1),
        "sentences": final_sents,
        "_plan": plan,
        "_usp_mapping": usp_mapping_full,
    }

    # 4. CRITIC + 5. REFINER — 제거됨 (별도 /api/script/refine 2차 단계가 동일 역할)
    # 1차 Critic+Refiner 제거로 ~45-65s 단축 → Vercel 300s 한도 여유 확보

    # tts_script 합성
    tts_lines = []
    for s in final_sents:
        parts = []
        if s.get("direction"):
            parts.append(f"({s['direction']})")
        emo = s.get("emotion", "")
        if emo:
            pct = int((s.get("intensity") or 0.7) * 100)
            parts.append(f"({emo} {pct}%)")
        tts_lines.append(f"{''.join(parts)} {s['text']}")
    draft["tts_script"] = "\n".join(tts_lines)

    return draft


def generate(product_name: str, pain: str, desire: str, usps: list[dict], reference_shortcodes: list[str], refine: bool = True, target_persona: dict | None = None, usp_mapping_override: dict[int, int] | None = None) -> dict:
    """엔드투엔드 — 참고 릴스 fetch → 1차 생성 → (선택) 2차 다듬기 → 최종.

    usp_mapping_override: ref_usp_id → user_usp_id 수동 매핑 (wizard에서 null 자리 채울 때).
    """
    refs = []
    for sc in reference_shortcodes:
        ref = fetch_reference(sc)
        if ref:
            refs.append(ref)
    if not refs:
        raise RuntimeError("참고 릴스 데이터를 찾을 수 없습니다")
    primary = refs[0]
    # 1차 생성 (멀티스텝: 플래너 → 섹션 작성자 → 어셈블 → 비평 → 리파이너)
    draft = _generate_multistep(product_name, pain, desire, usps, primary, target_persona, usp_mapping_override=usp_mapping_override)

    # 2차 다듬기 (선택)
    if refine:
        try:
            unified = select_unified_scenario(usps)
            # 참고 길이 정보 — refine이 길이 매칭에 활용
            ref_sents = [s for s in (primary.get("sentences") or []) if s.get("text", "").strip()]
            ref_info = {
                "sentence_count": len(ref_sents),
                "duration": max((float(s.get("end", 0)) for s in ref_sents), default=0),
                "sentences": ref_sents,
            }
            refine_prompt = build_refine_prompt(draft, unified.get("city"), ref_info=ref_info, usps=usps)
            refined = call_gemini(refine_prompt)
            # Gemini가 list로 응답하는 경우 첫 항목 사용
            if isinstance(refined, list) and refined:
                refined = refined[0]
            # 다듬기 결과가 정상이면 사용, 실패하면 draft 유지
            if isinstance(refined, dict) and refined.get("sentences"):
                # _usp_mapping은 refine pass가 만들어내지 않으므로 draft에서 보존
                preserved_mapping = draft.get("_usp_mapping")
                draft = refined
                draft["_refined"] = True
                if preserved_mapping is not None and "_usp_mapping" not in draft:
                    draft["_usp_mapping"] = preserved_mapping
        except Exception as e:
            logger.warning("Refine pass failed: %s", e)
            draft["_refine_error"] = str(e)

    draft["_references_used"] = [r["shortcode"] for r in refs]
    if target_persona:
        draft["_target_persona"] = target_persona
    if product_name:
        draft["_product_name"] = product_name
    return draft
