"""Step 1: Gemini 2.5 Flash — Visual Analysis (screenshot → design elements)"""

import os
import json
import base64
import requests
from pathlib import Path
from dotenv import load_dotenv

ENV_PATH = Path(__file__).parent.parent.parent / ".env"
load_dotenv(ENV_PATH)

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")

VISUAL_PROMPT = """이 UI 스크린샷을 분석해서 디자인 요소를 추출해줘.

반드시 아래 JSON 형식으로만 답변해:
{
  "colors": {
    "background": ["#코드"], "text": ["#코드"], "accent": ["#코드"],
    "border": ["#코드"],
    "semantic": {"success": "#코드", "warning": "#코드", "error": "#코드", "info": "#코드"}
  },
  "typography": {"font_families": ["폰트명"], "heading_sizes": ["크기"], "body_size": "크기", "font_weights": ["weight"]},
  "spacing": {"base_unit": "크기", "section_gap": "크기", "card_padding": "크기", "element_gap": "크기"},
  "layout": {"type": "grid/sidebar/single-column/etc", "columns": 숫자, "sidebar_width": "크기 or null", "max_width": "크기", "description": "레이아웃 구조 설명"},
  "components": ["카드", "버튼", "테이블"],
  "border_radius": "크기", "shadow_style": "none/subtle/medium/heavy",
  "overall_theme": "라이트/다크/혼합", "design_mood": "미니멀/모던/플레이풀/기업형/etc"
}"""


def _parse_json(text):
    text = text.strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[1].rsplit("```", 1)[0].strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return {"raw_analysis": text}


def analyze_screenshot(image_path):
    """Extract design elements from screenshot (Gemini 2.5 Flash)"""
    print(f"[Gemini] analyzing: {image_path}")

    with open(image_path, "rb") as f:
        img_b64 = base64.b64encode(f.read()).decode()

    ext = Path(image_path).suffix.lower()
    mime = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "webp": "image/webp"}.get(ext.lstrip("."), "image/png")

    resp = requests.post(
        f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={GEMINI_API_KEY}",
        json={"contents": [{"parts": [{"text": VISUAL_PROMPT}, {"inline_data": {"mime_type": mime, "data": img_b64}}]}]},
        timeout=180,
    )
    if resp.status_code != 200:
        print(f"[Gemini] error: {resp.status_code}")
        return None

    return _parse_json(resp.json()["candidates"][0]["content"]["parts"][0]["text"])


def analyze_references(image_paths):
    """Analyze multiple references and extract common patterns"""
    analyses = [{"file": str(p), "analysis": a} for p in image_paths if (a := analyze_screenshot(p))]

    if len(analyses) < 2:
        return analyses[0]["analysis"] if analyses else None

    summary_prompt = f"""아래는 여러 UI 스크린샷의 디자인 분석 결과야. 공통 패턴을 찾아서 하나로 통합해줘.
{json.dumps(analyses, ensure_ascii=False, indent=2)}

위와 동일한 JSON 형식으로 통합 결과를 답변해줘."""

    resp = requests.post(
        f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={GEMINI_API_KEY}",
        json={"contents": [{"parts": [{"text": summary_prompt}]}]},
        timeout=180,
    )
    if resp.status_code == 200:
        return _parse_json(resp.json()["candidates"][0]["content"]["parts"][0]["text"])
    return analyses[0]["analysis"]
