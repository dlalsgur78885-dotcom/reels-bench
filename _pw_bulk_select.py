"""다중 선택 UX 검증 — 선택 버튼/체크 오버레이/액션바 확인 (실제 삭제는 안 함)."""
from pathlib import Path
from playwright.sync_api import sync_playwright

OUT = Path(__file__).parent / "_pw_screens"
OUT.mkdir(exist_ok=True)

URL = "https://reels-bench.vercel.app"


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
        print("logged in")

        page.goto(f"{URL}/bench")
        page.wait_for_selector(".reel-grid .reel-card", timeout=15000)

        # 선택 버튼 존재 확인
        select_btn = page.locator("button:has-text('선택')").first
        assert select_btn.count() > 0, "선택 버튼 안 보임"
        select_btn.click()
        page.wait_for_selector("button:has-text('이 페이지 전체')", timeout=5000)
        print("선택 모드 진입 OK")
        page.screenshot(path=str(OUT / "bulk_01_select_mode.png"), full_page=False)

        # 카드 3개 클릭해서 선택
        cards = page.locator(".reel-grid .reel-card").all()
        for c in cards[:3]:
            c.click()
        # 선택 카운트
        count_text = page.locator("span:has-text('개 선택')").first.text_content()
        print(f"카운트: {count_text}")
        assert "3개 선택" in (count_text or ""), f"3개 선택 안 됨: {count_text}"

        # 삭제 버튼 텍스트 확인
        del_btn_text = page.locator("button:has-text('삭제 (')").first.text_content()
        print(f"삭제 버튼: {del_btn_text}")
        page.screenshot(path=str(OUT / "bulk_02_three_selected.png"), full_page=False)

        # 페이지 전체 선택
        page.locator("button:has-text('이 페이지 전체')").first.click()
        count_text = page.locator("span:has-text('개 선택')").first.text_content()
        print(f"전체 선택 후 카운트: {count_text}")
        page.screenshot(path=str(OUT / "bulk_03_all_selected.png"), full_page=False)

        # 취소
        page.locator("button:has-text('취소')").first.click()
        # 선택 모드 종료 확인
        assert page.locator("button:has-text('이 페이지 전체')").count() == 0
        print("취소 OK")

        browser.close()


if __name__ == "__main__":
    main()
