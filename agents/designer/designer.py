"""
Designer Agent — Main Pipeline
3-LLM UI/UX design: Gemini(visual) → GPT-4o(design) → Sonnet(code)

Usage:
  python designer.py --screenshot "screenshot.png"
  python designer.py --prompt "minimal light dashboard"
  python designer.py --improve "dashboard/style.css"
  python designer.py --references "ref1.png" "ref2.png"
"""

import sys
import json
import argparse
from pathlib import Path
from datetime import datetime

from . import visual_analyzer, design_planner, code_generator

OUTPUT_DIR = Path(__file__).parent / "output"


def run_pipeline(screenshot=None, references=None, prompt=None, improve=None):
    """Designer agent main pipeline"""
    print("=" * 50)
    print("[Designer Agent] Pipeline start")
    print("=" * 50)

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")

    # Step 1: Gemini visual analysis
    visual_analysis = None
    if screenshot:
        visual_analysis = visual_analyzer.analyze_screenshot(screenshot)
    elif references:
        visual_analysis = visual_analyzer.analyze_references(references)

    if visual_analysis:
        path = OUTPUT_DIR / f"visual_analysis_{timestamp}.json"
        path.write_text(json.dumps(visual_analysis, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"[saved] visual analysis → {path}")

    # Step 2: GPT-4o design system
    current_css = None
    if improve:
        current_css = Path(improve).read_text(encoding="utf-8")

    tokens = design_planner.plan(
        visual_analysis=visual_analysis,
        user_prompt=prompt,
        current_css=current_css,
    )
    if not tokens:
        print("[error] design system planning failed")
        return None

    tokens_path = OUTPUT_DIR / f"design_system_{timestamp}.json"
    tokens_path.write_text(json.dumps(tokens, ensure_ascii=False, indent=2), encoding="utf-8")

    # Step 3: Sonnet code generation
    css = code_generator.generate(tokens, target="streamlit")
    if css:
        css_path = OUTPUT_DIR / f"style_{timestamp}.css"
        css_path.write_text(css, encoding="utf-8")
        (OUTPUT_DIR / "style_latest.css").write_text(css, encoding="utf-8")

    # Summary
    print(f"\n[done] {tokens.get('name', 'N/A')} | {tokens.get('theme', 'N/A')}")
    return {"visual_analysis": visual_analysis, "design_tokens": tokens, "css": css}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Designer Agent")
    parser.add_argument("--screenshot", help="Screenshot path")
    parser.add_argument("--references", nargs="+", help="Reference images")
    parser.add_argument("--prompt", help="Text design request")
    parser.add_argument("--improve", help="CSS file to improve")
    args = parser.parse_args()

    if not any([args.screenshot, args.references, args.prompt, args.improve]):
        parser.print_help()
        sys.exit(1)

    run_pipeline(screenshot=args.screenshot, references=args.references, prompt=args.prompt, improve=args.improve)
