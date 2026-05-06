"""삭제 버튼 노출 타이밍 검증 -admin 로그인 후 /bench/X에서 H1과 버튼 출현 시점 비교."""
import time
from pathlib import Path
from playwright.sync_api import sync_playwright

OUT = Path(__file__).parent / "_pw_screens"
OUT.mkdir(exist_ok=True)

URL = "https://reels-bench.vercel.app"
SC = "DTSMWNDkYql"
ID = "admin"
PW = "123456"


def measure_btn(page, label: str):
    print(f"\n[{label}] /bench/{SC} 진입")
    t0 = time.time()
    page.goto(f"{URL}/bench/{SC}", wait_until="domcontentloaded", timeout=30000)
    t_dom = (time.time() - t0) * 1000

    # H1 (작성자 또는 shortcode) 출현 시점
    page.wait_for_selector("h1", timeout=15000)
    t_h1 = (time.time() - t0) * 1000

    # "DB에서 삭제" 버튼 출현 시점
    btn_visible_at = None
    deadline = time.time() + 15
    while time.time() < deadline:
        try:
            count = page.locator("button:has-text('DB에서 삭제')").count()
            if count > 0:
                btn_visible_at = (time.time() - t0) * 1000
                break
        except Exception:
            pass
        time.sleep(0.05)

    if btn_visible_at is None:
        print(f"  DOMContentLoaded={t_dom:.0f}ms, H1={t_h1:.0f}ms, 버튼=NOT FOUND in 15s")
    else:
        delta = btn_visible_at - t_h1
        print(f"  DOMContentLoaded={t_dom:.0f}ms, H1={t_h1:.0f}ms, 버튼={btn_visible_at:.0f}ms")
        print(f"  → H1 → 버튼 지연: {delta:.0f}ms")
    return btn_visible_at, t_h1


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(viewport={"width": 1400, "height": 900})
        page = ctx.new_page()

        # 1. 로그인
        print("[Login]")
        page.goto(f"{URL}/login", wait_until="networkidle", timeout=20000)
        page.fill("input[placeholder*='아이디']", ID) if page.locator("input[placeholder*='아이디']").count() else page.fill("input[type='text']", ID)
        page.fill("input[type='password']", PW)
        page.click("button[type='submit']")
        page.wait_for_url(f"{URL}/", timeout=15000)
        print("  로그인 성공")
        page.screenshot(path=str(OUT / "del_00_after_login.png"))

        # 2. 홈에서 /bench/SC로 이동 (네비게이션 -context 캐시 사용)
        measure_btn(page, "1차 진입 (캐시 없을 수 있음)")
        page.screenshot(path=str(OUT / "del_01_first_visit.png"))

        # 3. 다른 페이지 갔다가 다시 -context me는 살아있음
        page.goto(f"{URL}/bench", wait_until="domcontentloaded", timeout=20000)
        time.sleep(0.5)
        measure_btn(page, "2차 -페이지 전환 (App 살아있음, useMe 즉시)")
        page.screenshot(path=str(OUT / "del_02_navigation.png"))

        # 4. 새로고침 (App 재마운트, localStorage 캐시 사용)
        print("\n[3차] 하드 새로고침")
        t0 = time.time()
        page.reload(wait_until="domcontentloaded", timeout=20000)
        page.wait_for_selector("h1", timeout=15000)
        t_h1 = (time.time() - t0) * 1000
        btn_visible_at = None
        deadline = time.time() + 15
        while time.time() < deadline:
            if page.locator("button:has-text('DB에서 삭제')").count() > 0:
                btn_visible_at = (time.time() - t0) * 1000
                break
            time.sleep(0.05)
        if btn_visible_at is None:
            print(f"  H1={t_h1:.0f}ms, 버튼=NOT FOUND")
        else:
            print(f"  H1={t_h1:.0f}ms, 버튼={btn_visible_at:.0f}ms (지연 {btn_visible_at - t_h1:.0f}ms)")
        page.screenshot(path=str(OUT / "del_03_reload.png"))

        # 5. localStorage 상태 확인
        cached = page.evaluate("() => localStorage.getItem('cached_me')")
        print(f"\n[localStorage] cached_me 길이: {len(cached) if cached else 0}")
        if cached:
            import json
            d = json.loads(cached)
            print(f"  role={d.get('role')}, can_delete_reels={d.get('can_delete_reels')}")

        browser.close()


if __name__ == "__main__":
    main()
