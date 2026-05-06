"""Verify BODY_N badges show on bench detail page."""
from playwright.sync_api import sync_playwright

URL = "https://reels-bench.vercel.app"
SC = "DSSR8rEk0b6"


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(viewport={"width": 1400, "height": 900})
        page = ctx.new_page()

        # Login
        page.goto(f"{URL}/login")
        page.wait_for_load_state("networkidle", timeout=15000)
        page.fill("input[type='text']", "admin")
        page.fill("input[type='password']", "123456")
        page.click("button[type='submit']")
        page.wait_for_url(f"{URL}/", timeout=15000)
        print("logged in")

        # Capture console + network errors
        errors: list[str] = []
        api_responses: list[str] = []
        page.on("console", lambda msg: errors.append(f"[{msg.type}] {msg.text}") if msg.type in ("error", "warning") else None)
        page.on("pageerror", lambda exc: errors.append(f"[pageerror] {exc}"))
        def on_response(resp):
            if "/api/" in resp.url:
                api_responses.append(f"{resp.status} {resp.url[:80]}")
        page.on("response", on_response)

        # Go to bench detail
        page.goto(f"{URL}/bench/{SC}")
        page.wait_for_load_state("networkidle", timeout=20000)
        page.wait_for_timeout(2000)
        # Click "대본 분석" tab
        page.click("button:has-text('대본 분석')")
        page.wait_for_timeout(3000)
        page.screenshot(path="_pw_screens/before_verify.png", full_page=True)
        html = page.content()
        with open("_pw_screens/before_verify.html", "w", encoding="utf-8") as f:
            f.write(html)
        print(f"html len after wait: {len(html)}")
        if errors:
            print("=== console errors ===")
            for e in errors[:10]: print(" ", e)
        if api_responses:
            print("=== api responses ===")
            for r in api_responses[:15]: print(" ", r)
        # Try .section-badge instead
        try:
            page.wait_for_selector(".section-badge", timeout=10000)
        except Exception as e:
            print(f"no section-badge: {e}")
            # Dump page HTML
            html = page.content()
            print(f"page len: {len(html)}")
            print("BODY in html:", html.count("BODY"))
            print("body in html:", html.count("body"))
            print("section-badge in html:", html.count("section-badge"))
            print("sentence-row in html:", html.count("sentence-row"))
            return

        # Force refresh (click 새로고침 button if exists)
        try:
            page.click("button:has-text('새로고침')", timeout=5000)
            page.wait_for_timeout(2000)
            print("clicked 새로고침")
        except Exception as e:
            print(f"no 새로고침 button: {e}")

        # Read all section badges
        rows = page.locator(".sentence-row").all()
        print(f"\n=== {len(rows)} sentence rows ===")
        for i, row in enumerate(rows):
            try:
                time_text = row.locator(".sentence-time").inner_text(timeout=2000)
            except Exception:
                time_text = ""
            try:
                section = row.locator(".section-badge").inner_text(timeout=1000)
            except Exception:
                section = "(no badge)"
            try:
                text = row.locator(".sentence-text").inner_text(timeout=2000)
                text = text[:60]
            except Exception:
                text = ""
            print(f"  [{time_text}] {section} | {text}")

        # Screenshot
        page.screenshot(path="_pw_screens/verify_body_n.png", full_page=True)
        print("\nscreenshot saved")
        browser.close()


if __name__ == "__main__":
    main()
