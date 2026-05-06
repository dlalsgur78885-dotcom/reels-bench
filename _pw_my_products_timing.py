"""my-products 응답 속도 측정."""
import time
from playwright.sync_api import sync_playwright

URL = "https://reels-bench.vercel.app"


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(viewport={"width": 1400, "height": 900})
        page = ctx.new_page()

        # response 타이밍 후킹
        timings = []
        page.on("response", lambda r: timings.append({
            "url": r.url, "status": r.status,
            "request_at": r.request.timing.get("requestStart") if r.request.timing else None,
        }) if "/api/" in r.url else None)

        page.goto(f"{URL}/login")
        page.wait_for_load_state("networkidle", timeout=15000)
        page.fill("input[type='text']", "admin")
        page.fill("input[type='password']", "123456")
        page.click("button[type='submit']")
        page.wait_for_url(f"{URL}/", timeout=15000)

        # 1차 — 콜드 가능
        for trial in range(3):
            print(f"\n=== Trial {trial + 1} ===")
            t0 = time.time()
            page.goto(f"{URL}/my-products")
            page.wait_for_load_state("domcontentloaded", timeout=15000)
            t_dcl = (time.time() - t0) * 1000

            # 첫 카드 (또는 empty state) 보일 때까지 대기
            try:
                page.wait_for_selector("h1:has-text('내 상품')", timeout=10000)
            except: pass
            t_h1 = (time.time() - t0) * 1000

            # API 호출 끝나고 listing 확정될 때까지
            try:
                page.wait_for_function(
                    """() => {
                        const h = document.querySelector('h1');
                        const subtitle = h ? h.parentElement.querySelector('p') : null;
                        return subtitle && subtitle.textContent && subtitle.textContent.includes('개');
                    }""",
                    timeout=15000,
                )
            except Exception as e:
                print(f"  subtitle 못 찾음: {e}")

            t_done = (time.time() - t0) * 1000
            print(f"  DCL={t_dcl:.0f}ms, H1={t_h1:.0f}ms, 카운트표시={t_done:.0f}ms")

            # 마지막 my-products 응답 시간 측정
            mp_responses = [t for t in timings if "/api/my-products" in t["url"]]
            if mp_responses:
                print(f"  /api/my-products 호출 수: {len(mp_responses)}")

            time.sleep(0.5)

        # 응답 시간 별도 측정 (Network API)
        print("\n=== /api/my-products 직접 fetch 측정 ===")
        for i in range(3):
            elapsed = page.evaluate("""async () => {
                const t0 = performance.now();
                const r = await fetch('/api/my-products', {
                    headers: {Authorization: 'Bearer ' + (await window.supabase?.auth?.getSession())?.data?.session?.access_token}
                });
                const data = await r.json();
                return performance.now() - t0;
            }""")
            print(f"  fetch {i+1}: {elapsed:.0f}ms")

        browser.close()


if __name__ == "__main__":
    main()
