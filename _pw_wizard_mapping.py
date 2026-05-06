"""Wizard 매핑 단계 캡처."""
import time
from pathlib import Path
from playwright.sync_api import sync_playwright

URL = "https://reels-bench.vercel.app"
SHOTS = Path(__file__).parent / "_pw_screens"
SHOTS.mkdir(exist_ok=True)
sc = "DViGmzBEjnc"


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False, slow_mo=100)
        ctx = browser.new_context(viewport={"width": 1500, "height": 1100})
        # 캐시 무시
        ctx.set_extra_http_headers({"Cache-Control": "no-cache"})
        page = ctx.new_page()

        page.goto(f"{URL}/login")
        page.wait_for_load_state("networkidle", timeout=15000)
        page.fill("input[type='text']", "admin")
        page.fill("input[type='password']", "123456")
        page.click("button[type='submit']")
        page.wait_for_url(f"{URL}/", timeout=15000)

        # wizard 진입
        page.goto(f"{URL}/script/new/{sc}")
        page.wait_for_load_state("networkidle", timeout=15000)
        time.sleep(2)

        # 노카라 잠옷 선택
        page.locator("button").filter(has_text="노카라 잠옷").first.click()
        time.sleep(2)

        # 매핑 로드 대기 (최대 90s)
        t0 = time.time()
        while time.time() - t0 < 90:
            if page.locator("text=매핑 리뷰").count() > 0 and page.locator("text=ref USP").count() > 0:
                print(f"매핑 도착 ({time.time() - t0:.0f}s)")
                break
            time.sleep(2)
        time.sleep(2)

        # 여러 viewport 캡처 (chunks 많으니까)
        page.evaluate("window.scrollTo(0, 0)")
        time.sleep(1)
        page.screenshot(path=str(SHOTS / "wizard_map_v1.png"), full_page=False)
        page.evaluate("window.scrollTo(0, 1100)")
        time.sleep(1)
        page.screenshot(path=str(SHOTS / "wizard_map_v2.png"), full_page=False)
        page.evaluate("window.scrollTo(0, 2200)")
        time.sleep(1)
        page.screenshot(path=str(SHOTS / "wizard_map_v3.png"), full_page=False)
        page.evaluate("window.scrollTo(0, 3300)")
        time.sleep(1)
        page.screenshot(path=str(SHOTS / "wizard_map_v4.png"), full_page=False)
        # full
        page.screenshot(path=str(SHOTS / "wizard_map_full.png"), full_page=True)
        print("4 viewport + full saved")
        time.sleep(2)
        browser.close()


if __name__ == "__main__":
    main()
