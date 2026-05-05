"""Gemini 2.5 Flash API calls: frame analysis, OCR, script structure, categorization"""

import os
import re
import time
import json
import base64
import logging
import requests
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from dotenv import load_dotenv

logger = logging.getLogger(__name__)

ENV_PATH = Path(__file__).parent.parent.parent / ".env"
load_dotenv(ENV_PATH)

from . import secrets as secrets_svc


def _gemini_key() -> str:
    return secrets_svc.get_secret("GEMINI_API_KEY", "")


def _gemini_url() -> str:
    return f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={_gemini_key()}"


# Backward-compat — 다른 곳에서 truthy 체크만 하므로 함수 호출 결과로 평가
class _LazyKey:
    def __bool__(self):
        return bool(_gemini_key())
    def __str__(self):
        return _gemini_key()
GEMINI_API_KEY = _LazyKey()


def _call(parts, timeout=300, max_tokens=8192):
    """Single Gemini API call with retry"""
    for attempt in range(3):
        try:
            resp = requests.post(
                _gemini_url(),
                json={"contents": [{"parts": parts}], "generationConfig": {"maxOutputTokens": max_tokens}},
                timeout=timeout,
            )
            if resp.status_code == 200:
                return resp.json()["candidates"][0]["content"]["parts"][0]["text"]
            elif resp.status_code == 429:
                time.sleep(10 * (attempt + 1))
            else:
                break
        except Exception as e:
            logger.warning("Gemini call error: %s", e)
            break
    return None


# ── Frame Analysis ──

def _analyze_one_chunk(chunk_info):
    """Single 3-frame batch with optional prev frame for cut comparison"""
    idx, chunk, total, prev_frame = chunk_info

    n = len(chunk)
    times = ", ".join([f"{idx+j}초" for j in range(n)])

    if prev_frame:
        prompt = f"""아래 이미지 {n+1}장 중 첫 번째는 이전 구간의 마지막 프레임({idx-1}초)이야. 컷 전환 비교 기준으로만 사용해.
나머지 {n}장이 분석 대상이야. 순서대로 {times} 시점 (전체 {total}장 중 {idx+1}~{idx+n}번째).

분석 대상 {n}장에 대해서만 한 줄씩 분석해줘. 서두 없이 바로 시작:

형식: [N초] 장면설명 | 화면텍스트: "있으면 적기" | 컷전환: Y/N

규칙:
- 첫 번째 이미지(기준 프레임)와 비교해서 장면이 바뀌었으면 컷전환: Y
- 같은 장면이면 "이어서~" 형태. 장면이 바뀌었을 때만 새로운 설명.
- 화면 자막/텍스트 오버레이는 정확하게 옮겨 적기.
- [N초]로 바로 시작할 것."""
    else:
        prompt = f"""아래 이미지 {n}장은 인스타 릴스 영상에서 1초 간격으로 추출한 연속 프레임이야.
순서대로 {times} 시점 (전체 {total}장 중 {idx+1}~{idx+n}번째).

각 프레임마다 한 줄씩 분석해줘. 서두 없이 바로 시작:

형식: [N초] 장면설명 | 화면텍스트: "있으면 적기" | 컷전환: Y/N

규칙:
- 이전 프레임과의 맥락을 유지. 같은 장면이면 "이어서~" 형태.
- 장면이 바뀌었을 때만 새로운 설명, 동일하면 행동/변화 위주.
- 화면 자막/텍스트 오버레이는 정확하게 옮겨 적기.
- [N초]로 바로 시작할 것."""

    parts = [{"text": prompt}]
    if prev_frame:
        with open(prev_frame, "rb") as f:
            parts.append({"inline_data": {"mime_type": "image/jpeg", "data": base64.b64encode(f.read()).decode()}})
    for fp in chunk:
        with open(fp, "rb") as f:
            parts.append({"inline_data": {"mime_type": "image/jpeg", "data": base64.b64encode(f.read()).decode()}})

    text = _call(parts)
    if text:
        lines = []
        for line in text.strip().split('\n'):
            line = line.strip()
            if line.startswith(('*', '-')):
                line = line.lstrip('*- ').strip()
            if re.match(r'\[?\d+\s*초?\]?', line):
                lines.append(line)
        return (idx, lines)
    return (idx, [])


