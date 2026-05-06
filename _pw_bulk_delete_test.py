"""bulk-delete 인증 후 실제 응답 시간 측정 (실존하지 않는 shortcode로 호출)."""
from playwright.sync_api import sync_playwright

URL = "https://reels-bench.vercel.app"


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

        # 30개 fake shortcode로 호출 (DB에 없으므로 실제로 지워지는 것은 없음)
        # 토큰 디버그
        token_info = page.evaluate("""async () => {
            // localStorage에서 supabase auth token 직접 추출
            const keys = Object.keys(localStorage);
            const sbKey = keys.find(k => k.startsWith('sb-') && k.endsWith('-auth-token'));
            if (!sbKey) return {err: 'no sb token in localStorage'};
            const raw = localStorage.getItem(sbKey);
            const parsed = JSON.parse(raw);
            const token = parsed.access_token;
            const parts = token.split('.');
            const decoded = parts.length >= 2 ? JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'))) : null;
            return {token_len: token.length, parts: parts.length, sub: decoded?.sub, exp: decoded?.exp};
        }""")
        print(f"Token info: {token_info}")

        result = page.evaluate("""async () => {
            const t0 = performance.now();
            const fakes = [];
            for (let i = 0; i < 30; i++) fakes.push(`FAKE_DOES_NOT_EXIST_${i}_AAAA`);
            const keys = Object.keys(localStorage);
            const sbKey = keys.find(k => k.startsWith('sb-') && k.endsWith('-auth-token'));
            const parsed = JSON.parse(localStorage.getItem(sbKey));
            const token = parsed.access_token;
            const r = await fetch('/api/reels/bulk-delete', {
                method: 'POST',
                headers: {'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token},
                body: JSON.stringify({shortcodes: fakes}),
            });
            const elapsed = performance.now() - t0;
            const txt = await r.text();
            return {status: r.status, elapsed, body: txt.slice(0, 200)};
        }""")
        print(f"30개 fake shortcode bulk-delete 응답:")
        print(f"  status={result['status']}, time={result['elapsed']:.0f}ms")
        print(f"  body={result['body']}")

        browser.close()


if __name__ == "__main__":
    main()
