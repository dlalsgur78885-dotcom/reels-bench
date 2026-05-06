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
    tts = ref.get("tts_script") or []
    # tts_script가 통합본 1개로만 있으면 sentences(STT segments) 사용 — 정상 분절 구조 확보
    if len(tts) <= 1:
        sentences_raw = ref.get("sentences") or []
        if len(sentences_raw) > len(tts):
            tts = [
                {"start": s.get("start", 0), "end": s.get("end", 0),
                 "text": s.get("text", ""), "direction": ""}
                for s in sentences_raw
            ]
            ref["tts_script"] = tts  # 다른 함수에서도 일관 사용하도록 갱신
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
        full_tts = ref.get("tts_script") or []
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

    # 단일 USP 다각도: key_points가 시나리오·매장·카테고리·각도 나열형
    # 도메인 중립 — 시나리오·장소·각도 패턴을 일반 단어로 검출
    if key_pts:
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
    tts = ref.get("tts_script") or []
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
    tts = ref.get("tts_script") or []
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
    prompt = f"""당신은 광고 페르소나 분석가입니다. 아래 USP의 실제 리뷰를 분석해, 명확히 구분되는 페르소나 1~3개를 추출하세요.

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
- 최대 3개

## 출력 JSON (배열만)
{{
  "personas": [
    {{
      "name": "한 줄 정의 (인구통계 + 라이프스타일 키워드, 예: '<연령대> <성별> + <라이프스타일 단서>')",
      "scenario": "이 페르소나가 이 USP를 사용·체감하는 구체 상황 (리뷰에서 발견된 실제 맥락)",
      "signals": ["리뷰에 실제 등장하는 키워드1","키워드2","키워드3"],
      "review_count": <매칭 리뷰 개수>,
      "sample_reviews": ["이 페르소나 색깔이 가장 잘 드러나는 리뷰 원문 1","원문 2"],
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
    if hook_sents:
        parts.append(f"## 📐 HOOK 1:1 scaffold ({len(hook_sents)}문장)")
        for j, s in enumerate(hook_sents, 1):
            ending = (s.get("ending") or {}).get("kind", "")
            role = s.get("role", "spec")
            ref_t = s.get("text", "")
            parts.append(f"  {j}) 참고: \"{ref_t}\" [역할={role}]")
            parts.append(f"     → 우리 Hook 문장 {j}: 위 참고문장의 **토픽·역할·구문 shape·종결({ending})** 그대로. 참고가 무엇을 말하는지 파악해 우리 제품·페인에 같은 주제로 작성. 다른 토픽으로 점프 금지.")
        parts.append("")
    if intro_sents:
        parts.append(f"## 📐 INTRO 1:1 scaffold ({len(intro_sents)}문장)")
        for j, s in enumerate(intro_sents, 1):
            ending = (s.get("ending") or {}).get("kind", "")
            role = s.get("role", "transition")
            ref_t = s.get("text", "")
            parts.append(f"  {j}) 참고: \"{ref_t}\" [역할={role}]")
            parts.append(f"     → 우리 Intro 문장 {j}: 위 참고문장의 **토픽·역할·구문 shape·종결({ending})** 그대로. 참고가 제품 재질을 도입하면 우리도 우리 제품 재질을 도입. 다른 주제 X.")
        parts.append("")
    if cta_sents:
        parts.append(f"## 📐 CTA 1:1 scaffold ({len(cta_sents)}문장)")
        for j, s in enumerate(cta_sents, 1):
            ending = (s.get("ending") or {}).get("kind", "")
            role = s.get("role", "cta")
            ref_t = s.get("text", "")
            parts.append(f"  {j}) 참고: \"{ref_t}\" [역할={role}]")
            parts.append(f"     → 우리 CTA 문장 {j}: 위 참고문장의 **토픽·역할·구문 shape·종결({ending})** 그대로. 인센티브·키워드는 우리 페르소나에 맞게.")
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

    parts.append("## USP — 분절별 매핑 + 마이크로 구조 + 사용 가능 리뷰")
    # USP별 어휘 도메인 hint (다른 USP의 단어를 빌리지 않게 격리)
    other_usps = [u.get("usp", "") for u in usps]
    for i, ua in enumerate(usp_alloc, 1):
        main_tag = " ⭐ [메인 USP]" if ua.get("is_main") else ""
        slot_n = i if i <= len(body_slots) else len(body_slots)
        parts.append(f"\n■ Body 분절 {slot_n}: {ua['usp']}{main_tag}")
        if ua.get("angle"):
            parts.append(f"  각도: {ua['angle']}")
        parts.append(f"  할당: {ua['alloc_sec']:.1f}초 ({ua['alloc_syllables']}음절)")
        # 분절 2 이상의 첫 문장은 전환어 권장 (강제 X)
        if slot_n >= 2:
            parts.append(f"  🔗 분절 {slot_n} 첫 문장: 자연스러운 흐름으로 새 USP 도입. 필요시 \"그리고/또/거기다\" 같은 전환어. 강제 X — 자연 흐름이 살아있으면 생략 가능")
            parts.append(f"     ⚠️ 단, 이전 분절과 가짜 인과(\"라서/하면\")로 묶지 말 것. 새 USP 토픽임을 명확히")
        # 다른 USP 어휘 침입 금지 명시
        forbidden = [o for o in other_usps if o and o != ua["usp"]]
        if forbidden:
            parts.append(f"  🚫 이 분절에서 사용 금지 (다른 USP 영역): {', '.join(forbidden)}")
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


def classify_sentence_sections(sentences: list[dict], structure: dict) -> list[dict]:
    """각 sentence에 section(hook/intro/body/cta) 라벨 부여.

    Gemini Flash로 sentence 단위 직접 분류 — 시간 범위만으로 안 잡히는 경계 케이스 정확도 ↑.
    Returns: 같은 sentences 리스트에 section 필드 추가된 사본.
    """
    if not sentences:
        return sentences
    s = structure or {}
    hook_text = (s.get("hook") or {}).get("text", "")
    intro_text = (s.get("intro") or {}).get("text", "")
    body_text = (s.get("body") or {}).get("text", "")
    cta_text = (s.get("cta") or {}).get("text", "")

    sent_lines = []
    for i, sent in enumerate(sentences, 1):
        sent_lines.append(f"  [{i}] [{sent.get('start',0):.1f}-{sent.get('end',0):.1f}s] \"{sent.get('text','')}\"")

    prompt = f"""당신은 광고 카피 분석가입니다. 각 문장을 정확히 어느 섹션(hook/intro/body/cta)에 속하는지 분류하세요.

