"""페르소나 단계에서 pain/desire 표시 확인."""
import time
from pathlib import Path
from playwright.sync_api import sync_playwright

URL = "https://reels-bench.vercel.app"
SHOTS = Path(__file__).parent / "_pw_screens"
SHOTS.mkdir(exist_ok=True)
sc = "DViGmzBEjnc"


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False, slow_mo=120)
        ctx = browser.new_context(viewport={"width": 1500, "height": 1100})
        ctx.set_extra_http_headers({"Cache-Control": "no-cache"})
        page = ctx.new_page()

        page.goto(f"{URL}/login")
        page.wait_for_load_state("networkidle", timeout=15000)
        page.fill("input[type='text']", "admin")
        page.fill("input[type='password']", "123456")
        page.click("button[type='submit']")
        page.wait_for_url(f"{URL}/", timeout=15000)

        page.goto(f"{URL}/script/new/{sc}")
        page.wait_for_load_state("networkidle", timeout=15000)
        time.sleep(2)
        page.locator("button").filter(has_text="노카라 잠옷").first.click()
        time.sleep(2)

        # mapping 도착 대기
        t0 = time.time()
        while time.time() - t0 < 90:
            if page.locator("text=ref USP").count() > 0:
                break
            time.sleep(2)
        time.sleep(2)

        # "페르소나 선택 →" 클릭
        page.locator("button").filter(has_text="페르소나 선택").first.click()
        print("페르소나 단계 진입")

        # 재추출 대기 (최대 180s)
        t0 = time.time()
        while time.time() - t0 < 180:
            if page.locator("text=재추출").count() == 0 and page.locator("text=pain").count() > 0:
                print(f"  재추출 완료 ({time.time() - t0:.0f}s)")
                break
            time.sleep(3)
        time.sleep(2)
        page.screenshot(path=str(SHOTS / "persona_pd_full.png"), full_page=True)
        page.evaluate("window.scrollTo(0, 0)")
        time.sleep(1)
        page.screenshot(path=str(SHOTS / "persona_pd_v1.png"), full_page=False)
        print("저장 완료")
        time.sleep(2)
        browser.close()


if __name__ == "__main__":
    main()
