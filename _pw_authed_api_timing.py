import statistics
import time
from playwright.sync_api import sync_playwright

URL = "https://reels-bench.vercel.app"


def login(page):
    page.goto(f"{URL}/login", wait_until="domcontentloaded", timeout=20000)
    page.fill("input[type='text']", "admin")
    page.fill("input[type='password']", "123456")
    page.click("button[type='submit']")
    page.wait_for_url(f"{URL}/", timeout=20000)


def time_request(page, path, n=5):
    rows = []
    for _ in range(n):
        row = page.evaluate(
            """async (path) => {
                const t0 = performance.now();
                const res = await fetch(path, { credentials: 'include' });
                const text = await res.text();
                return { ms: performance.now() - t0, status: res.status, size: text.length };
            }""",
            path,
        )
        rows.append((row["ms"], row["status"], row["size"]))
        time.sleep(0.15)
    times = [r[0] for r in rows]
    return {
        "status": rows[-1][1],
        "min": min(times),
        "avg": statistics.mean(times),
        "max": max(times),
        "size": rows[-1][2],
        "rows": rows,
    }


def main():
    endpoints = [
        "/api/me",
        "/api/bench?page=1&limit=50&sort=plays",
        "/api/phrases",
        "/api/channels",
        "/api/my-products",
        "/api/detail/DRvlSpKD-4U",
        "/api/users/drinklowball/analysis?limit=36",
    ]
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(viewport={"width": 1400, "height": 900})
        page = ctx.new_page()
        login(page)
        for ep in endpoints:
            try:
                r = time_request(page, ep)
                seq = ", ".join(f"{ms:.0f}" for ms, _, _ in r["rows"])
                print(f"{ep}")
                print(f"  HTTP {r['status']} min={r['min']:.0f}ms avg={r['avg']:.0f}ms max={r['max']:.0f}ms size={r['size']/1024:.1f}KB")
                print(f"  seq={seq}")
            except Exception as e:
                print(f"{ep}\n  ERROR {e}")
        browser.close()


if __name__ == "__main__":
    main()
