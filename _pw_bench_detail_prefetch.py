import time
from playwright.sync_api import sync_playwright

URL = "https://reels-bench.vercel.app"


def login(page):
    page.goto(f"{URL}/login", wait_until="domcontentloaded", timeout=20000)
    page.fill("input[type='text']", "admin")
    page.fill("input[type='password']", "123456")
    page.click("button[type='submit']")
    page.wait_for_url(f"{URL}/", timeout=20000)


def wait_detail_ready(page, t0):
    page.wait_for_selector(".detail-header", timeout=20000)
    page.wait_for_function(
        """() => {
            const values = Array.from(document.querySelectorAll('.kpi-value')).map(el => el.textContent || '');
            return values.some(v => v.trim() && v.trim() !== '0' && v.trim() !== '0초');
        }""",
        timeout=20000,
    )
    return (time.time() - t0) * 1000


def measure_direct(browser, shortcode):
    ctx = browser.new_context(viewport={"width": 1400, "height": 900})
    page = ctx.new_page()
    login(page)
    api_calls = []
    page.on("response", lambda r: api_calls.append((r.status, r.url)) if "/api/" in r.url else None)
    t0 = time.time()
    with page.expect_response(lambda r: f"/api/detail/{shortcode}" in r.url, timeout=20000) as resp_info:
        page.goto(f"{URL}/bench/{shortcode}", wait_until="domcontentloaded", timeout=20000)
    detail_resp = resp_info.value
    ready = wait_detail_ready(page, t0)
    detail_calls = [u for _, u in api_calls if "/api/detail/" in u]
    ctx.close()
    return ready, len(detail_calls), detail_resp.status, api_calls


def measure_hover_prefetch(browser):
    ctx = browser.new_context(viewport={"width": 1400, "height": 900})
    page = ctx.new_page()
    login(page)
    page.goto(f"{URL}/bench", wait_until="domcontentloaded", timeout=20000)
    page.wait_for_selector(".reel-card", timeout=20000)
    first = page.locator(".reel-card").first

    prefetch_start = time.time()
    with page.expect_response(lambda r: "/api/detail/" in r.url, timeout=20000) as resp_info:
        first.hover()
    resp = resp_info.value
    prefetch_ms = (time.time() - prefetch_start) * 1000
    shortcode = resp.url.rsplit("/", 1)[-1]

    t0 = time.time()
    first.click()
    ready = wait_detail_ready(page, t0)
    ctx.close()
    return shortcode, prefetch_ms, resp.status, ready


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)

        shortcode, prefetch_ms, status, click_ready = measure_hover_prefetch(browser)
        print(f"hover_prefetch_shortcode={shortcode}")
        print(f"hover_prefetch_api={prefetch_ms:.0f}ms status={status}")
        print(f"click_to_detail_ready_after_prefetch={click_ready:.0f}ms")

        direct_ready, detail_call_count, detail_status, api_calls = measure_direct(browser, shortcode)
        print(f"direct_detail_ready={direct_ready:.0f}ms")
        print(f"direct_detail_status={detail_status}")
        print(f"direct_detail_api_calls={detail_call_count}")
        print("direct_api_calls=" + ",".join(u.split('/api/', 1)[-1].split('?', 1)[0] for _, u in api_calls if "/api/" in u))

        browser.close()


if __name__ == "__main__":
    main()
