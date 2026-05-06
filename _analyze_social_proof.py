"""한 릴스의 transcript에서 사회적 증명(social proof) 추출 → script_structure.overall.social_proof 저장.

usage: python _analyze_social_proof.py <shortcode>
"""
import os
import sys
import json
import requests
from pathlib import Path
from dotenv import load_dotenv

ROOT = Path(__file__).parent
load_dotenv(ROOT / ".env")
sys.path.insert(0, str(ROOT))

from api.services import script_gen  # noqa: E402

SUPA = os.getenv("SUPABASE_URL")
KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
H = {"apikey": KEY, "Authorization": f"Bearer {KEY}"}

if len(sys.argv) < 2:
    sys.exit("usage: python _analyze_social_proof.py <shortcode>")
SC = sys.argv[1]


def fetch_data(sc: str):
    # transcript
    r1 = requests.get(
        f"{SUPA}/rest/v1/reels_transcripts?shortcode=eq.{sc}&select=segments,transcript",
        headers=H, timeout=10,
    )
    rows = r1.json()
    if not rows:
        sys.exit(f"transcript 없음: {sc}")
    segs = rows[0].get("segments") or []
    transcript = rows[0].get("transcript") or ""
    if segs:
        transcript = "\n".join(
            f"[{s.get('start',0):.1f}-{s.get('end',0):.1f}] {s.get('text','')}"
            for s in segs
        )
    # script_structure (있으면 sections context로 활용)
    r2 = requests.get(
        f"{SUPA}/rest/v1/reels_script_structure?shortcode=eq.{sc}&select=overall",
        headers=H, timeout=10,
    )
    ss_rows = r2.json()
    overall = (ss_rows[0]["overall"] if ss_rows else {}) or {}
    return transcript, overall


def analyze(transcript: str, overall: dict) -> list[dict]:
    sections_ctx = ""
    chunks = overall.get("section_chunks") or []
    if chunks:
        sections_ctx = "\n## 섹션 chunks (참고)\n"
        for c in chunks[:20]:
            sec = c.get("section")
            summary = (c.get("summary") or "")[:120]
            sections_ctx += f"  [{sec}] {summary}\n"

    prompt = f"""당신은 광고 카피 분석가입니다. 아래 한국어 릴스 대본에서 **사회적 증명(social proof)** 신호를 모두 추출.

⚠️ 사회적 증명 = 제품 USP/mechanism이 아니라 "남들이 이미 검증함"을 보여주는 신뢰 신호. USP와 별개로 추출.

## 카테고리
- **sales_volume** — 매출·판매량 ("32억", "10만 개 팔린", "월 1억원 매출")
- **review_volume** — 후기 수·재구매 ("후기 1000개", "재구매율 80%", "칭찬 수두룩")
- **rating** — 평점 ("별점 5점", "리뷰 4.9", "만점")
- **authority** — 전문가·셀럽·기업 추천 ("의사 추천", "BTS가 입은", "삼성도 쓰는")
- **scarcity** — 품절·랭킹·인기 ("품절 임박", "베스트 1위", "리오더 5번")
- **award** — 수상·인증 ("올해의 브랜드", "FDA 승인", "아마존 1위")
- **personal** — 발화자 본인 사용 (약한 신호: "저도 사랑이에요", "5년째 쓰는데") — 별도 표시

## 대본
{transcript}
{sections_ctx}

## 작업
릴스에서 등장하는 사회적 증명 신호를 추출. 각 신호마다:
1. **type** (위 카테고리 중 1개)
2. **label** (8자 이내 짧은 이름. 예: "32억 매출", "후기 칭찬", "별점 5점")
3. **evidence** (대본에서 그대로 인용한 짧은 구절)
4. **appears_in** (해당 chunk의 section 이름들. 예: ["body_5", "cta"]. 모르면 빈 배열)
5. **strength** ("strong" | "weak"): 구체 수치 있으면 strong. 모호하면 weak.

## 출력 JSON
{{
  "social_proof": [
    {{
      "id": 1,
      "type": "sales_volume",
      "label": "32억 매출",
      "evidence": "32억 버터팬스",
      "appears_in": ["body_5", "cta"],
      "strength": "strong"
    }},
    ...
  ]
}}

⚠️ 카테고리에 안 맞으면 출력 X. 사회적 증명이 0개면 빈 배열. JSON만, 설명 X."""

    r = script_gen.call_openrouter(prompt, model="anthropic/claude-sonnet-4-6", max_tokens=2048)
    return r.get("social_proof") or []


def save(sc: str, social_proof: list[dict]):
    # 기존 overall fetch → social_proof 머지
    r1 = requests.get(
        f"{SUPA}/rest/v1/reels_script_structure?shortcode=eq.{sc}&select=overall",
        headers=H, timeout=10,
    )
    rows = r1.json()
    if not rows:
        print("script_structure row 없음 — 생성 필요")
        return
    overall = rows[0].get("overall") or {}
    overall["social_proof"] = social_proof
    rr = requests.patch(
        f"{SUPA}/rest/v1/reels_script_structure?shortcode=eq.{sc}",
        headers={**H, "Content-Type": "application/json", "Prefer": "return=minimal"},
        json={"overall": overall},
        timeout=15,
    )
    print(f"save status: {rr.status_code}")


def main():
    print(f"=== social proof 분석: {SC} ===")
    transcript, overall = fetch_data(SC)
    print(f"transcript: {len(transcript)} chars")
    sp = analyze(transcript, overall)
    print(f"\n추출 결과: {len(sp)}개\n")
    for s in sp:
        print(f"  [{s.get('type')}] {s.get('label')} ({s.get('strength')})")
        print(f"    evidence: \"{s.get('evidence')}\"")
        print(f"    appears_in: {s.get('appears_in')}")
    save(SC, sp)
    print("\nDONE.")


if __name__ == "__main__":
    main()