## 섹션 정의
- **hook**: 시청자 시선을 잡는 첫 도입 (질문·충격·일반 진술). 보통 1-3 문장. 제품·솔루션 언급 X.
- **intro**: 제품·솔루션을 처음 도입. "오늘은 X 보여줄게" / 제품 재질·기능 도입. 보통 1-3 문장.
- **body**: 제품의 구체 기능·혜택·사용 흐름·시연. 가장 긴 섹션.
- **cta**: 행동 유도. "댓글에/링크에/저장하세요" 등.

## 분류 룰
- 시간 범위만 보지 말고 **문장 의미**를 보세요.
- "후드루즈 가볍고 쫀득한 모찌 같은 촉감이라" 같이 제품 재질 도입 = intro (Hook 아님)
- "잘 때는 편한 게 최고잖아요" 같이 일반 진술 = hook
- "댓글에 X 남기면" = cta (시간 어디든)
- 제품 기능·시연·디테일 = body

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
    ...
  ]
}}
모든 {len(sentences)}개 문장 분류. JSON만.
"""
    try:
        result = call_gemini(prompt, model="gemini-3-flash-preview", max_tokens=4096)
        if isinstance(result, list) and result:
            result = result[0]
        assignments = (result or {}).get("assignments") or []
        # idx → section 매핑
        idx_to_section = {}
        for a in assignments:
            try:
                idx = int(a.get("index", 0))
                sec = (a.get("section") or "").lower().strip()
                if sec in ("hook", "intro", "body", "cta") and idx >= 1:
                    idx_to_section[idx] = sec
            except Exception:
                pass
        # apply
        out = []
        for i, sent in enumerate(sentences, 1):
            new_sent = dict(sent)
            if i in idx_to_section:
                new_sent["section"] = idx_to_section[i]
            out.append(new_sent)
        return out
    except Exception as e:
        logger.warning("classify_sentence_sections failed: %s", e)
        return sentences


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
Pain: {pain or '(미지정)'}
Desire: {desire or '(미지정)'}

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


def _section_specific_guidance(section_name: str) -> str:
    """섹션 타입별 미러링 가이드 — 톤·종결 prescription 없음, 참고 그대로."""
    name = (section_name or "").lower()
    if name == "hook":
        return """## 🎣 HOOK 자유 Transform 모드 (첫 3초) ⭐