def analyze_frames(frame_paths):
    """3 frames per batch, 4 parallel workers, prev frame for cut comparison"""
    if not frame_paths or not GEMINI_API_KEY:
        return ""

    total = len(frame_paths)
    chunks = []
    for i in range(0, total, 3):
        chunk = [str(p) for p in frame_paths[i:i+3]]
        prev = str(frame_paths[i-1]) if i > 0 else None
        chunks.append((i, chunk, total, prev))

    with ThreadPoolExecutor(max_workers=4) as ex:
        results = list(ex.map(_analyze_one_chunk, chunks))

    results.sort(key=lambda x: x[0])
    all_lines = []
    for _, lines in results:
        all_lines.extend(lines)
    return "\n".join(all_lines)


# ── OCR Subtitles ──

def ocr_subtitles(frame_paths):
    """전체 프레임에서 OCR — 자막이 위치 어디든 잡음."""
    if not frame_paths or not GEMINI_API_KEY:
        return {}
    try:
        from PIL import Image
        import io
    except ImportError:
        return {}

    crop_b64_list = []
    for fp in frame_paths:
        try:
            img = Image.open(fp).convert("RGB")
            # 전체 프레임 사용 (자막이 상단·중앙·하단 어디든 잡기)
            buf = io.BytesIO()
            img.save(buf, format="JPEG", quality=75)
            crop_b64_list.append(base64.b64encode(buf.getvalue()).decode())
        except Exception:
            crop_b64_list.append(None)

    parts = [{"text": f"""이 이미지들은 영상의 1초 간격 프레임 {len(crop_b64_list)}장이야.
각 프레임에서 보이는 모든 자막/텍스트 오버레이를 정확히 읽어줘. 위치(상단·중앙·하단·측면) 무관하게 다 잡고, 워터마크·로고·해시태그는 제외.
텍스트가 없으면 "없음"이라고 적어.

형식 (프레임마다 한 줄):
[N초] 자막텍스트
"""}]
    for b64 in crop_b64_list:
        if b64:
            parts.append({"inline_data": {"mime_type": "image/jpeg", "data": b64}})

    text = _call(parts, timeout=120)
    if not text:
        return {}

    ocr_results = {}
    for line in text.split('\n'):
        m = re.match(r'\[?(\d+)\s*초?\]?\s*(.*)', line.strip())
        if m:
            content = m.group(2).strip()
            if content and content != "없음" and len(content) > 1:
                ocr_results[int(m.group(1))] = content
    return ocr_results


# ── Script Structure (Gemini) ──

def analyze_script_structure(transcript, caption=""):
    """Hook/Intro/Body/CTA classification via Gemini.

    transcript가 정본 — 모든 인용은 transcript에서 그대로 가져와야 함.
    caption은 보조 컨텍스트 (이모지·해시태그 같은 표현 톤 참고만, 인용 금지).
    """
    if not transcript or not GEMINI_API_KEY:
        return None

    prompt = f"""당신은 인스타그램 릴스 대본 구조 분석 전문가입니다.

⚠️ 중요 룰
- text 필드 = transcript에서 **글자 그대로** 인용. 의역·요약·이모지 추가 금지.
- caption은 톤·맥락 참고용. **caption 텍스트를 인용하지 말 것**.
- 각 구간의 시작/끝은 transcript의 자연스러운 흐름 단위로.

## 정본 transcript (← 인용은 무조건 여기서만)
{transcript}

## 보조 컨텍스트 — 캡션 (인용 금지, 분석용 참고만)
{caption or "(없음)"}

## 구간 정의
1. 후킹 (Hook): 첫 1-3초. 시청자의 스크롤을 멈추게 하는 부분. 유형: 질문형/충격형/공감형/호기심형/수치형
2. 인트로 (Intro): 후킹 직후. 영상의 맥락을 잡아주는 부분.
3. 본문 (Body): 핵심 내용 전달 구간. 가장 긴 부분.
4. CTA (Call to Action): 마지막. 행동을 유도하는 부분. 없을 수도 있음.

반드시 아래 JSON 형식으로만 답변해줘. text는 transcript의 substring만:
```json
{{"hook":{{"text":"transcript에서 그대로","type":"유형","seconds":"0-3초","analysis":"효과 분석"}},"intro":{{"text":"transcript에서 그대로","seconds":"3-7초","analysis":"연결 분석"}},"body":{{"text":"transcript에서 그대로","seconds":"7-35초","key_points":["포인트1","포인트2"],"analysis":"전달 방식"}},"cta":{{"text":"transcript에서 그대로","type":"유형","seconds":"35-40초","analysis":"CTA 전략"}},"overall":{{"flow":"흐름 요약","strength":"강점","weakness":"개선점"}}}}
```"""

    text = _call([{"text": prompt}], timeout=60)
    if not text:
        return None
    try:
        if "```json" in text:
            json_str = text.split("```json")[1].split("```")[0].strip()
        elif "```" in text:
            json_str = text.split("```")[1].split("```")[0].strip()
        else:
            json_str = text.strip()
        return json.loads(json_str)
    except Exception as e:
        logger.warning("Script structure parse error: %s", e)
        return None


