"""Claude Sonnet으로 USP layout + body 분석.

사용:
  python _sonnet_usp_backfill.py                # 광고형/후기형/정보형 + ad_format 없는 것 모두
  python _sonnet_usp_backfill.py --eligible     # 광고형/후기형/정보형만 (재분석)
  python _sonnet_usp_backfill.py --missing      # ad_format 없는 것만 (신규)
  python _sonnet_usp_backfill.py --shortcode SC # 특정 shortcode만
  python _sonnet_usp_backfill.py --dry-run      # 대상 목록만 출력
"""
from __future__ import annotations
import argparse
import json
import os
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import requests
from dotenv import load_dotenv

ROOT = Path(__file__).parent
load_dotenv(ROOT / ".env")
SUPA = os.getenv("SUPABASE_URL")
KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_ANON_KEY")
H = {"apikey": KEY, "Authorization": f"Bearer {KEY}"}

ELIGIBLE = {"광고형", "후기형", "정보형"}


def list_targets(specific: str | None = None, mode: str = "all") -> list[dict]:
    """대상 reel 목록.
    mode=all: 광고형/후기형/정보형 + ad_format 없는 것
    mode=eligible: 광고형/후기형/정보형만
    mode=missing: ad_format 없는 것만
    """
    if specific:
        scs = [specific]
    else:
        r = requests.get(
            f"{SUPA}/rest/v1/reels_transcripts?select=shortcode&limit=500",
            headers=H, timeout=30,
        )
        scs = [row["shortcode"] for row in r.json()]
    out = []
    for sc in scs:
        r = requests.get(
            f"{SUPA}/rest/v1/reels_script_structure?shortcode=eq.{sc}&select=overall&limit=1",
            headers=H, timeout=10,
        ).json()
        if not r:
            continue
        overall = r[0].get("overall") or {}
        fmt = overall.get("ad_format")
        is_missing = not fmt
        is_eligible = fmt in ELIGIBLE
        if mode == "eligible" and not is_eligible:
            continue
        if mode == "missing" and not is_missing:
            continue
        if mode == "all" and not (is_eligible or is_missing):
            continue
        out.append({
            "shortcode": sc,
            "ad_format": fmt or "(none)",
            "score": overall.get("ad_suitability_score"),
            "current_usps": len(overall.get("usp_layout") or []),
        })
    return out


def build_prompt(sentences: list[dict]) -> str:
    sec_texts: dict[str, list[str]] = {}
    has_sections = False
    for s in sentences:
        sec = (s.get("section") or "?").strip().lower()
        if sec and sec != "?":
            has_sections = True
            sec_texts.setdefault(sec, []).append(f"[{s.get('start',0):.1f}s] {s.get('text','')}")
    sec_block = ""
    if has_sections:
        for k in ["hook", "intro", "body_1", "body_2", "body_3", "body_4", "body_5", "body_6", "body", "cta"]:
            if k in sec_texts:
                sec_block += f"\n## {k}\n" + "\n".join(sec_texts[k]) + "\n"
    else:
        # Section override 없음 — 시간순 raw text로 fallback
        sec_block = "\n## 전체 문장 (시간순, section 미분류)\n"
        for s in sentences:
            t = (s.get("text") or "").strip()
            if t:
                sec_block += f"[{s.get('start',0):.1f}-{s.get('end',0):.1f}s] {t}\n"
        sec_block += "\n⚠️ section 라벨이 없으니 시간 흐름 + 의미로 hook/intro/body_N/cta를 추정해서 USP 배치 결정하세요.\n"
    return f"""당신은 광고 대본 분석가입니다. 이 인스타 릴스 ref를 분석해서 (1) USP 배치 (2) 광고 포맷 (3) 적합성 점수를 출력하세요.

## ref 섹션별 문장
{sec_block}

## 작업 1: USP 배치 분석
- ref가 강조하는 핵심 메시지(USP)들을 식별 — 각 body 섹션은 일반적으로 다른 USP/angle 다룸
- 각 USP가 어느 섹션들에서 등장하는지 (hook/intro/body_N/cta)
- MAIN USP = 가장 많은 섹션 등장 또는 hook+intro로 시작
- description = 구체 키워드 포함 한 줄 요약
- evidence = 핵심 어구 인용 (50자 이내)

### USP 세분화 룰
- 다른 body 섹션은 우선 다른 USP로 분리 (default)
- 추상 카테고리("내구성") 금지 → 구체 angle("수축 방지" / "물 빠짐")
- ref가 body 섹션 구분해서 다른 메시지 깔았으면 USP도 그 수만큼 분리

## 작업 2: 광고 포맷 (정확히 1개)
- **광고형**: 직접 USP 푸시, CTA 명확
- **정보형**: 팁·노하우, 제품 후순위
- **후기형**: 사용 경험·리뷰
- **브랜딩형**: 브랜드 스토리/가치
- **유머형**: 재미 우선
- **일상형**: 브이로그·사연

## 작업 3: 광고 적합성 (0-100)
광고형 90-100 / 후기형 70-85 / 정보형 55-75 / 브랜딩형 45-65 / 유머형 25-45 / 일상형 15-35

## 출력 — JSON만, 순수 JSON 객체, 코드블록 없이
{{
  "ref_usps": [
    {{"id": 1, "label": "MAIN", "description": "...", "appears_in": ["hook", "intro", "body_1"], "evidence": "..."}}
  ],
  "ad_format": "광고형",
  "ad_suitability_score": 90,
  "ad_format_reason": "한 줄 근거"
}}"""


