"""2 페르소나 동시 생성 디버그 — console.log 캡처 + 결과 tab 확인."""
import sys
import io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

import time
import re
from pathlib import Path
from playwright.sync_api import sync_playwright

URL = "https://reels-bench.vercel.app"
SHOTS = Path(__file__).parent / "_pw_screens"
SHOTS.mkdir(exist_ok=True)

console_logs: list[str] = []


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False, slow_mo=50)
        ctx = browser.new_context(viewport={"width": 1400, "height": 1000})
        page = ctx.new_page()

        # console.log 캡처
        def on_console(msg):
            try:
                txt = f"[{msg.type}] {msg.text}"
                console_logs.append(txt)
                if "[script/gen]" in msg.text or "FAILED" in msg.text or "OK" in msg.text:
                    print(f"  CONSOLE: {txt[:300]}")
            except Exception:
                pass
        page.on("console", on_console)

        # 1. 로그인
        page.goto(f"{URL}/login")
        page.wait_for_load_state("networkidle", timeout=15000)
        page.fill("input[type='text']", "admin")
        page.fill("input[type='password']", "123456")
        page.click("button[type='submit']")
        page.wait_for_url(f"{URL}/", timeout=15000)
        print("[1] login OK")

        # 2. wizard 진입
        page.goto(f"{URL}/script/new/DXB9CE5kRhX")
        page.wait_for_load_state("networkidle", timeout=15000)
        time.sleep(2)
        print("[2] wizard entered")

        # 3. 첫 product 선택 (button with "선택 →" text)
        time.sleep(2)
        prod_btns = page.locator("button").filter(has_text="선택 →")
        n_prods = prod_btns.count()
        print(f"  products available: {n_prods}")
        if n_prods == 0:
            page.screenshot(path=str(SHOTS / "p2_err_no_product.png"), full_page=True)
            # 텍스트 확인
            print(page.locator("body").inner_text()[:800])
            print("[ERR] no products")
            return
        prod_btns.first.click()
        time.sleep(2)
        print("[3] product selected")

        # 4. mapping 대기 — 페르소나 선택 버튼이 보일 때까지 (mapping 완료 신호)
        t0 = time.time()
        while time.time() - t0 < 120:
            if page.locator("button").filter(has_text="페르소나 선택").count() > 0:
                print(f"  mapping fully loaded ({int(time.time() - t0)}s)")
                break
            time.sleep(2)
        time.sleep(2)
        page.screenshot(path=str(SHOTS / "p2_01_mapping.png"), full_page=True)

        # 5. 페르소나 선택 클릭
        next_btn = page.locator("button").filter(has_text="페르소나 선택").first
        if not next_btn.count():
            print("[ERR] no '페르소나 선택' button after wait")
            return
        next_btn.click()
        time.sleep(3)
        page.wait_for_load_state("networkidle", timeout=10000)
        page.screenshot(path=str(SHOTS / "p2_02_personas.png"), full_page=True)
        print("[5] persona step")

        # 6. 페르소나 checkbox 2개 클릭
        checkboxes = page.locator("label input[type='checkbox']")
        n_chk = checkboxes.count()
        print(f"  checkboxes: {n_chk}")
        if n_chk < 2:
            print("[ERR] 페르소나 checkbox < 2개 — 페이지 상태 확인 필요")
            page.screenshot(path=str(SHOTS / "p2_err_few_checkbox.png"), full_page=True)
            return
        # checkbox 클릭 (label 클릭이 안전)
        labels = page.locator("label").filter(has=page.locator("input[type='checkbox']"))
        labels.nth(0).click()
        time.sleep(0.5)
        labels.nth(1).click()
        time.sleep(1)
        page.screenshot(path=str(SHOTS / "p2_03_selected.png"), full_page=True)
        # 선택 검증
        checked_count = page.locator("input[type='checkbox']:checked").count()
        print(f"  checked: {checked_count}")
        if checked_count < 2:
            print("[ERR] 2개 미만 체크됨 — 클릭 실패")

        # 7. 대본 생성
        gen_btn = page.locator("button").filter(has_text="대본 생성").first
        if not gen_btn.count():
            print("[ERR] no '대본 생성' button")
            return
        gen_btn.click()
        print("[7] 대본 생성 clicked")

        # 8. 생성 결과 대기 (max 4분)
        t0 = time.time()
        while time.time() - t0 < 240:
            if page.locator("text=생성된 대본").count() > 0:
                print(f"  result arrived ({int(time.time() - t0)}s)")
                break
            time.sleep(2)
        time.sleep(2)
        page.screenshot(path=str(SHOTS / "p2_03_done.png"), full_page=True)

        # 결과 탭 카운트
        # tabs는 button 형태 — 결과 영역 위쪽
        # console_logs 에서 personas count + OK/FAILED 발췌
        print("\n=== console captured ===")
        for l in console_logs:
            if "[script/gen]" in l or "FAIL" in l:
                print(f"  {l[:300]}")

        # 결과 영역 텍스트
        result_area = page.locator("text=생성된 대본").locator("xpath=../..")
        if result_area.count():
            print("\n=== result panel text (head) ===")
            print(result_area.first.inner_text()[:2000])

        # tab buttons 검사 (StepDone tabs)
        tab_buttons = page.locator("button").filter(has_text=re.compile(r"#\d+"))
        print(f"\n  tabs with #N suffix: {tab_buttons.count()}")
        for i in range(min(tab_buttons.count(), 5)):
            print(f"    tab {i}: {tab_buttons.nth(i).inner_text()}")

        time.sleep(5)
        browser.close()

        # console_logs 전체 파일로
        log_path = SHOTS / "p2_console.log"
        log_path.write_text("\n".join(console_logs), encoding="utf-8")
        print(f"\n console log saved: {log_path}")


if __name__ == "__main__":
    main()
