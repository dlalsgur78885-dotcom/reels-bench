"""미매칭 자리에서 새 USP 만들기 버튼 동작 확인."""
import time
from pathlib import Path
from playwright.sync_api import sync_playwright

URL = "https://reels-bench.vercel.app"
SHOTS = Path(__file__).parent / "_pw_screens"
SHOTS.mkdir(exist_ok=True)
sc = "DViGmzBEjnc"


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False, slow_mo=150)
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

        # 매핑 도착 대기
        t0 = time.time()
        while time.time() - t0 < 90:
            if page.locator("text=ref USP").count() > 0:
                break
            time.sleep(2)
        time.sleep(2)

        # "+ 새 USP 만들기" 버튼 찾아서 클릭
        create_btn = page.locator("button").filter(has_text="새 USP 만들기").first
        if create_btn.count():
            create_btn.scroll_into_view_if_needed()
            time.sleep(1)
            create_btn.click()
            time.sleep(1)
            page.screenshot(path=str(SHOTS / "create_usp_form.png"), full_page=False)
            print("폼 열림 → 캡처")

            # 폼 채우기
            page.locator("input[placeholder*='USP 이름']").first.fill("테스트 USP")
            page.locator("textarea[placeholder*='리뷰']").first.fill("리뷰1\n리뷰2\n리뷰3")
            time.sleep(1)
            page.screenshot(path=str(SHOTS / "create_usp_filled.png"), full_page=False)

            # 저장 클릭
            save = page.locator("button").filter(has_text="저장 + 매핑").first
            if save.count():
                save.click()
                print("저장 클릭")
                time.sleep(5)  # DB 저장 + 매핑 갱신
                page.screenshot(path=str(SHOTS / "create_usp_after.png"), full_page=False)
                # full_page도 캡처해서 USP 추가됐는지 확인
                page.screenshot(path=str(SHOTS / "create_usp_full.png"), full_page=True)
        else:
            print("⚠ '+ 새 USP 만들기' 버튼 못 찾음")

        time.sleep(2)
        browser.close()


if __name__ == "__main__":
    main()