⚠️ Hook은 **skeleton 강제 X — 자유 재작성**. 페르소나 시나리오 + USP1 리뷰 페인을 직접 묘사.

### 보존 (필수)
- **음절 수** ±2 이내 (참고와 동일 호흡)
- **어절 수** ±1 이내 (띄어쓰기 단위 동일 흐름)
- **시그니처** (있는 경우 끝 어구 "있지?/잖아요/예요/끝/이라" 등) 그대로
- **감정 흐름** — 참고 Hook의 emotion 단계 그대로 (상황도입 → 트리거 → 공감질문 등)

### 자유롭게
- skeleton의 [SLOT] 골격 안 따라도 됨 — 동사·구문 자유 변형
- USP1 리뷰의 페인 시나리오·시그널 단어를 **직접 사용** (예: 페르소나 시나리오가 "여름 잠옷 땀나는 상황"이면 → "한 여름에 자다가", "땀 때문에 찝찝해서")

### 예시 (잠옷, 참고 Hook = "갑자기 나갈 일 생기면 / 옷 갈아입는 것부터 / 너무 귀찮을 때 있지?")
- ✅ "한 여름에 자다가 / 땀 때문에 찝찝해서 / 잠 깰 때 있지?" (자유 transform, 음절·어절·"~지?" 시그니처 보존)
- ✅ "더운 날 밤마다 / 땀 차서 답답해서 / 잠 못 잔 적 있지?" (또 다른 자유 변형)
- ❌ "갑자기 땀날 일 생기면" (skeleton에 묶여 어색)

### 절대 금지
- 종결(시그니처) 변경
- 마케팅 톤 ("최고잖아요/딱이죠")
- 음절 수 ±2 초과
"""
    if name == "intro":
        return """## 🚪 INTRO 미러링 가이드
- 미션: 참고 Intro의 **구문 골격·종결 어미·길이·역할** 그대로 미러
- 참고가 솔루션 선언형이면 우리도 그렇게, 제품 도입형이면 제품 도입
- 참고 종결 그대로 보존
- 단어만 우리 제품·USP 단어로 substitute
- ⚠️ 절대 금지: 구문 재구성, 종결 변경
"""
    if name.startswith("body"):
        return """## 💪 BODY 미러링 가이드 (USP 분절)
- 미션: 참고 Body 분절의 **구문 골격·종결·길이·역할** 그대로 미러
- 참고 분절 문장 수와 동일 (참고 N문장이면 우리도 N문장)
- 단어만 우리 USP 어휘로 substitute
- 분절 간 전환은 참고 패턴 따라 (참고가 "그리고"로 시작하면 우리도 그렇게)
- ⚠️ 절대 금지:
  - 다른 분절 USP 어휘 침입
  - 가짜 인과 어미로 두 USP 묶기
  - 단어 → 명사구 확장 (예: "편한" → "편안한 활동성" ❌)
"""
    if name == "cta":
        return """## 📢 CTA 미러링 가이드