# ── Category Classification (Gemini) ──

def categorize(transcript, frame_analysis, caption=""):
    """Content type + industry classification via Gemini"""
    if not GEMINI_API_KEY:
        return None

    context_parts = []
    if transcript:
        context_parts.append(f"[대본]\n{transcript[:500]}")
    if frame_analysis:
        frame_lines = [l for l in frame_analysis.split('\n') if l.strip()][:10]
        context_parts.append(f"[프레임 분석 (앞부분)]\n" + "\n".join(frame_lines))
    if caption:
        context_parts.append(f"[캡션]\n{caption[:300]}")
    if not context_parts:
        return None

    prompt = f"""아래는 인스타그램 릴스 영상의 분석 데이터야. 이 영상을 분류해줘.

{chr(10).join(context_parts)}

반드시 아래 JSON 형식으로만 답변해줘:
```json
{{"topic":"주제 대분류","topic_detail":"주제 소분류","style":"서술방식","tags":["태그1","태그2","태그3"]}}
```

## 주제 (topic → topic_detail)
- 여행/숙박: 호텔, 펜션, 캠핑, 해외여행, 국내여행, 항공, 여행팁
- 음식: 맛집탐방, 카페, 레시피, 술/와인, 디저트, 밀키트, 먹방
- 패션: 데일리룩, 하울, 브랜드리뷰, 코디팁, 빈티지, 럭셔리
- 뷰티: 스킨케어, 메이크업, 헤어, 성형/시술, 향수, 네일
- 건강/피트니스: 운동루틴, 다이어트, 요가/필라테스, 식단, 웰니스, 멘탈케어
- 사업/창업: 창업일지, 사업전략, 매출공개, 브랜딩, 마케팅, 프리랜서
- 재테크/투자: 주식, 부동산, 코인, 절약, 월급관리, 파이어족
- 부동산: 인테리어, 셀프인테리어, 이사, 원룸투어, 건축
- 교육/자기계발: 공부법, 어학, 자격증, 독서, 습관, 시간관리, 동기부여
- IT/테크: 앱추천, 가젯리뷰, AI, 코딩, 생산성툴
- 육아/가족: 임신, 출산, 육아팁, 키즈, 가족일상
- 반려동물: 강아지, 고양이, 이색동물, 훈련팁
- 연애/관계: 커플, 연애팁, 이별, 심리, 결혼
- 엔터/유머: 코미디, 패러디, 밈, 리액션, 몰카
- 음악/예술: 커버, 작곡, 그림, 공연, 댄스
- 문화/트렌드: 영화, 드라마, 전시, 팝업스토어, 핫플
- 직장/커리어: 회사생활, 이직, 연봉, 직무, 면접
- 사회/이슈: 뉴스, 시사, 환경, 사회실험

## 서술 방식 (style)
토킹헤드 / 나레이션+B롤 / 브이로그 / 스토리텔링 / 정보전달 / 튜토리얼 / 리뷰/후기 / 리스티클 / 비포애프터 / 밈/유머 / 챌린지 / 인터뷰/대화 / 몽타주 / GRWM / ASMR / POV / 언박싱 / 스킷/연기 / Q&A / 타임랩스 / 슬라이드쇼

규칙:
- topic은 반드시 위 대분류 중 하나
- topic_detail은 반드시 위 소분류 중 하나 (가장 가까운 것)
- style은 반드시 위 목록 중 하나
- tags는 자유롭게 3~5개"""

    text = _call([{"text": prompt}], timeout=60)
    if not text:
        return None
    try:
        if "```json" in text:
            json_str = text.split("```json")[1].split("```")[0].strip()
        elif "```" in text:
            json_str = text.split("```")[1].split("```")[0].strip()
        else:
            json_str = text.strip()
        return json.loads(json_str)
    except Exception as e:
        logger.warning("Categorize parse error: %s", e)
        return None


