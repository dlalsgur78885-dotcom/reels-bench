"""테스트: section rename + USP override → 페르소나 반영 검증."""
import time
from pathlib import Path
from playwright.sync_api import sync_playwright

URL = "https://reels-bench.vercel.app"
SHOTS = Path(__file__).parent / "_pw_screens"
SHOTS.mkdir(exist_ok=True)
sc = "DWYbUQXkQKS"


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False, slow_mo=200)
        ctx = browser.new_context(viewport={"width": 1500, "height": 1100})
        ctx.set_extra_http_headers({"Cache-Control": "no-cache"})
        page = ctx.new_page()

        page.goto(f"{URL}/login")
        page.wait_for_load_state("networkidle", timeout=15000)
        page.fill("input[type='text']", "admin")
        page.fill("input[type='password']", "123456")
        page.click("button[type='submit']")
        page.wait_for_url(f"{URL}/", timeout=15000)
        print("[1] login")

        page.goto(f"{URL}/script/new/{sc}")
        page.wait_for_load_state("networkidle", timeout=15000)
        time.sleep(2)
        page.locator("button").filter(has_text="C멤버십").first.click()
        time.sleep(2)
        print("[2] product picked: C멤버십")

        # mapping 도착 대기
        t0 = time.time()
        while time.time() - t0 < 90:
            if page.locator("text=ref USP").count() > 0:
                break
            time.sleep(2)
        time.sleep(2)
        print(f"[3] mapping ready ({time.time()-t0:.0f}s)")
        page.screenshot(path=str(SHOTS / "ovd_01_mapping_initial.png"), full_page=True)

        # 첫 번째 body chunk의 section을 body_5로 변경 (편집 버튼 → section input)
        edit_btns = page.locator("button").filter(has_text="분석 수정")
        n_edit = edit_btns.count()
        print(f"[4] 분석 수정 버튼 {n_edit}개")
        if n_edit > 0:
            edit_btns.first.click()
            time.sleep(1)
            # 섹션 input (placeholder "섹션")
            sec_input = page.locator("input[placeholder*='섹션']").first
            if sec_input.count():
                cur = sec_input.input_value()
                print(f"  현재 section: {cur}")
                sec_input.fill("body_99")
                time.sleep(0.5)
            # 다시 버튼 클릭해서 닫기 (저장)
            edit_btns.first.click()
            time.sleep(1)
            print("[5] section을 body_99로 변경")

        # USP dropdown 변경 — 두 번째 body chunk를 다른 USP로
        selects = page.locator("select").filter(has=page.locator("option", has_text="매핑 없음"))
        n_sel = selects.count()
        print(f"  chunk USP dropdown {n_sel}개")
        if n_sel > 1:
            # 두번째 body chunk dropdown
            sel = selects.nth(1)
            opts = sel.locator("option")
            opts_count = opts.count()
            # 마지막 USP option 선택
            if opts_count > 1:
                last_opt = opts.nth(opts_count - 1).get_attribute("value")
                if last_opt and last_opt != "":
                    sel.select_option(value=last_opt)
                    print(f"[6] body_2 chunk → USP{last_opt}로 override")
                    time.sleep(1)

        page.screenshot(path=str(SHOTS / "ovd_02_after_edits.png"), full_page=True)

        # 페르소나 단계로
        page.locator("button").filter(has_text="페르소나 선택").first.click()
        print("[7] 페르소나 단계로 진입")
        # 페르소나 재추출 대기
        t0 = time.time()
        while time.time() - t0 < 120:
            if page.locator("text=재추출").count() == 0:
                break
            time.sleep(3)
        time.sleep(3)
        page.screenshot(path=str(SHOTS / "ovd_03_persona.png"), full_page=True)
        print(f"[8] 페르소나 도착 ({time.time()-t0:.0f}s)")

        # 매칭된 USP 목록 텍스트 추출
        matched_card = page.locator("text=매칭된 USP — 페르소나 보유 현황").locator("xpath=..")
        if matched_card.count():
            print("\n=== 매칭된 USP ===")
            print(matched_card.first.inner_text()[:1000])

        time.sleep(3)
        browser.close()


if __name__ == "__main__":
    main()
