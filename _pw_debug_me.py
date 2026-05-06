"""me state debug — DOM 확인 + localStorage trace."""
import time
from playwright.sync_api import sync_playwright

URL = "https://reels-bench.vercel.app"
SC = "DTSMWNDkYql"


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(viewport={"width": 1400, "height": 900})
        page = ctx.new_page()

        # 1. Login
        page.goto(f"{URL}/login")
        page.wait_for_load_state("networkidle", timeout=15000)
        page.fill("input[type='text']", "admin")
        page.fill("input[type='password']", "123456")
        page.click("button[type='submit']")
        page.wait_for_url(f"{URL}/", timeout=15000)
        print("logged in")

        # 2. Visit /bench/SC once to populate cache
        page.goto(f"{URL}/bench/{SC}")
        page.wait_for_selector("button:has-text('DB에서 삭제')", timeout=15000)
        cached = page.evaluate("() => localStorage.getItem('cached_me')")
        print(f"\n[After visit 1] cached_me length: {len(cached) if cached else 0}")
        if cached:
            import json
            d = json.loads(cached)
            print(f"  role={d.get('role')}, can_delete_reels={d.get('can_delete_reels')}")

        # 3. Inject console traces, then reload
        page.add_init_script("""
            window.__renderLog = [];
            const origGetItem = localStorage.getItem.bind(localStorage);
            localStorage.getItem = function(k) {
                const v = origGetItem(k);
                if (k === 'cached_me') {
                    window.__renderLog.push({t: performance.now(), op: 'localStorage.getItem(cached_me)', val: v ? 'EXISTS' : 'NULL'});
                }
                return v;
            };
        """)

        # 4. Reload — fresh App mount
        print("\n[Reload — observe button timing]")
        t0 = time.time()
        page.reload(wait_until="domcontentloaded", timeout=20000)

        # Track when button appears
        page.wait_for_selector("h1", timeout=15000)
        t_h1 = (time.time() - t0) * 1000

        # Sample DOM every 50ms
        samples = []
        for _ in range(60):
            elapsed = (time.time() - t0) * 1000
            has_btn = page.locator("button:has-text('DB에서 삭제')").count() > 0
            samples.append((elapsed, has_btn))
            if has_btn and len(samples) > 5 and all(s[1] for s in samples[-3:]):
                break
            time.sleep(0.05)

        print(f"H1 ready at {t_h1:.0f}ms")
        first_btn = next((s[0] for s in samples if s[1]), None)
        print(f"Button first detected at {first_btn:.0f}ms" if first_btn else "Button NEVER appeared")

        # localStorage access log
        log = page.evaluate("() => window.__renderLog || []")
        print(f"\nlocalStorage.getItem calls: {len(log)}")
        for entry in log[:10]:
            print(f"  {entry['t']:.0f}ms: {entry['op']} -> {entry['val']}")

        # 5. Check React state via heuristic — inspect the rendered HTML for marker
        html_snapshot = page.content()
        has_btn_in_html = 'DB에서 삭제' in html_snapshot
        print(f"\n'DB에서 삭제' in current HTML: {has_btn_in_html}")

        browser.close()


if __name__ == "__main__":
    main()
