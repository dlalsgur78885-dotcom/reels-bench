"""기존 분석된 reel을 Gemini로 광고 적합성·구조 분류 → DB 저장.

분류:
- ad_suitability: 광고형 / 정보형 / 후기형 / 브랜딩형 / 유머형 / 일상형
- ad_subtype: 브랜딩형의 sub-type (사내문화/창업스토리/사례미담/비전철학/인터뷰) or null
- usp_count: 1·2·3·4 (광고/정보/후기형에서만)
- body_structure: 단일USP다각도 / 멀티USP1:1 / 비교형 / 단일진행
- hook_type: 충격형 / 질문형 / 공감형 / 통계형 / 명령형 / 시나리오형
- cta_type: 저장유도 / 댓글유도 / 링크유도 / 행동촉구 / 정보제공
"""
from __future__ import annotations

import os
import json
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import requests
from dotenv import load_dotenv

ROOT = Path(__file__).parent
load_dotenv(ROOT / ".env")
SUPA = os.getenv("SUPABASE_URL").strip()
SK = os.getenv("SUPABASE_SERVICE_ROLE_KEY").strip()
GEMINI_KEY = os.getenv("GEMINI_API_KEY").strip()
H = {"apikey": SK, "Authorization": f"Bearer {SK}"}

PROMPT = """다음 인스타 릴스의 메타 정보를 기반으로 광고/카피 활용을 위한 분류를 수행하세요.

## 입력
[작성자] {author}
[캡션] {caption}
[Hook] {hook}
[Intro] {intro}
[Body 일부] {body}
[CTA] {cta}

## 분류 기준

1. ad_suitability — 카피 베이스로 활용 가능성:
   - "광고형": 명확한 제품/서비스/앱 어필
   - "정보형": 꿀팁·튜토리얼·가이드
   - "후기형": 솔직 리뷰·사용기
   - "브랜딩형": 회사·팀·문화·창업·미담·가치관 (직접 USP 어필 X)
   - "유머형": 단순 엔터테인먼트·웃긴 영상
   - "일상형": 브이로그·일상 공유

2. ad_subtype — 브랜딩형일 때만:
   - "사내문화" / "창업스토리" / "사례미담" / "비전철학" / "인터뷰" / "기타"
   - 브랜딩형 아니면 null

3. usp_count — 광고/정보/후기형일 때만 (브랜딩/유머/일상은 0):
   - 본문에서 강조하는 별개 기능·USP·꿀팁이 몇 개? (1, 2, 3, 4)

4. body_structure:
   - "단일USP다각도": 한 USP를 여러 카테고리·시나리오·매장으로 풀어냄 (JCB 카드 → 먹고/타고/사고)
   - "멀티USP1:1": 여러 USP를 분절마다 1:1 매핑 (KTX 좌석변경/대피도우미/VR)
   - "비교형": A vs B 가격·기능 비교
   - "단일진행": 단일 흐름 스토리텔링

5. hook_type:
   - "충격형": "X 모르면 손해" 같은 경고
   - "질문형": "X 한 적 있으신가요?" 의문문
   - "공감형": "X해서 속상했다면" 같은 페인 진술
   - "통계형": 숫자·수치로 시작
   - "명령형": "X 하세요" 직접 명령
   - "시나리오형": 구체적 상황 묘사

6. cta_type:
   - "저장유도" / "댓글유도" / "링크유도" / "행동촉구" / "정보제공" / "없음"

## 출력 (JSON만, 다른 텍스트 X)
{{
  "ad_suitability": "...",
  "ad_subtype": null,
  "usp_count": 0,
  "body_structure": "...",
  "hook_type": "...",
  "cta_type": "...",
  "reason": "한 줄 이유"
}}"""


def fetch_meta(sc: str) -> dict:
    m = requests.get(f"{SUPA}/rest/v1/reels_metadata?shortcode=eq.{sc}&select=author_username,caption_text", headers=H, timeout=10).json()
    s = requests.get(f"{SUPA}/rest/v1/reels_script_structure?shortcode=eq.{sc}&select=hook,intro,body,cta", headers=H, timeout=10).json()
    return {
        "author": (m[0].get("author_username") if m else "") or "",
        "caption": ((m[0].get("caption_text") if m else "") or "")[:400],
        "hook": ((s[0].get("hook") or {}).get("text", "") if s else "")[:200],
        "intro": ((s[0].get("intro") or {}).get("text", "") if s else "")[:200],
        "body": ((s[0].get("body") or {}).get("text", "") if s else "")[:400],
        "cta": ((s[0].get("cta") or {}).get("text", "") if s else "")[:200],
    }


def call_gemini(prompt: str) -> dict:
    url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent"
    body = {
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {"temperature": 0.2, "responseMimeType": "application/json", "maxOutputTokens": 4096},
    }
    r = requests.post(url, params={"key": GEMINI_KEY}, json=body, timeout=60)
    if r.status_code != 200:
        raise RuntimeError(f"Gemini {r.status_code}")
    text = r.json()["candidates"][0]["content"]["parts"][0]["text"]
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return json.loads(text.strip().lstrip("```json").lstrip("```").rstrip("```").strip())


def classify_one(sc: str) -> tuple[str, dict | None, str]:
    try:
        meta = fetch_meta(sc)
        if not meta.get("hook") and not meta.get("body") and not meta.get("caption"):
            return sc, None, "no_data"
        prompt = PROMPT.format(**meta)
        result = call_gemini(prompt)
        # DB 저장
        save = requests.patch(
            f"{SUPA}/rest/v1/reels_pro_audio?shortcode=eq.{sc}",
            headers={**H, "Content-Type": "application/json", "Prefer": "return=minimal"},
            json={"classification": result}, timeout=15,
        )
        return sc, result, "ok" if save.status_code in (200, 204) else f"save_{save.status_code}"
    except Exception as e:
        return sc, None, f"err:{type(e).__name__}"


def main():
    targets = requests.get(f"{SUPA}/rest/v1/reels_pro_audio?select=shortcode&classification=is.null", headers=H, timeout=30).json()
    targets = [r["shortcode"] for r in targets]
    print(f"분류 대상: {len(targets)}개")
    if not targets:
        print("이미 다 분류됨")
        return

    counts: dict[str, int] = {}
    suit_counts: dict[str, int] = {}
    with ThreadPoolExecutor(max_workers=6) as ex:
        futs = {ex.submit(classify_one, sc): sc for sc in targets}
        for i, f in enumerate(as_completed(futs), 1):
            sc, result, status = f.result()
            counts[status] = counts.get(status, 0) + 1
            if result:
                suit = result.get("ad_suitability", "?")
                suit_counts[suit] = suit_counts.get(suit, 0) + 1
            if i % 20 == 0:
                print(f"  진행 {i}/{len(targets)}  status={counts}  suit={suit_counts}", flush=True)
    print(f"\n최종 status: {counts}")
    print(f"ad_suitability 분포: {suit_counts}")


if __name__ == "__main__":
    main()
