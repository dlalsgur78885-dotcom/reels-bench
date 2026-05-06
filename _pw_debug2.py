"""localStorage 상태 변화 추적."""
import time
from playwright.sync_api import sync_playwright

URL = "https://reels-bench.vercel.app"
SC = "DTSMWNDkYql"


def dump_localstorage(page, label):
    data = page.evaluate("""() => {
        const out = {};
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            const v = localStorage.getItem(k);
            out[k] = v ? v.slice(0, 80) + (v.length > 80 ? '...' : '') : null;
        }
        return out;
    }""")
    print(f"\n[{label}] localStorage keys ({len(data)}):")
    for k, v in data.items():
        print(f"  {k}: {v}")


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

        # 2. Visit and populate cache
        page.goto(f"{URL}/bench/{SC}")
        page.wait_for_selector("button:has-text('DB에서 삭제')", timeout=15000)
        dump_localstorage(page, "After visit 1, button visible")

        # 3. Reload
        print("\n>>> Reloading...")
        page.reload(wait_until="domcontentloaded")
        # Right after DCL, before any JS initialization completes
        dump_localstorage(page, "After reload, DCL")

        # Wait for app to mount
        try:
            page.wait_for_selector("h1", timeout=10000)
            dump_localstorage(page, "After H1 visible")
        except:
            pass

        # Wait for button
        try:
            page.wait_for_selector("button:has-text('DB에서 삭제')", timeout=10000)
            dump_localstorage(page, "After delete button visible")
        except:
            print("  delete button never appeared")

        browser.close()


if __name__ == "__main__":
    main()