# ── Comment Reaction Analysis ──

def analyze_comment_triggers(transcript, frame_analysis, caption, comments):
    """댓글 반응을 유도한 콘텐츠 요소 분석"""
    if not GEMINI_API_KEY or not comments:
        return None

    context_parts = []
    if transcript:
        context_parts.append(f"[대본]\n{transcript}")
    if frame_analysis:
        context_parts.append(f"[영상 프레임 분석]\n{frame_analysis}")
    if caption:
        context_parts.append(f"[캡션]\n{caption}")

    # 댓글: 좋아요 순 상위 30개 + 나머지 랜덤 20개
    sorted_comments = sorted(comments, key=lambda c: c.get("comment_likes", 0) or 0, reverse=True)
    top = sorted_comments[:30]
    rest = sorted_comments[30:]
    import random
    if len(rest) > 20:
        rest = random.sample(rest, 20)
    selected = top + rest
    comment_lines = []
    for c in selected:
        likes = c.get("comment_likes", 0) or 0
        text = (c.get("comment_text") or "")[:200]
        if text:
            comment_lines.append(f"- [{likes}좋아요] {text}")

    context_parts.append(f"[댓글 ({len(comments)}개 중 {len(selected)}개)]\n" + "\n".join(comment_lines))

    prompt = f"""아래는 인스타그램 릴스의 콘텐츠와 댓글 데이터야.
댓글들이 콘텐츠의 어떤 요소에 반응한 건지 분석해줘.

{chr(10).join(context_parts)}

반드시 아래 JSON 형식으로만 답변해줘:
```json
{{
  "triggers": [
    {{
      "element": "반응을 유도한 콘텐츠 요소 (대본 일부/영상 장면/캡션 내용)",
      "source": "transcript/video/caption",
      "timestamp": "해당 시점 (예: 3-5초, 없으면 null)",
      "reaction_type": "공감/궁금증/유머/감동/논쟁/정보요청/칭찬",
      "sample_comments": ["대표 댓글 1", "대표 댓글 2"],
      "comment_count": 관련_댓글_추정_수,
      "analysis": "왜 이 요소가 반응을 유도했는지 설명"
    }}
  ],
  "summary": {{
    "dominant_reaction": "가장 많은 반응 유형",
    "engagement_driver": "전체적으로 댓글을 유도한 핵심 요인 한 줄 요약",
    "content_strength": "댓글 반응 기반 콘텐츠 강점",
    "improvement": "더 많은 반응을 유도하려면 개선할 점"
  }}
}}
```

규칙:
- triggers는 반응이 큰 순서대로 최대 5개
- 대본/영상/캡션 중 실제 반응을 유도한 요소만 포함
- 댓글이 적으면 triggers도 적게
- JSON 문자열 안에 줄바꿈 금지. 이모지 사용 금지. 순수 텍스트만.
- sample_comments에서 이모지는 제거하고 텍스트만 넣어줘"""

    text = _call([{"text": prompt}], timeout=120, max_tokens=8192)
    if not text:
        return None
    try:
        if "```json" in text:
            json_str = text.split("```json")[1].split("```")[0].strip()
        elif "```" in text:
            json_str = text.split("```")[1].split("```")[0].strip()
        else:
            json_str = text.strip()
        # Replace control chars and fix escaped sequences
        json_str = re.sub(r'[\x00-\x1f]+', ' ', json_str)
        return json.loads(json_str)
    except json.JSONDecodeError as e:
        # Try fixing unescaped quotes inside strings
        try:
            # Find strings and escape internal double quotes
            fixed = _fix_json_strings(json_str)
            return json.loads(fixed)
        except Exception:
            pass
        logger.warning("Comment trigger parse error: %s (pos %s)", e.msg, e.pos)
        # Debug: save raw for inspection
        try:
            from pathlib import Path
            (Path(__file__).parent.parent.parent / "_debug_comment_raw.txt").write_text(
                text or "", encoding="utf-8")
        except Exception:
            pass
        return None


def _fix_json_strings(s):
    """Try to fix common JSON issues from LLM output"""
    # Remove trailing commas before } or ]
    s = re.sub(r',\s*([}\]])', r'\1', s)
    return s
