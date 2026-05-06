import time
from pathlib import Path
from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeoutError

URL = "https://reels-bench.vercel.app"
OUT = Path(__file__).parent / "_pw_screens"
OUT.mkdir(exist_ok=True)


def login(page):
    page.goto(f"{URL}/login", wait_until="domcontentloaded", timeout=20000)
    page.fill("input[type='text']", "admin")
    page.fill("input[type='password']", "123456")
    page.click("button[type='submit']")
    page.wait_for_url(f"{URL}/", timeout=20000)
    for _ in range(80):
        if page.evaluate("() => localStorage.getItem('cached_me')"):
            break
        time.sleep(0.1)


def check(page, label, path, selector, click=None):
    errors = []
    bad = []

    def on_console(msg):
        if msg.type == "error":
            text = msg.text
            if "Failed to fetch" not in text:
                errors.append(text)

    def on_pageerror(err):
        errors.append(f"pageerror: {err}")

    def on_response(res):
        if "/api/" in res.url and res.status >= 400:
            bad.append(f"{res.status} {res.url}")

    page.on("console", on_console)
    page.on("pageerror", on_pageerror)
    page.on("response", on_response)
    t0 = time.time()
    ok = True
    detail = ""
    try:
        if click:
            page.goto(f"{URL}/", wait_until="domcontentloaded", timeout=20000)
            page.wait_for_selector("h1", timeout=15000)
            click(page)
        else:
            page.goto(f"{URL}{path}", wait_until="domcontentloaded", timeout=20000)
        page.wait_for_url(f"**{path}**" if path != "/" else URL + "/", timeout=15000)
        page.wait_for_selector(selector, timeout=15000)
        ms = (time.time() - t0) * 1000
    except Exception as e:
        ok = False
        ms = (time.time() - t0) * 1000
        detail = str(e).splitlines()[0][:180]
    time.sleep(0.25)
    page.remove_listener("console", on_console)
    page.remove_listener("pageerror", on_pageerror)
    page.remove_listener("response", on_response)
    snap = OUT / f"click_all_{label.replace('/', '_').replace(' ', '_')}.png"
    try:
        page.screenshot(path=str(snap))
    except Exception:
        pass
    status = "OK" if ok and not errors and not bad else "FAIL"
    print(f"{status:4s} {label:22s} {ms:6.0f}ms {path}")
    if detail:
        print(f"     detail: {detail}")
    for e in errors[:3]:
        print(f"     console: {e[:180]}")
    for b in bad[:3]:
        print(f"     api: {b[:180]}")
    return status == "OK"


def click_nav(href):
    return lambda page: page.locator(f'a[href="{href}"]').first.click()


def click_user_button(text):
    return lambda page: page.get_by_role("button", name=text).click()


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(viewport={"width": 1400, "height": 900})
        page = ctx.new_page()
        login(page)

        checks = [
            ("Home", "/", "h1", click_nav("/")),
            ("Bench", "/bench", ".reel-card", click_nav("/bench")),
            ("BenchDetail", "/bench/DRvlSpKD-4U", ".detail-header", None),
            ("Phrases", "/phrases", ".segment-group", click_nav("/phrases")),
            ("Channels", "/channels", ".channel-list, .channel-grid", click_nav("/channels")),
            ("ReelIntake", "/reels/new", ".reel-intake-hero, textarea", click_nav("/reels/new")),
            ("MyProducts", "/my-products", "button:has-text('새 상품')", click_user_button("내 상품")),
            ("MyProductNew", "/my-products/new", "input, textarea", None),
            ("SettingsUsers", "/settings?tab=users", "h1, table", None),
            ("SettingsSecrets", "/settings?tab=secrets", "h1", None),
            ("ScriptGen", "/script?ref=DRvlSpKD-4U", "form, input, textarea", None),
            ("ScriptWizard", "/script/new/DRvlSpKD-4U", "button:has-text('분석 페이지'), button:has-text('선택')", None),
            ("Analysis", "/analysis", "h1", None),
            ("Ads", "/ads", "h1", None),
            ("YT Bench", "/yt/bench", "h1", None),
            ("YT Channels", "/yt/channels", "h1", None),
            ("YT Intake", "/yt/shorts/new", "h1, textarea, input", None),
            ("YT Phrases", "/yt/phrases", "h1", None),
            ("FB Advertisers", "/fb/advertisers", "h1", None),
            ("FB Search Advertisers", "/fb/search/advertisers", "h1", None),
            ("FB Search Ads", "/fb/search/ads", "h1", None),
        ]
        results = [check(page, *args) for args in checks]
        print(f"\nSUMMARY ok={sum(results)} fail={len(results)-sum(results)} total={len(results)}")
        browser.close()


if __name__ == "__main__":
    main()
