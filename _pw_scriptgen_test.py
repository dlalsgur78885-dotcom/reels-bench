"""ScriptGen Wizard 자동 테스트 — 노카라 잠옷 + DSHPniIkuMx."""
import time
from pathlib import Path
from playwright.sync_api import sync_playwright

URL = "https://reels-bench.vercel.app"
SHOTS = Path(__file__).parent / "_pw_screens"
SHOTS.mkdir(exist_ok=True)


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False, slow_mo=100)
        ctx = browser.new_context(viewport={"width": 1400, "height": 1000})
        page = ctx.new_page()

        # 1. 로그인
        page.goto(f"{URL}/login")
        page.wait_for_load_state("networkidle", timeout=15000)
        page.fill("input[type='text']", "admin")
        page.fill("input[type='password']", "123456")
        page.click("button[type='submit']")
        page.wait_for_url(f"{URL}/", timeout=15000)
        print("[1] 로그인 완료")

        # 2. /bench/DSHPniIkuMx — 분석 페이지
        page.goto(f"{URL}/bench/DSHPniIkuMx")
        page.wait_for_load_state("networkidle", timeout=15000)
        time.sleep(2)
        page.screenshot(path=str(SHOTS / "wizard_00_bench.png"), full_page=False)
        print("[2] Bench detail 진입")

        # 3. "이 릴스로 대본 만들기" 클릭 (대기 후)
        time.sleep(3)
        btn = page.locator("button").filter(has_text="대본 만들기").first
        is_disabled = btn.get_attribute("disabled")
        print(f"  버튼 disabled: {is_disabled}")
        if is_disabled is not None:
            # disabled면 직접 navigate
            page.goto(f"{URL}/script/new/DSHPniIkuMx")
        else:
            btn.click()
        time.sleep(2)
        page.wait_for_url(f"{URL}/script/new/DSHPniIkuMx", timeout=10000)
        page.wait_for_load_state("networkidle", timeout=15000)
        time.sleep(2)
        page.screenshot(path=str(SHOTS / "wizard_01_product.png"), full_page=True)
        print("[3] Wizard step 1 (product picker)")

        # 4. 노카라 잠옷 선택
        prod_btn = page.locator("button").filter(has_text="노카라 잠옷").first
        prod_btn.click()
        time.sleep(2)
        print("[4] 노카라 잠옷 선택 → mapping step")

        # 5. mapping 로드 대기 (Gemini 호출 ~10-30s)
        t0 = time.time()
        while time.time() - t0 < 90:
            if page.locator("text=2단계 — 매핑 리뷰").count() > 0 and page.locator("text=ref USP").count() > 0:
                print(f"  → 매핑 도착 ({time.time() - t0:.0f}s)")
                break
            time.sleep(2)
        time.sleep(2)
        page.screenshot(path=str(SHOTS / "wizard_02_mapping.png"), full_page=True)

        # 매핑 텍스트 추출
        mapping_panel = page.locator("text=매핑 리뷰").locator("xpath=../..")
        if mapping_panel.count():
            print("\n=== 매핑 리뷰 ===")
            print(mapping_panel.first.inner_text()[:3000])

        # 6. "페르소나 선택 →" 클릭
        next_btn = page.locator("button").filter(has_text="페르소나 선택").first
        if next_btn.count():
            next_btn.click()
            time.sleep(2)
            page.wait_for_load_state("networkidle", timeout=10000)
            page.screenshot(path=str(SHOTS / "wizard_03_persona.png"), full_page=True)
            print("[6] Persona step 진입")

            # 7. 페르소나 0개로 진행 (자동 추론) — 대본 생성 클릭
            gen_btn = page.locator("button").filter(has_text="대본 생성").first
            if gen_btn.count():
                gen_btn.click()
                print("[7] 대본 생성 클릭")
                # 생성 대기 (60-180s)
                t0 = time.time()
                while time.time() - t0 < 240:
                    if page.locator("text=생성된 대본").count() > 0:
                        print(f"  → 생성 완료 ({time.time() - t0:.0f}s)")
                        break
                    if int(time.time() - t0) % 20 == 0:
                        print(f"  ... 대기 {int(time.time() - t0)}s")
                    time.sleep(2)
                time.sleep(3)
                page.screenshot(path=str(SHOTS / "wizard_04_done.png"), full_page=True)

                # 결과 텍스트
                result_panel = page.locator("text=생성된 대본").locator("xpath=../..").first
                if result_panel.count():
                    print("\n=== 생성된 대본 ===")
                    print(result_panel.inner_text()[:2500])
            else:
                print("  ✗ 대본 생성 버튼 없음")
        else:
            print("  ✗ 페르소나 선택 버튼 없음 — 매핑이 안 떴을 수 있음")

        time.sleep(3)
        browser.close()


if __name__ == "__main__":
    main()
