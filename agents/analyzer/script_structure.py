"""
Script Structure Analyzer Agent
대본을 후킹/인트로/본문/CTA 4구간으로 분류합니다.

사용법:
  python script_structure.py --text "대본 텍스트"
  python script_structure.py --shortcode "ABC123"  (Supabase에서 대본 가져와서 분석)
"""

import os
import sys
import json
import argparse
import requests
from pathlib import Path
from dotenv import load_dotenv

ENV_PATH = Path(__file__).parent.parent.parent / ".env"
load_dotenv(ENV_PATH)

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_ANON_KEY = os.getenv("SUPABASE_ANON_KEY")

STRUCTURE_PROMPT = """당신은 인스타그램 릴스 대본 구조 분석 전문가입니다.

아래 대본을 읽고, 4개 구간으로 나눠주세요. 각 구간의 **원문을 그대로 인용**해주세요.

## 구간 정의
1. **후킹 (Hook)**: 첫 1-3초. 시청자의 스크롤을 멈추게 하는 부분.
   - 유형: 질문형 / 충격형 / 공감형 / 호기심형 / 수치형

2. **인트로 (Intro)**: 후킹 직후. 영상의 맥락을 잡아주는 부분.
   - "오늘은 ~를 알려드릴게요", "이거 모르면 손해입니다" 등

3. **본문 (Body)**: 핵심 내용 전달 구간. 가장 긴 부분.
   - 정보 전달, 스토리텔링, 설명 등

4. **CTA (Call to Action)**: 마지막. 행동을 유도하는 부분.
   - 팔로우/좋아요/댓글/저장/공유 유도
   - 없을 수도 있음 (자연스럽게 끝나는 경우)

## 출력 형식 (반드시 JSON으로)
```json
{
  "hook": {
    "text": "원문 인용",
    "type": "질문형",
    "seconds": "0-3초",
    "analysis": "왜 이 후킹이 효과적인지 한 줄"
  },
  "intro": {
    "text": "원문 인용",
    "seconds": "3-7초",
    "analysis": "인트로가 본문으로 어떻게 연결되는지"
  },
  "body": {
    "text": "원문 인용",
    "seconds": "7-35초",
    "key_points": ["핵심 포인트1", "핵심 포인트2"],
    "analysis": "정보 전달 방식 (나열형/스토리형/비교형 등)"
  },
  "cta": {
    "text": "원문 인용 (없으면 빈 문자열)",
    "type": "팔로우 유도",
    "seconds": "35-40초",
    "analysis": "CTA 전략"
  },
  "overall": {
    "flow": "후킹→인트로→본문→CTA 흐름 요약 한 줄",
    "strength": "이 대본의 강점",
    "weakness": "개선할 점"
  }
}
```

## 대본
{transcript}

반드시 위 JSON 형식으로만 답변해주세요. 마크다운 코드블록(```)으로 감싸주세요."""


def analyze_script_structure(transcript, caption=""):
    """대본을 후킹/인트로/본문/CTA로 구조 분석"""
    if not transcript or not GEMINI_API_KEY:
        return None

    full_text = transcript
    if caption:
        full_text += f"\n\n[캡션]\n{caption}"

    prompt = STRUCTURE_PROMPT.replace("{transcript}", full_text)

    try:
        resp = requests.post(
            f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={GEMINI_API_KEY}",
            json={"contents": [{"parts": [{"text": prompt}]}]},
            timeout=60
        )
        if resp.status_code != 200:
            print(f"[ERROR] Gemini API: {resp.status_code}")
            return None

        text = resp.json()["candidates"][0]["content"]["parts"][0]["text"]

        # JSON 추출 (마크다운 코드블록에서)
        if "```json" in text:
            json_str = text.split("```json")[1].split("```")[0].strip()
        elif "```" in text:
            json_str = text.split("```")[1].split("```")[0].strip()
        else:
            json_str = text.strip()

        return json.loads(json_str)

    except json.JSONDecodeError as e:
        print(f"[ERROR] JSON 파싱 실패: {e}")
        print(f"원본 응답: {text[:500]}")
        return None
    except Exception as e:
        print(f"[ERROR] 분석 실패: {e}")
        return None


def fetch_transcript(shortcode):
    """Supabase에서 대본 가져오기"""
    headers = {
        "apikey": SUPABASE_ANON_KEY,
        "Authorization": f"Bearer {SUPABASE_ANON_KEY}",
    }
    resp = requests.get(
        f"{SUPABASE_URL}/rest/v1/reels_transcripts?shortcode=eq.{shortcode}&select=transcript",
        headers=headers, timeout=10
    )
    if resp.status_code == 200:
        data = resp.json()
        if data:
            return data[0].get("transcript", "")
    return None


def fetch_caption(shortcode):
    """Supabase에서 캡션 가져오기"""
    headers = {
        "apikey": SUPABASE_ANON_KEY,
        "Authorization": f"Bearer {SUPABASE_ANON_KEY}",
    }
    resp = requests.get(
        f"{SUPABASE_URL}/rest/v1/reels_metadata?shortcode=eq.{shortcode}&select=caption_text",
        headers=headers, timeout=10
    )
    if resp.status_code == 200:
        data = resp.json()
        if data:
            return data[0].get("caption_text", "")
    return None


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Script Structure Analyzer")
    parser.add_argument("--text", help="분석할 대본 텍스트")
    parser.add_argument("--shortcode", help="릴스 shortcode (Supabase에서 대본 로드)")
    args = parser.parse_args()

    transcript = None
    caption = ""

    if args.shortcode:
        transcript = fetch_transcript(args.shortcode)
        caption = fetch_caption(args.shortcode) or ""
        if not transcript:
            print(f"[ERROR] shortcode '{args.shortcode}'의 대본을 찾을 수 없습니다.")
            sys.exit(1)
    elif args.text:
        transcript = args.text
    else:
        parser.print_help()
        sys.exit(1)

    print(f"[분석] 대본 길이: {len(transcript)}자")
    result = analyze_script_structure(transcript, caption)

    if result:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print("[ERROR] 분석 실패")