- 미션: 참고 CTA의 **구문 골격·종결·길이·역할** 그대로 미러
- 참고가 "댓글에 X 남기면 Y" 패턴이면 우리도 같은 패턴
- 단어만 우리 키워드·인센티브로 substitute
- 참고 종결 그대로 보존
- ⚠️ 절대 금지: 새 CTA 패턴 만들기, 구문 재구성
"""
    return ""


def _build_section_writer_prompt(section: dict, product_name: str, target_persona: dict | None, usps: list[dict], pain: str, desire: str) -> str:
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
        revs = [r for r in (u.get("reviews") or []) if r.strip()]
        if revs:
            _rnd.shuffle(revs)
            usps_block += "  사용 가능 리뷰 (vivid 표현·일화 영감):\n"
            for r in revs[:8]:
                usps_block += f"    · {r[:120]}\n"

    spec_block = ""
    is_hook_section = section_name.lower() == "hook"
    for s in sentences_spec:
        usp_tag = f" [USP{s.get('usp_id')}]" if s.get("usp_id") else ""
        ref_text = s.get("ref_text", "")
        ref_syl = _count_kor_syllables(ref_text) if ref_text else (s.get('syllables', 10))
        ref_eojeol = len(ref_text.split()) if ref_text else 0
        spec_block += f"\n  문장 {s['position']}{usp_tag}\n"
        spec_block += f"    역할: {s.get('role','')}\n"
        spec_block += f"    토픽: {s.get('topic','')}\n"
        spec_block += f"    음절: ~{ref_syl} (참고 동일, ±2 허용)\n"
        if ref_eojeol:
            spec_block += f"    어절: {ref_eojeol} (참고 동일, ±1 허용)\n"
        spec_block += f"    참고: \"{ref_text}\"\n"
        skel = s.get('skeleton', '')
        sig = s.get('signature', '')
        # Hook은 skeleton 자유 모드 — 참고용 표시만
        if skel and not is_hook_section:
            spec_block += f"    skeleton: \"{skel}\"  ← [SLOT]을 USP 리뷰에서 단어 추출해 채우기\n"
        elif skel and is_hook_section:
            spec_block += f"    skeleton 참고: \"{skel}\" (Hook은 자유 transform — skeleton 강제 X)\n"
        if sig:
            spec_block += f"    signature: \"{sig}\" (반드시 끝에 그대로 등장)\n"

    persona_str = ""
    if target_persona:
        persona_str = f"타깃: {target_persona.get('name','')} ({target_persona.get('scenario','')})\n"

    section_guidance = _section_specific_guidance(section_name)

    return f"""당신은 한국어 광고 카피라이터입니다. 아래 outline에 따라 **{section_name} 섹션의 문장 {len(sentences_spec)}개**만 작성.

⚠️⚠️ **direction 필드는 TTS 연기 cue 한 줄 (6자 이내)** ⚠️⚠️
- ✅ 허용: "자연스럽게", "친근하게 묻듯", "확신에 차서", "공감하듯", "장난스럽게", "단호하게", "속삭이듯"
- ❌ 절대 금지: 마케팅 지시문 ("X를 강조하여 공감을 유도하세요", "USP를 부각시키고...", "도입부를 작성하세요" 등)
- ❌ 절대 금지: 광고 전략 설명, 작성 방법 지시
direction은 **성우가 어떻게 읽을지**만. 마케팅 전략 X.

{section_guidance}

## 작성 방식 — Skeleton 조립 + Slot Fill (당신이 단어 선택)

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

### ⚠️ 절대 규칙
1. **skeleton의 고정 부분(SLOT 외)은 한 글자도 변경 X** — 조사·연결어·시그니처 그대로
2. **signature는 끝에 그대로 등장** — 변경 금지
3. **단어는 USP 리뷰에서 추출** — 리뷰 문장 verbatim 금지, **단어/개념만**
4. **slot 타입에 맞게 grammatical 변환** ([형용사] → 형용사 어미, [의태어] → 부사형)
5. 추상 명사구 금지 ("쾌적함/편의성/효율성/만족도" X)
6. signature를 "잠이 잘 오잖아요" / "중요하더라고요" 같이 변형 절대 금지
7. 같은 spec의 usp_id에 해당하는 USP 리뷰만 사용 — 다른 USP 어휘 침입 X

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


