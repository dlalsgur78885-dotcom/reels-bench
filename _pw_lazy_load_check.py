"""lazy load 효과 — 페이지 첫 진입 시 main 번들 + 해당 페이지 청크만 로드되는지 확인."""
import time
from playwright.sync_api import sync_playwright

URL = "https://reels-bench.vercel.app"


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(viewport={"width": 1400, "height": 900})
        page = ctx.new_page()

        loads = []
        page.on("response", lambda r: loads.append({"url": r.url, "size": r.headers.get("content-length", "?")}) if ".js" in r.url and "/assets/" in r.url else None)

        page.goto(f"{URL}/login")
        page.wait_for_load_state("networkidle", timeout=15000)
        page.fill("input[type='text']", "admin")
        page.fill("input[type='password']", "123456")
        page.click("button[type='submit']")
        page.wait_for_url(f"{URL}/", timeout=15000)
        time.sleep(1)

        print("=== 홈 진입 시 로드된 JS ===")
        loads.clear()
        page.goto(f"{URL}/", wait_until="networkidle")
        for l in loads:
            name = l["url"].split("/")[-1].split("?")[0]
            print(f"  {name}")

        print("\n=== /channels 이동 시 추가 로드된 JS ===")
        loads.clear()
        page.goto(f"{URL}/channels", wait_until="networkidle")
        for l in loads:
            name = l["url"].split("/")[-1].split("?")[0]
            print(f"  {name}")

        print("\n=== /my-products 이동 시 추가 로드된 JS ===")
        loads.clear()
        page.goto(f"{URL}/my-products", wait_until="networkidle")
        for l in loads:
            name = l["url"].split("/")[-1].split("?")[0]
            print(f"  {name}")

        browser.close()


if __name__ == "__main__":
    main()
