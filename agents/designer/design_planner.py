"""Step 2: GPT-4o — Design System Planning"""

import os
import json
import requests
from pathlib import Path
from dotenv import load_dotenv

ENV_PATH = Path(__file__).parent.parent.parent / ".env"
load_dotenv(ENV_PATH)

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
OPENAI_DESIGN_MODEL = os.getenv("OPENAI_DESIGN_MODEL", "gpt-5.5")
DESIGN_REF = Path(__file__).parent / "design.md"


def plan(visual_analysis=None, user_prompt=None, current_css=None):
    """Design a complete design system with the configured OpenAI model."""
    print(f"[{OPENAI_DESIGN_MODEL}] designing system...")

    context_parts = []
    if DESIGN_REF.exists():
        context_parts.append(f"## Design Reference\n{DESIGN_REF.read_text(encoding='utf-8')[:4000]}")
    if visual_analysis:
        context_parts.append(f"## Visual Analysis\n{json.dumps(visual_analysis, ensure_ascii=False, indent=2)}")
    if user_prompt:
        context_parts.append(f"## User Request\n{user_prompt}")
    if current_css:
        context_parts.append(f"## Current CSS\n```css\n{current_css}\n```")

    prompt = f"""{chr(10).join(context_parts)}

위 정보를 바탕으로 대시보드용 완전한 디자인 시스템을 설계해줘.

반드시 아래 JSON 형식으로만 답변해:
{{
  "name": "디자인 시스템 이름",
  "theme": "light 또는 dark",
  "colors": {{
    "primary": {{"50": "#코드", "500": "#코드", "600": "#코드", "700": "#코드"}},
    "neutral": {{"50": "#코드", "500": "#코드", "800": "#코드", "900": "#코드"}},
    "accent": "#코드",
    "background": {{"base": "#코드", "surface": "#코드", "elevated": "#코드"}},
    "text": {{"primary": "#코드", "secondary": "#코드", "muted": "#코드"}},
    "border": {{"default": "#코드", "subtle": "#코드"}},
    "semantic": {{"success": "#코드", "warning": "#코드", "error": "#코드", "info": "#코드"}}
  }},
  "typography": {{"font_family": "폰트명", "fallback": "폴백"}},
  "spacing": {{"xs": "값", "sm": "값", "md": "값", "lg": "값", "xl": "값"}},
  "border_radius": {{"sm": "값", "md": "값", "lg": "값"}},
  "shadow": {{"sm": "CSS shadow", "md": "CSS shadow"}},
  "components": {{"card": {{}}, "button_primary": {{}}, "sidebar": {{}}}},
  "design_rationale": "디자인 결정 이유"
}}"""

    resp = requests.post(
        "https://api.openai.com/v1/chat/completions",
        headers={"Authorization": f"Bearer {OPENAI_API_KEY}", "Content-Type": "application/json"},
        json={
            "model": OPENAI_DESIGN_MODEL,
            "messages": [
                {"role": "system", "content": "너는 시니어 UI/UX 디자이너야. JSON 형식으로만 답변해."},
                {"role": "user", "content": prompt},
            ],
            "temperature": 0.7, "max_tokens": 4096,
        },
        timeout=120,
    )

    if resp.status_code != 200:
        print(f"[{OPENAI_DESIGN_MODEL}] error: {resp.status_code}")
        return None

    content = resp.json()["choices"][0]["message"]["content"].strip()
    if content.startswith("```"):
        content = content.split("\n", 1)[1].rsplit("```", 1)[0].strip()
    try:
        result = json.loads(content)
        print(f"[{OPENAI_DESIGN_MODEL}] system '{result.get('name', 'unnamed')}' designed")
        return result
    except json.JSONDecodeError:
        return {"raw_design": content}
