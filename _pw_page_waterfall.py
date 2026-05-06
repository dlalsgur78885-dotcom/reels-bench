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


def measure(page, label, path, selector):
    rows = []
    starts = {}

    def on_request(req):
        if req.resource_type in ("xhr", "fetch", "script", "document"):
            starts[req] = time.time()

    def on_response(res):
        req = res.request
        if req not in starts:
            return
        ms = (time.time() - starts[req]) * 1000
        url = res.url.replace(URL, "")
        if "supabase.co" in url:
            url = url.split(".supabase.co", 1)[-1]
        rows.append((ms, res.status, req.resource_type, url[:120]))

    page.on("request", on_request)
    page.on("response", on_response)
    t0 = time.time()
    page.goto(f"{URL}{path}", wait_until="domcontentloaded", timeout=25000)
    page.wait_for_selector(selector, timeout=25000)
    ready = (time.time() - t0) * 1000
    time.sleep(0.7)
    page.remove_listener("request", on_request)
    page.remove_listener("response", on_response)

    print(f"\n=== {label} {path} ready={ready:.0f}ms ===")
    for ms, status, typ, url in sorted(rows, reverse=True)[:12]:
        print(f"{ms:6.0f}ms HTTP {status} {typ:8s} {url}")


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(viewport={"width": 1400, "height": 900})
        page = ctx.new_page()
        login(page)
        pages = [
            ("Bench", "/bench", ".reel-card"),
            ("Phrases", "/phrases", ".segment-group"),
            ("Channels", "/channels", ".channel-list, .channel-grid"),
            ("MyProducts", "/my-products", "button:has-text('새 상품')"),
            ("ScriptGen", "/script?ref=DRvlSpKD-4U", "form, input, textarea"),
            ("BenchDetail", "/bench/DRvlSpKD-4U", ".detail-header"),
        ]
        for args in pages:
            measure(page, *args)
        browser.close()


if __name__ == "__main__":
    main()