def _generate_multistep(product_name: str, pain: str, desire: str, usps: list[dict], primary: dict, target_persona: dict | None) -> dict:
    """v3 = single Planner Pro → 섹션 작성자(병렬) → 어셈블."""
    import concurrent.futures as _cf

    # 1. PLANNER (Pro 3.1 — single 호출, skeleton+signature+usp_id 출력)
    logger.info("[multistep] 1. planner (Pro single)")
    ref_sents_for_count = [s for s in (primary.get("sentences") or []) if s.get("text", "").strip()]
    expected_total = len(ref_sents_for_count)

    planner_prompt = _build_planner_prompt(product_name, pain, desire, usps, primary, target_persona)
    plan = None
    last_err = None
    for attempt in range(3):
        try:
            plan = call_gemini(planner_prompt, model=MODEL, max_tokens=16384)
            break
        except Exception as e:
            last_err = e
            logger.warning("[planner] attempt %d failed: %s", attempt + 1, e)
            planner_prompt = planner_prompt + "\n\n## ⚠️ JSON 형식 엄수\n- 모든 key·value는 \"\"로 감싸기\n- 끝에 trailing comma 금지\n- Korean 키도 반드시 \" \"로 감쌀 것"
    if plan is None:
        raise RuntimeError(f"Planner failed after retries: {last_err}")

    def _count_plan_sentences(p: dict) -> int:
        return sum(len((sec.get("sentences") or [])) for sec in (p.get("sections") or []))

    plan_total = _count_plan_sentences(plan)
    logger.info("[multistep] plan: %d sentences (expected %d)", plan_total, expected_total)

    # 검증 — 부족하면 재요청 (최대 2회)
    retry_count = 0
    while expected_total > 0 and plan_total < expected_total - 1 and retry_count < 2:
        retry_count += 1
        logger.warning("[planner] count mismatch %d < %d, retry %d", plan_total, expected_total, retry_count)
        retry_prompt = planner_prompt + (
            f"\n\n## ⚠️ 재시도\n"
            f"이전 응답에 sentences가 {plan_total}개밖에 없었습니다. "
            f"참고는 정확히 {expected_total}개. 합치기·생략 절대 금지.\n"
            f"sections의 sentences 합계 = 정확히 {expected_total}개로 출력하세요."
        )
        try:
            plan2 = call_gemini(retry_prompt, model=MODEL, max_tokens=16384)
            plan2_total = _count_plan_sentences(plan2)
            if plan2_total > plan_total:
                plan = plan2
                plan_total = plan2_total
        except Exception as e:
            logger.warning("[planner] retry failed: %s", e)
            break

    sections = plan.get("sections") or []
    if not sections:
        raise RuntimeError("Planner failed: no sections")
    logger.info("[multistep] final plan: %d sentences", plan_total)

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

    def _validate_sentences(spec_list: list[dict], generated: list[dict]) -> list[tuple[int, str]]:
        """미러링 위반 인덱스 + 위반 사유 반환.
        사유: 'signature' | 'length' | 'both'
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
            # 시그니처 검증
            ref_sig = _extract_signature(ref)
            if ref_sig:
                gen_clean = gen_text.rstrip(' .!?~❤️♥️🥰😊😄').strip()
                if not gen_clean.endswith(ref_sig):
                    reasons.append("signature")
            # 길이(음절) 검증 — ref ±15% 초과 시 위반
            ref_syl = _count_kor_syllables(ref)
            gen_syl = _count_kor_syllables(gen_text)
            if ref_syl > 0 and gen_syl > ref_syl * 1.15:
                reasons.append("length")
            elif ref_syl > 0 and gen_syl < ref_syl * 0.5:
                reasons.append("length")  # 너무 짧아도 문제
            if reasons:
                violations.append((i, "+".join(reasons)))
        return violations

    def _write_section(sec):
        prompt = _build_section_writer_prompt(sec, product_name, target_persona, usps, pain, desire)
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
            violations = _validate_sentences(spec_list, sentences)
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

    section_results: dict[str, list[dict]] = {}
    with _cf.ThreadPoolExecutor(max_workers=min(4, len(sections))) as ex:
        for name, sents in ex.map(_write_section, sections):
            section_results[name] = sents

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


def generate(product_name: str, pain: str, desire: str, usps: list[dict], reference_shortcodes: list[str], refine: bool = True, target_persona: dict | None = None) -> dict:
    """엔드투엔드 — 참고 릴스 fetch → 1차 생성 → (선택) 2차 다듬기 → 최종."""
    refs = []
    for sc in reference_shortcodes:
        ref = fetch_reference(sc)
        if ref:
            refs.append(ref)
    if not refs:
        raise RuntimeError("참고 릴스 데이터를 찾을 수 없습니다")
    primary = refs[0]
    # 1차 생성 (멀티스텝: 플래너 → 섹션 작성자 → 어셈블 → 비평 → 리파이너)
    draft = _generate_multistep(product_name, pain, desire, usps, primary, target_persona)

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
                draft = refined
                draft["_refined"] = True
        except Exception as e:
            logger.warning("Refine pass failed: %s", e)
            draft["_refine_error"] = str(e)

    draft["_references_used"] = [r["shortcode"] for r in refs]
    if target_persona:
        draft["_target_persona"] = target_persona
    if product_name:
        draft["_product_name"] = product_name
    return draft
