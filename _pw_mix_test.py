"""1 product persona + 1 ref desire 혼합 선택 테스트."""
import sys, io
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
        browser = p.chromium.launch(headless=False, slow_mo=80)
        ctx = browser.new_context(viewport={"width": 1400, "height": 1100})
        page = ctx.new_page()

        def on_console(msg):
            try:
                txt = f"[{msg.type}] {msg.text}"
                console_logs.append(txt)
                if "[script/gen]" in msg.text or "FAIL" in msg.text:
                    print(f"  CONSOLE: {txt[:300]}")
            except Exception:
                pass
        page.on("console", on_console)

        # login
        page.goto(f"{URL}/login")
        page.wait_for_load_state("networkidle", timeout=15000)
        page.fill("input[type='text']", "admin")
        page.fill("input[type='password']", "123456")
        page.click("button[type='submit']")
        page.wait_for_url(f"{URL}/", timeout=15000)
        print("[1] login")

        # wizard
        page.goto(f"{URL}/script/new/DXB9CE5kRhX")
        page.wait_for_load_state("networkidle", timeout=15000)
        time.sleep(2)

        # product
        prod_btns = page.locator("button").filter(has_text="선택 →")
        prod_btns.first.click()
        time.sleep(2)
        print("[2] product selected")

        # mapping
        t0 = time.time()
        while time.time() - t0 < 120:
            if page.locator("button").filter(has_text="페르소나 선택").count() > 0:
                print(f"  mapping ready ({int(time.time() - t0)}s)")
                break
            time.sleep(2)
        time.sleep(1)

        # 페르소나 선택 step 진입
        page.locator("button").filter(has_text="페르소나 선택").first.click()
        time.sleep(3)
        page.wait_for_load_state("networkidle", timeout=10000)
        print("[3] persona step")
        page.screenshot(path=str(SHOTS / "mix_01_step.png"), full_page=True)

        # 모든 checkbox 발견
        all_cb = page.locator("label input[type='checkbox']")
        n = all_cb.count()
        print(f"  total checkboxes: {n}")

        # ref desire (REF 배지 있는 라벨) 와 product persona 분리
        ref_labels = page.locator("label").filter(has_text=re.compile(r"REF"))
        n_ref = ref_labels.count()
        print(f"  ref_desire labels: {n_ref}")

        # product persona 라벨 (REF 배지 없는 것)
        all_labels = page.locator("label").filter(has=page.locator("input[type='checkbox']"))
        n_all = all_labels.count()
        print(f"  all checkbox labels: {n_all}")

        if n_ref < 1 or (n_all - n_ref) < 1:
            print("[ERR] 한쪽이 0개 — 매핑이 부족함")
            time.sleep(60)
            return

        # 1 product persona 선택 (REF가 아닌 첫 라벨)
        product_picked = False
        for i in range(n_all):
            lbl = all_labels.nth(i)
            txt = lbl.inner_text()
            if "REF" not in txt:
                lbl.click()
                time.sleep(0.5)
                print(f"  product picked: {txt[:60]}")
                product_picked = True
                break
        if not product_picked:
            print("[ERR] product persona not found")
            return

        # 1 ref desire 선택
        ref_labels.first.click()
        time.sleep(0.5)
        print(f"  ref_desire picked")

        time.sleep(1)
        page.screenshot(path=str(SHOTS / "mix_02_selected.png"), full_page=True)

        # 선택 검증
        checked_count = page.locator("input[type='checkbox']:checked").count()
        print(f"  checked total: {checked_count}")

        # 대본 생성
        gen_btn = page.locator("button").filter(has_text="대본 생성").first
        if not gen_btn.count():
            print("[ERR] no gen btn")
            return
        gen_btn.click()
        print("[4] generate clicked")

        # 대기
        t0 = time.time()
        while time.time() - t0 < 240:
            if page.locator("text=생성된 대본").count() > 0:
                print(f"  result ({int(time.time() - t0)}s)")
                break
            time.sleep(2)
        time.sleep(2)
        page.screenshot(path=str(SHOTS / "mix_03_done.png"), full_page=True)

        # tabs
        tab_buttons = page.locator("button").filter(has_text=re.compile(r"#\d+"))
        n_tabs = tab_buttons.count()
        print(f"\n  RESULT TABS: {n_tabs}")
        for i in range(n_tabs):
            print(f"    tab {i}: {tab_buttons.nth(i).inner_text()}")

        # console logs
        print("\n=== console ===")
        for l in console_logs:
            if "[script/gen]" in l or "FAIL" in l:
                print(f"  {l[:300]}")

        time.sleep(3)
        browser.close()


if __name__ == "__main__":
    main()
