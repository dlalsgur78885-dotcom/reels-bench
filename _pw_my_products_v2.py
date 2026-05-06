"""my-products SWR 캐시 효과 검증."""
import time
from playwright.sync_api import sync_playwright

URL = "https://reels-bench.vercel.app"


def measure_visit(page, label):
    t0 = time.time()
    page.goto(f"{URL}/my-products")
    page.wait_for_load_state("domcontentloaded", timeout=15000)

    # 카드 또는 empty state 둘 중 하나라도 뜨면 시각적으로 완료
    visible_at = None
    deadline = time.time() + 12
    while time.time() < deadline:
        has_card = page.locator(".page-header + div + div > div, [style*='grid-template-columns']").count() > 0
        has_empty = page.locator("div:has-text('등록된 상품이 없습니다')").count() > 0
        # subtitle에 카운트 또는 '불러오는 중' 외 텍스트?
        sub = page.locator(".page-header p").first.text_content() or ""
        if "개" in sub and "불러오는" not in sub:
            visible_at = (time.time() - t0) * 1000
            break
        if has_card or has_empty:
            visible_at = (time.time() - t0) * 1000
            break
        time.sleep(0.04)

    print(f"[{label}] 콘텐츠 노출까지 {visible_at:.0f}ms" if visible_at else f"[{label}] 12s 내 노출 안 됨")
    return visible_at


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

        measure_visit(page, "1차 (캐시 없음, cold 가능)")
        # 다른 페이지 갔다가
        page.goto(f"{URL}/bench")
        page.wait_for_load_state("domcontentloaded", timeout=10000)
        time.sleep(0.5)
        measure_visit(page, "2차 (sessionStorage 캐시 살아있음)")
        # 새로고침
        page.reload(wait_until="domcontentloaded")
        page.wait_for_load_state("domcontentloaded", timeout=10000)
        # /my-products로 직접
        measure_visit(page, "3차 (다시 진입)")

        browser.close()


if __name__ == "__main__":
    main()
