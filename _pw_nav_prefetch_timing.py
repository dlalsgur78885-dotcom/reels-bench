import time
from playwright.sync_api import sync_playwright

URL = "https://reels-bench.vercel.app"


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


def measure_nav(page, href, selector):
    link = page.locator(f'a[href="{href}"]').first
    t_hover = time.time()
    link.hover()
    time.sleep(0.35)
    hover_ms = (time.time() - t_hover) * 1000
    t0 = time.time()
    link.click()
    page.wait_for_url(f"**{href}", timeout=15000)
    page.wait_for_selector(selector, timeout=15000)
    ready = (time.time() - t0) * 1000
    return hover_ms, ready


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(viewport={"width": 1400, "height": 900})
        page = ctx.new_page()
        login(page)
        routes = [
            ("/bench", ".reel-card"),
            ("/phrases", ".segment-group"),
            ("/channels", ".channel-list, .channel-grid"),
        ]
        for href, selector in routes:
            page.goto(f"{URL}/", wait_until="domcontentloaded", timeout=20000)
            page.wait_for_selector("h1", timeout=15000)
            hover_ms, ready = measure_nav(page, href, selector)
            print(f"{href} hover_wait={hover_ms:.0f}ms click_ready={ready:.0f}ms")
        browser.close()


if __name__ == "__main__":
    main()
