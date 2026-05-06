"""채널 페이지 — 모든 네트워크 호출 시간 + 화면 구성 단계별 측정."""
import time
from playwright.sync_api import sync_playwright

URL = "https://reels-bench.vercel.app"


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(viewport={"width": 1400, "height": 900})
        page = ctx.new_page()

        # 모든 네트워크 호출 추적
        nav_t = [None]  # mutable navigation start time
        all_calls = []
        def on_req(req):
            if nav_t[0] is None:
                return
            all_calls.append({
                "phase": "req",
                "url": req.url,
                "t": (time.time() - nav_t[0]) * 1000,
                "type": req.resource_type,
            })
        def on_res(res):
            if nav_t[0] is None:
                return
            all_calls.append({
                "phase": "res",
                "url": res.url,
                "t": (time.time() - nav_t[0]) * 1000,
                "status": res.status,
            })
        page.on("request", on_req)
        page.on("response", on_res)

        # 로그인
        page.goto(f"{URL}/login")
        page.wait_for_load_state("networkidle", timeout=15000)
        page.fill("input[type='text']", "admin")
        page.fill("input[type='password']", "123456")
        page.click("button[type='submit']")
        page.wait_for_url(f"{URL}/", timeout=15000)
        for _ in range(80):
            if page.evaluate("() => localStorage.getItem('cached_me')"): break
            time.sleep(0.1)

        # 캐시 한 번 채우기
        page.goto(f"{URL}/channels", wait_until="networkidle")
        time.sleep(1)

        # 진짜 측정 — fresh navigation
        all_calls.clear()
        nav_t[0] = time.time()
        page.goto(f"{URL}/channels", wait_until="domcontentloaded")

        # 페이지 단계별 노출 시점
        events = []
        events.append(("DCL", (time.time() - nav_t[0]) * 1000))
        page.wait_for_selector("h1", timeout=10000)
        events.append(("H1", (time.time() - nav_t[0]) * 1000))
        # 채널 카드
        deadline = time.time() + 8
        while time.time() < deadline:
            if page.locator(".channel-select").count() > 0:
                events.append(("채널카드", (time.time() - nav_t[0]) * 1000))
                break
            time.sleep(0.05)
        # 분석 영역 — top reel 표시
        deadline = time.time() + 12
        while time.time() < deadline:
            if page.locator("img[src*='thumb']").count() > 0 or page.locator(":has-text('총 조회')").count() > 0 or page.locator(":has-text('아직')").count() > 0:
                events.append(("분석/통계", (time.time() - nav_t[0]) * 1000))
                break
            time.sleep(0.05)

        # 모든 이미지 로드 완료
        deadline = time.time() + 10
        while time.time() < deadline:
            done = page.evaluate("() => Array.from(document.images).every(i => i.complete)")
            if done:
                events.append(("모든이미지완료", (time.time() - nav_t[0]) * 1000))
                break
            time.sleep(0.1)

        try:
            page.wait_for_load_state("networkidle", timeout=10000)
        except: pass
        events.append(("networkidle", (time.time() - nav_t[0]) * 1000))

        print("\n=== 화면 구성 단계 ===")
        for name, t in events:
            print(f"  {name}: {t:.0f}ms")

        # API 호출만 분석
        print("\n=== API 호출 ===")
        api_pairs = {}
        for c in all_calls:
            if "/api/" not in c["url"]:
                continue
            key = c["url"].split("?")[0].split(URL)[-1]
            if key not in api_pairs:
                api_pairs[key] = {}
            if c["phase"] == "req":
                api_pairs[key]["req"] = c["t"]
            else:
                api_pairs[key]["res"] = c["t"]
                api_pairs[key]["status"] = c["status"]
        for path, ev in api_pairs.items():
            req_t = ev.get("req", 0)
            res_t = ev.get("res", 0)
            duration = res_t - req_t if req_t and res_t else 0
            print(f"  {path}: 시작 {req_t:.0f}ms → 응답 {res_t:.0f}ms (소요 {duration:.0f}ms, status={ev.get('status')})")

        # 정적 자원 (이미지, JS, CSS) 분석
        print("\n=== 외부 리소스 (이미지/번들) ===")
        static_pairs = {}
        for c in all_calls:
            if "/api/" in c["url"]:
                continue
            key = c["url"].split("?")[0]
            short_key = key.split("/")[-1] or key
            if short_key not in static_pairs:
                static_pairs[short_key] = {}
            if c["phase"] == "req":
                static_pairs[short_key]["req"] = c["t"]
                static_pairs[short_key]["type"] = c.get("type", "?")
                static_pairs[short_key]["url"] = c["url"]
            else:
                static_pairs[short_key]["res"] = c["t"]
                static_pairs[short_key]["status"] = c["status"]
        # 가장 오래 걸린 5개
        with_dur = []
        for k, ev in static_pairs.items():
            req_t = ev.get("req", 0)
            res_t = ev.get("res", 0)
            duration = res_t - req_t if req_t and res_t else 0
            with_dur.append((duration, ev.get("type", "?"), k, ev.get("status", "?"), req_t, res_t))
        with_dur.sort(reverse=True)
        for d, type_, k, status, req_t, res_t in with_dur[:10]:
            print(f"  [{type_}] {k}: 시작 {req_t:.0f}ms → 응답 {res_t:.0f}ms (소요 {d:.0f}ms, status={status})")

        browser.close()


if __name__ == "__main__":
    main()
