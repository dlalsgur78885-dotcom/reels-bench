"""Bench detail에서 section_chunks UI 캡처."""
import time
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright

URL = "https://reels-bench.vercel.app"
SHOTS = Path(__file__).parent / "_pw_screens"
SHOTS.mkdir(exist_ok=True)

sc = sys.argv[1] if len(sys.argv) > 1 else "DViGmzBEjnc"


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False, slow_mo=100)
        ctx = browser.new_context(viewport={"width": 1500, "height": 1100})
        page = ctx.new_page()

        page.goto(f"{URL}/login")
        page.wait_for_load_state("networkidle", timeout=15000)
        page.fill("input[type='text']", "admin")
        page.fill("input[type='password']", "123456")
        page.click("button[type='submit']")
        page.wait_for_url(f"{URL}/", timeout=15000)

        page.goto(f"{URL}/bench/{sc}")
        page.wait_for_load_state("networkidle", timeout=20000)
        time.sleep(3)

        # script 탭 클릭
        script_tab = page.locator("button.tab").filter(has_text="대본 분석").first
        if script_tab.count():
            script_tab.click()
            time.sleep(2)

        # 섹션별 chunk 상세 영역 찾아 거기서부터 스크린샷
        chunk_section = page.locator("text=섹션별 상세").first
        if chunk_section.count():
            chunk_section.scroll_into_view_if_needed()
            time.sleep(1)
            # chunk 패널 자체 캡처
            chunk_section.locator("xpath=ancestor::*[contains(@class, 'section-card') or contains(@class, 'detail')][1]").first.screenshot(path=str(SHOTS / f"chunks_{sc}_panel.png"))
        # 그리고 위에서 부터 보이는 영역 (1500x1100)
        page.evaluate("window.scrollTo(0, 800)")
        time.sleep(1)
        page.screenshot(path=str(SHOTS / f"chunks_{sc}_view1.png"), full_page=False)
        page.evaluate("window.scrollTo(0, 1600)")
        time.sleep(1)
        page.screenshot(path=str(SHOTS / f"chunks_{sc}_view2.png"), full_page=False)
        page.evaluate("window.scrollTo(0, 2400)")
        time.sleep(1)
        page.screenshot(path=str(SHOTS / f"chunks_{sc}_view3.png"), full_page=False)
        print(f"saved: 3 viewport shots")

        time.sleep(2)
        browser.close()


if __name__ == "__main__":
    main()
