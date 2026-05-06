"""my-products 깊이 디버그 — 무엇이 느린지 단계별 측정."""
import time
from playwright.sync_api import sync_playwright

URL = "https://reels-bench.vercel.app"


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(viewport={"width": 1400, "height": 900})
        page = ctx.new_page()

        # 모든 API 호출 시간 기록
        timings = []
        def on_req(req):
            if "/api/" in req.url:
                timings.append({"phase": "req", "url": req.url, "method": req.method, "t": time.time()})
        def on_res(res):
            if "/api/" in res.url:
                timings.append({"phase": "res", "url": res.url, "status": res.status, "t": time.time()})

        page.on("request", on_req)
        page.on("response", on_res)

        # 로그인
        page.goto(f"{URL}/login")
        page.wait_for_load_state("networkidle", timeout=15000)
        page.fill("input[type='text']", "admin")
        page.fill("input[type='password']", "123456")
        page.click("button[type='submit']")
        page.wait_for_url(f"{URL}/", timeout=15000)
        # cached_me populate 보장 (api.me() 끝날 때까지 — cold일 경우 길어짐)
        deadline = time.time() + 10
        while time.time() < deadline:
            cm = page.evaluate("() => localStorage.getItem('cached_me')")
            if cm: break
            time.sleep(0.1)
        print(f"cached_me present: {bool(cm)}")

        for trial in range(3):
            print(f"\n========== Trial {trial+1} ==========")
            timings.clear()
            t0 = time.time()
            page.goto(f"{URL}/my-products", wait_until="domcontentloaded")
            t_dcl = (time.time() - t0) * 1000

            # 카드 또는 empty가 떠야 진짜 콘텐츠 노출
            content_visible_at = None
            deadline = time.time() + 10
            while time.time() < deadline:
                # 실제 카드/empty가 보이는지 체크
                cards = page.locator("[style*='grid-template-columns'] > div").count()
                empty = page.locator("div:has-text('등록된 상품이 없습니다')").count()
                # 또는 개수 카운트가 ('불러오는 중'에서 'N개'로 바뀌었는지)
                sub = page.locator(".page-header p").first.text_content() or ""
                if cards > 0 or empty > 0:
                    content_visible_at = (time.time() - t0) * 1000
                    break
                if "개" in sub and "불러오는" not in sub:
                    content_visible_at = (time.time() - t0) * 1000
                    break
                time.sleep(0.04)

            print(f"DCL={t_dcl:.0f}ms, 콘텐츠 노출={content_visible_at:.0f}ms" if content_visible_at else f"DCL={t_dcl:.0f}ms, 콘텐츠 noshow")

            # API 호출 시간 분석
            api_calls = {}
            for entry in timings:
                key = entry["url"].split("?")[0]
                if key not in api_calls:
                    api_calls[key] = {}
                api_calls[key][entry["phase"]] = entry["t"]
            print(f"API 호출:")
            for url, ev in api_calls.items():
                if "req" in ev and "res" in ev:
                    duration = (ev["res"] - ev["req"]) * 1000
                    print(f"  {url[len(URL):]}: {duration:.0f}ms")

            # 다음 시도를 위한 대기
            time.sleep(0.3)

        # localStorage / sessionStorage 상태
        ss = page.evaluate("() => sessionStorage.getItem('my_products_cache')")
        print(f"\nsessionStorage my_products_cache: {len(ss) if ss else 0} bytes")

        browser.close()


if __name__ == "__main__":
    main()
