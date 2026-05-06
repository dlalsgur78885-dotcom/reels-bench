"""모든 페이지 동작 확인 — 콘솔 에러, 네트워크 4xx/5xx, 메인 컴포넌트 노출."""
import time
from pathlib import Path
from playwright.sync_api import sync_playwright

OUT = Path(__file__).parent / "_pw_screens"
OUT.mkdir(exist_ok=True)

URL = "https://reels-bench.vercel.app"


def check_page(page, label, path, content_selectors, timeout_ms=12000):
    print(f"\n=== {label}  ({path}) ===")
    errors = []
    bad_responses = []

    def on_console(msg):
        if msg.type == "error":
            errors.append(msg.text)
    def on_pageerror(e):
        errors.append(f"pageerror: {e}")
    def on_response(r):
        if r.status >= 400 and "/api/" in r.url:
            bad_responses.append(f"{r.status} {r.url[:80]}")

    page.on("console", on_console)
    page.on("pageerror", on_pageerror)
    page.on("response", on_response)

    t0 = time.time()
    try:
        page.goto(f"{URL}{path}", wait_until="domcontentloaded", timeout=timeout_ms)
    except Exception as e:
        print(f"  goto FAIL: {e}")
        return False

    # 콘텐츠 노출 대기
    try:
        page.wait_for_selector(content_selectors[0], timeout=timeout_ms)
        t_first = (time.time() - t0) * 1000
    except Exception as e:
        print(f"  '{content_selectors[0]}' not found in {timeout_ms}ms")
        page.remove_listener("console", on_console)
        page.remove_listener("pageerror", on_pageerror)
        page.remove_listener("response", on_response)
        return False

    # 모든 콘텐츠 selector 확인
    found = []
    missing = []
    for sel in content_selectors:
        c = page.locator(sel).count()
        (found if c > 0 else missing).append((sel, c))

    time.sleep(0.5)  # 조금 더 기다려 비동기 로드

    # 콘솔 에러 / 잘못된 응답 정리
    page.remove_listener("console", on_console)
    page.remove_listener("pageerror", on_pageerror)
    page.remove_listener("response", on_response)

    snap = OUT / f"audit_{label.replace('/', '_').replace(' ', '_')}.png"
    page.screenshot(path=str(snap))

    print(f"  load: {t_first:.0f}ms  (snapshot: {snap.name})")
    for sel, c in found:
        print(f"  ✓ {sel}: {c}")
    for sel, c in missing:
        print(f"  ✗ {sel}: 0")
    if errors:
        print(f"  콘솔 에러:")
        for e in errors[:5]:
            print(f"    - {e[:140]}")
    if bad_responses:
        print(f"  실패 응답:")
        for b in bad_responses[:5]:
            print(f"    - {b}")
    return not errors and not bad_responses and not missing


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(viewport={"width": 1400, "height": 900})
        page = ctx.new_page()

        # 로그인
        page.goto(f"{URL}/login")
        page.wait_for_load_state("networkidle", timeout=15000)
        page.fill("input[type='text']", "admin")
        page.fill("input[type='password']", "123456")
        page.click("button[type='submit']")
        page.wait_for_url(f"{URL}/", timeout=15000)
        for _ in range(80):
            if page.evaluate("() => localStorage.getItem('cached_me')"): break
            time.sleep(0.1)
        print("로그인 완료\n")

        # 첫 릴스 shortcode 하나 가져오기 (bench detail 테스트용)
        page.goto(f"{URL}/bench", wait_until="domcontentloaded")
        page.wait_for_selector(".reel-card", timeout=10000)
        first_sc = page.evaluate("() => document.querySelector('.reel-card')?.getAttribute('aria-label')")
        # /bench/X로 직접 가도록 — shortcode 추출은 어려우니 클릭으로
        first_card = page.locator(".reel-card").first
        first_card.click()
        page.wait_for_url("**/bench/**", timeout=10000)
        bench_detail_url = page.url
        sc = bench_detail_url.split("/bench/")[-1]
        print(f"테스트용 shortcode: {sc}\n")

        results = []

        # 각 페이지 진입
        pages_to_check = [
            ("Home", "/", ["h1", ".reel-grid", ".kpi-row"]),
            ("Bench", "/bench", ["h1", ".bench-toolbar", ".reel-card"]),
            ("BenchDetail", f"/bench/{sc}", ["h1", ".detail-header", ".detail-back"]),
            ("Phrases", "/phrases", ["h1", ".bench-toolbar", ".segment-group"]),
            ("Channels", "/channels", ["h1", ".channel-list, .channel-grid"]),
            ("ReelIntake", "/reels/new", ["h1", ".reel-intake-hero, textarea"]),
            ("MyProducts", "/my-products", ["h1", "button:has-text('새 상품')"]),
            ("Settings_Users", "/settings?tab=users", ["h1, table", "button:has-text('직원 관리'), button:has-text('직원 초대')"]),
            ("Settings_Secrets", "/settings?tab=secrets", ["h1", "button:has-text('시크릿')"]),
            ("ScriptGen", f"/script?ref={sc}", ["h1", "form, input, textarea"]),
        ]
        for label, path, sels in pages_to_check:
            ok = check_page(page, label, path, sels)
            results.append((label, ok))

        print("\n=== 결과 요약 ===")
        for label, ok in results:
            mark = "✓" if ok else "✗"
            print(f"  {mark} {label}")

        browser.close()


if __name__ == "__main__":
    main()
