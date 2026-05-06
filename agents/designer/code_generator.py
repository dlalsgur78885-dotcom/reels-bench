"""Step 3: Claude Sonnet 4.6 — Code Generation (design tokens → CSS)"""

import os
import json
import requests
from datetime import datetime
from pathlib import Path
from dotenv import load_dotenv

ENV_PATH = Path(__file__).parent.parent.parent / ".env"
load_dotenv(ENV_PATH)

ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY")


def generate(design_tokens, target="streamlit"):
    """Generate CSS from design tokens (Claude Sonnet, with local fallback)"""
    print(f"[Sonnet] generating {target} CSS...")

    if not ANTHROPIC_API_KEY:
        print("[Sonnet] no API key, using local fallback")
        return generate_local(design_tokens, target)

    prompt = f"""아래 디자인 토큰으로 {target} 대시보드용 CSS를 생성해줘.

## 디자인 토큰
{json.dumps(design_tokens, ensure_ascii=False, indent=2)}

## 요구사항
1. CSS 변수(:root)로 모든 토큰 정의
2. Streamlit 전용 셀렉터 포함
3. 카드, 버튼, KPI, 테이블 등 컴포넌트 스타일 포함
4. 반응형 고려

CSS 코드만 답변해줘."""

    resp = requests.post(
        "https://api.anthropic.com/v1/messages",
        headers={"x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json"},
        json={"model": "claude-sonnet-4-6-20250514", "max_tokens": 8192, "messages": [{"role": "user", "content": prompt}]},
        timeout=120,
    )

    if resp.status_code != 200:
        print(f"[Sonnet] API error {resp.status_code}, using local fallback")
        return generate_local(design_tokens, target)

    content = resp.json()["content"][0]["text"].strip()
    if content.startswith("```"):
        content = content.split("\n", 1)[1].rsplit("```", 1)[0].strip()
    print(f"[Sonnet] CSS generated ({len(content)} chars)")
    return content


def generate_local(design_tokens, target="streamlit"):
    """Fallback: design tokens → CSS without API"""
    colors = design_tokens.get("colors", {})
    typo = design_tokens.get("typography", {})
    spacing = design_tokens.get("spacing", {})
    radius = design_tokens.get("border_radius", {})
    shadow = design_tokens.get("shadow", {})

    bg = colors.get("background", {})
    text = colors.get("text", {})
    border = colors.get("border", {})
    semantic = colors.get("semantic", {})
    primary = colors.get("primary", {})

    lines = [f"/* Auto-generated {datetime.now().strftime('%Y-%m-%d %H:%M')} */\n", ":root {"]

    if isinstance(primary, dict):
        for k, v in primary.items():
            lines.append(f"  --color-primary-{k}: {v};")
    lines.append(f"  --color-accent: {colors.get('accent', '#307df0')};")

    for k, v in bg.items():
        lines.append(f"  --bg-{k}: {v};")
    for k, v in text.items():
        lines.append(f"  --text-{k}: {v};")
    for k, v in border.items():
        lines.append(f"  --border-{k}: {v};")
    for k, v in semantic.items():
        lines.append(f"  --color-{k}: {v};")

    lines.append(f"  --font-family: '{typo.get('font_family', 'Pretendard Variable')}', {typo.get('fallback', 'sans-serif')};")
    for k, v in spacing.items():
        if k != "unit":
            lines.append(f"  --space-{k}: {v};")
    for k, v in radius.items():
        lines.append(f"  --radius-{k}: {v};")
    for k, v in shadow.items():
        lines.append(f"  --shadow-{k}: {v};")

    lines.extend(["}\n", ".stApp { background-color: var(--bg-base); font-family: var(--font-family); }"])

    css = "\n".join(lines)
    print(f"[local] CSS generated ({len(css)} chars)")
    return css
