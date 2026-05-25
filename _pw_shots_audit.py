"""shots.so 자동 audit — persistent context (_pw_shots_userdata) 재사용.

전제: _pw_shots_login.py 로 같은 프로필에 이미 로그인됨.

하는 일:
  1. 같은 user_data_dir 로 Chrome 재오픈 → 로그인 상태 유지
  2. shots.so 메인 + 에디터 진입
  3. 우측 패널의 주요 섹션을 펼쳐 카탈로그 노출
  4. 각 단계 스크린샷 → _pw_screens/_shots_*
  5. DOM 텍스트 / 보이는 button·option 전수 dump → _shots_audit.txt
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright, Page

ROOT = Path(__file__).parent
USER_DATA = ROOT / "_pw_shots_userdata"
OUT_DIR = ROOT / "_pw_screens"
OUT_DIR.mkdir(exist_ok=True)
REPORT = ROOT / "_shots_audit.txt"

STEALTH_ARGS = [
    "--disable-blink-features=AutomationControlled",
    "--no-first-run",
    "--no-default-browser-check",
]
IGNORE_ARGS = ["--enable-automation"]


def safe_shot(page: Page, name: str, full: bool = False) -> None:
    try:
        page.screenshot(path=str(OUT_DIR / f"_shots_{name}.png"), full_page=full)
        print(f"  shot _shots_{name}.png", flush=True)
    except Exception as e:
        print(f"  shot FAIL {name}: {e}", file=sys.stderr)


def get_text(page: Page) -> str:
    try:
        return page.evaluate("() => document.body.innerText || ''")
    except Exception:
        return ""


def get_visible_controls(page: Page) -> list[dict]:
    js = """
    () => {
      const out = [];
      const sels = ['button', '[role=button]', '[role=option]',
                    '[role=menuitem]', '[role=tab]', 'a[href]', 'select option'];
      const seen = new Set();
      for (const sel of sels) {
        for (const el of document.querySelectorAll(sel)) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          const txt = (el.innerText || el.value || '').trim().slice(0, 80);
          const aria = el.getAttribute('aria-label') || '';
          const role = el.getAttribute('role') || el.tagName.toLowerCase();
          const title = el.getAttribute('title') || '';
          const key = role + '|' + txt + '|' + aria + '|' + title;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({ role, text: txt, aria: aria.slice(0, 80), title: title.slice(0, 80) });
        }
      }
      return out;
    }
    """
    try:
        return page.evaluate(js)
    except Exception:
        return []


def click_text(page: Page, label: str) -> bool:
    """첫 매치된 보이는 control 을 클릭. 성공 True."""
    for sel in [
        f"button:has-text('{label}')",
        f"[role=tab]:has-text('{label}')",
        f"[role=button]:has-text('{label}')",
        f"a:has-text('{label}')",
        f"[role=menuitem]:has-text('{label}')",
    ]:
        loc = page.locator(sel)
        if loc.count() == 0:
            continue
        try:
            loc.first.scroll_into_view_if_needed(timeout=1500)
            loc.first.click(timeout=2000)
            return True
        except Exception:
            continue
    return False


def main() -> int:
    if not USER_DATA.exists():
        print(f"ERROR: {USER_DATA} 없음. 먼저 _pw_shots_login.py 실행", file=sys.stderr)
        return 2

    lines: list[str] = []
    def L(s=""): lines.append(s); print(s, flush=True)

    L("=" * 60)
    L("shots.so audit")
    L("=" * 60)

    with sync_playwright() as p:
        for channel in ("chrome", "msedge", None):
            try:
                kwargs = dict(
                    user_data_dir=str(USER_DATA),
                    headless=False,
                    viewport={"width": 1440, "height": 900},
                    locale="ko-KR",
                    args=STEALTH_ARGS,
                    ignore_default_args=IGNORE_ARGS,
                )
                if channel:
                    kwargs["channel"] = channel
                ctx = p.chromium.launch_persistent_context(**kwargs)
                L(f"launched channel={channel or 'chromium'}")
                break
            except Exception as e:
                L(f"channel={channel} fail: {str(e)[:120]}")
                ctx = None
        if ctx is None:
            return 1

        try:
            ctx.add_init_script(
                "Object.defineProperty(navigator,'webdriver',{get:()=>undefined});"
            )
        except Exception:
            pass

        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        try:
            page.goto("https://shots.so/", wait_until="domcontentloaded", timeout=45000)
            time.sleep(3.5)
        except Exception as e:
            L(f"[warn] main nav: {e}")

        L(f"URL after main: {page.url}")
        safe_shot(page, "01_landing", full=True)

        # 에디터 진입 — 다양한 CTA 키워드 시도
        cta_keywords = [
            "Create", "Try", "Start", "Get started", "Open", "Editor",
            "New", "Make", "에디터", "시작", "만들기",
        ]
        entered = False
        for kw in cta_keywords:
            if click_text(page, kw):
                time.sleep(3.0)
                # 새 탭이 열리는 경우 처리
                if len(ctx.pages) > 1:
                    page = ctx.pages[-1]
                    try:
                        page.wait_for_load_state("domcontentloaded", timeout=20000)
                    except Exception:
                        pass
                    time.sleep(1.5)
                L(f"clicked CTA '{kw}' → URL {page.url}")
                entered = True
                break
        if not entered:
            L("CTA 진입 실패 — landing 그대로 분석")

        time.sleep(2.0)
        safe_shot(page, "02_editor", full=False)
        safe_shot(page, "02b_editor_full", full=True)

        # 보이는 control 전수
        ctrls = get_visible_controls(page)
        L(f"\n--- 보이는 control {len(ctrls)}개 ---")
        for c in ctrls[:300]:
            t = (c.get("text") or "").replace("\n", " ").strip()
            a = (c.get("aria") or "").strip()
            ti = (c.get("title") or "").strip()
            r = c.get("role", "")
            if not (t or a or ti):
                continue
            L(f"  [{r:10s}] text='{t}' aria='{a}' title='{ti}'")

        # 주요 우측 패널 키워드 순회
        section_kws = [
            "Device", "Background", "Effects", "Animation", "Animate",
            "Style", "Frame", "Shadow", "Noise", "Magic", "Size",
            "Filter", "Layout", "Aspect",
            "디바이스", "배경", "효과", "애니메이션", "스타일",
        ]
        for kw in section_kws:
            if click_text(page, kw):
                time.sleep(0.9)
                safe_shot(page, f"panel_{kw.lower()}")
                L(f"\n=== '{kw}' 클릭 후 ===")
                txt = get_text(page)
                # 짧은 라벨 줄 위주
                for ln in txt.split("\n"):
                    s = ln.strip()
                    if 1 <= len(s) <= 50:
                        L(f"  {s}")

        # 최종 풀스크린
        safe_shot(page, "99_final", full=True)

        # body 마지막 dump
        L("\n=== body innerText 마지막 4000자 ===")
        L(get_text(page)[-4000:])

        ctx.close()

    REPORT.write_text("\n".join(lines), encoding="utf-8")
    print(f"\nreport: {REPORT} ({REPORT.stat().st_size:,} bytes)", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