CLAUDE_BIN = r"C:\Users\PC\AppData\Roaming\npm\claude.cmd"


def call_sonnet(prompt: str) -> dict | None:
    """claude --print --model sonnet으로 분석 (prompt는 stdin으로 전달)."""
    try:
        proc = subprocess.run(
            [CLAUDE_BIN, "--print", "--model", "sonnet"],
            input=prompt,
            capture_output=True, text=True, timeout=300, encoding="utf-8",
            shell=False,
        )
        out = (proc.stdout or "").strip()
        if proc.returncode != 0:
            print(f"  sonnet exit={proc.returncode} stderr={proc.stderr[:300]}", flush=True)
            return None
        if not out:
            print(f"  sonnet empty output. stderr={proc.stderr[:200]}", flush=True)
            return None
        # JSON 추출 (코드블록 안에 있을 수도)
        depth = 0
        start = out.find("{")
        if start < 0:
            return None
        for i in range(start, len(out)):
            if out[i] == "{":
                depth += 1
            elif out[i] == "}":
                depth -= 1
                if depth == 0:
                    raw = out[start:i+1]
                    return json.loads(raw)
    except Exception as e:
        print(f"  sonnet error: {e}", flush=True)
    return None


def process(sc: str) -> bool:
    trans = requests.get(
        f"{SUPA}/rest/v1/reels_transcripts?shortcode=eq.{sc}&select=segments",
        headers=H, timeout=15,
    ).json()
    if not trans:
        print(f"[{sc}] no transcript")
        return False
    sents = trans[0]["segments"]
    prompt = build_prompt(sents)
    parsed = call_sonnet(prompt)
    if not parsed or not parsed.get("ref_usps"):
        print(f"[{sc}] sonnet failed")
        return False

    ss = requests.get(
        f"{SUPA}/rest/v1/reels_script_structure?shortcode=eq.{sc}&select=overall",
        headers=H, timeout=10,
    ).json()
    if not ss:
        return False
    overall = ss[0].get("overall") or {}
    overall["usp_layout"] = parsed["ref_usps"]
    if parsed.get("ad_format"):
        overall["ad_format"] = parsed["ad_format"]
    if parsed.get("ad_suitability_score") is not None:
        overall["ad_suitability_score"] = parsed["ad_suitability_score"]
    if parsed.get("ad_format_reason"):
        overall["ad_format_reason"] = parsed["ad_format_reason"]
    overall["usp_layout_model"] = "claude-sonnet"
    requests.patch(
        f"{SUPA}/rest/v1/reels_script_structure?shortcode=eq.{sc}",
        headers={**H, "Content-Type": "application/json", "Prefer": "return=minimal"},
        json={"overall": overall}, timeout=15,
    )
    print(f"[{sc}] {parsed.get('ad_format')} {parsed.get('ad_suitability_score')} — {len(parsed['ref_usps'])} USPs (sonnet)")
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--shortcode", help="특정 shortcode만 처리")
    ap.add_argument("--eligible", action="store_true", help="광고형/후기형/정보형만 (재분석)")
    ap.add_argument("--missing", action="store_true", help="ad_format 없는 것만")
    ap.add_argument("--dry-run", action="store_true", help="대상 목록만 출력")
    ap.add_argument("--workers", type=int, default=4, help="parallel worker 수 (default 4)")
    args = ap.parse_args()

    if args.eligible:
        mode = "eligible"
    elif args.missing:
        mode = "missing"
    else:
        mode = "all"

    targets = list_targets(args.shortcode, mode=mode)
    print(f"=== Sonnet — mode={mode}: {len(targets)} reels (workers={args.workers}) ===", flush=True)
    if args.dry_run:
        for t in targets:
            print(f"  {t['shortcode']:25} {t['ad_format']:8} score={t['score']} usps={t['current_usps']}")
        return
    if not targets:
        return
    t0 = time.time()
    done = 0
    failed = 0
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futures = {ex.submit(process, t["shortcode"]): t for t in targets}
        for fut in as_completed(futures):
            t = futures[fut]
            try:
                ok = fut.result()
            except Exception as e:
                ok = False
                print(f"[err] {t['shortcode']}: {e}", flush=True)
            done += 1
            if not ok:
                failed += 1
            elapsed = time.time() - t0
            avg = elapsed / done
            remaining = avg * (len(targets) - done)
            print(f"  progress {done}/{len(targets)} ({failed} failed) elapsed={elapsed/60:.1f}m eta={remaining/60:.1f}m", flush=True)
    print(f"\n=== Done in {(time.time()-t0)/60:.1f} min — {done} processed, {failed} failed ===")


if __name__ == "__main__":
    main()
