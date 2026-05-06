"""channels 페이지 응답 시간."""
import time
from playwright.sync_api import sync_playwright

URL = "https://reels-bench.vercel.app"


def measure(page, label):
    timings = []
    failures = []
    page.on("response", lambda r: timings.append({"url": r.url, "status": r.status, "t": time.time()}) if "/api/" in r.url else None)
    page.on("requestfailed", lambda r: failures.append({"url": r.url, "error": r.failure}) if "/api/" in r.url else None)
    timings.clear()

    t0 = time.time()
    page.goto(f"{URL}/channels", wait_until="domcontentloaded")
    # H1 노출 시점 + 마지막 fetch 응답 시점 분리 측정
    page.wait_for_selector("h1", timeout=10000)
    t_h1 = (time.time() - t0) * 1000
    # 채널 카드 또는 empty state 노출 시점
    deadline = time.time() + 12
    t_content = None
    while time.time() < deadline:
        if page.locator(".channel-select, .empty-note").count() > 0:
            t_content = (time.time() - t0) * 1000
            break
        time.sleep(0.04)
    # 마지막 API 응답 대기 (네트워크 idle)
    try:
        page.wait_for_load_state("networkidle", timeout=10000)
    except: pass
    t_idle = (time.time() - t0) * 1000
    print(f"[{label}] H1={t_h1:.0f}ms, 채널카드={t_content:.0f}ms, networkidle={t_idle:.0f}ms" if t_content else f"[{label}] H1={t_h1:.0f}ms, content NOT shown, idle={t_idle:.0f}ms")

    # API 호출 시간
    seen = set()
    for ev in timings:
        path = ev["url"].split("?")[0].split(URL)[-1]
        if path not in seen:
            seen.add(path)
    api_count = len([t for t in timings if "/api/" in t["url"]])
    print(f"  API calls: {api_count}")
    for ev in timings:
        print(f"    {ev['status']} {ev['url'].split('/api/')[-1][:120]}")
    for ev in failures:
        print(f"    FAILED {ev['url'].split('/api/')[-1][:120]} {ev['error']}")
    return t_h1


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(viewport={"width": 1400, "height": 900})
        page = ctx.new_page()

        page.goto(f"{URL}/login")
        page.wait_for_load_state("networkidle", timeout=15000)
        page.fill("input[type='text']", "admin")
        page.fill("input[type='password']", "123456")
        page.click("button[type='submit']")
        page.wait_for_url(f"{URL}/", timeout=15000)
        # cached_me 채워질 때까지
        for _ in range(80):
            if page.evaluate("() => localStorage.getItem('cached_me')"): break
            time.sleep(0.1)

        for trial in range(3):
            print(f"\n=== Trial {trial+1} ===")
            measure(page, f"Trial {trial+1}")
            time.sleep(0.3)

        browser.close()


if __name__ == "__main__":
    main()
