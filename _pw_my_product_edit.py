"""편집 페이지 동작 검증."""
import time
from pathlib import Path
from playwright.sync_api import sync_playwright

OUT = Path(__file__).parent / "_pw_screens"
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
        time.sleep(0.5)

        page.goto(f"{URL}/my-products")
        page.wait_for_selector("h1:has-text('내 상품')", timeout=10000)
        time.sleep(0.5)

        # 새 상품 버튼 → /my-products/new로 이동
        page.locator("button:has-text('+ 새 상품')").first.click()
        page.wait_for_url("**/my-products/new", timeout=8000)
        page.wait_for_selector("h1:has-text('새 상품')", timeout=8000)
        print(f"새 상품 진입 OK → {page.url}")
        page.screenshot(path=str(OUT / "edit_01_new.png"), full_page=True)

        # 뒤로
        page.locator("button:has-text('← 내 상품')").click()
        page.wait_for_url("**/my-products", timeout=5000)
        print("뒤로가기 OK")

        # 첫 카드의 수정 버튼 → /my-products/:id/edit
        first_edit = page.locator("button:has-text('수정')").first
        if first_edit.count() > 0:
            first_edit.click()
            page.wait_for_url("**/my-products/*/edit", timeout=8000)
            page.wait_for_selector("h1:has-text('상품 수정')", timeout=8000)
            # 제품명 input 채워졌는지 확인
            name_val = page.locator("input").first.input_value()
            print(f"수정 페이지 진입 OK → URL={page.url[:60]}, name='{name_val}'")
            page.screenshot(path=str(OUT / "edit_02_edit.png"), full_page=True)
        else:
            print("(수정 가능한 상품이 없어 수정 흐름 스킵)")

        browser.close()


if __name__ == "__main__":
    main()
