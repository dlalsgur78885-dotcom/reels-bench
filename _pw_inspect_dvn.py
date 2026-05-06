"""DVNQAqEkoeI 페이지 진단 — 콘솔 에러 + 시각적 상태 + 어떤 섹션이 보이는지."""
import time
from pathlib import Path
from playwright.sync_api import sync_playwright

OUT = Path(__file__).parent / "_pw_screens"
OUT.mkdir(exist_ok=True)
URL = "https://reels-bench.vercel.app"
SC = "DVNQAqEkoeI"


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(viewport={"width": 1400, "height": 1000})
        page = ctx.new_page()

        errors = []
        bad = []
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("response", lambda r: bad.append(f"{r.status} {r.url[:80]}") if r.status >= 400 and "/api/" in r.url else None)

        page.goto(f"{URL}/login")
        page.wait_for_load_state("networkidle")
        page.fill("input[type='text']", "admin")
        page.fill("input[type='password']", "123456")
        page.click("button[type='submit']")
        page.wait_for_url(f"{URL}/")
        time.sleep(0.3)

        page.goto(f"{URL}/bench/{SC}", wait_until="networkidle", timeout=15000)
        time.sleep(2)
        page.screenshot(path=str(OUT / "dvn_overview.png"), full_page=True)

        # 탭별 캡처
        for tab_label, fname in [("프레임", "dvn_frames.png"), ("대본", "dvn_script.png")]:
            try:
                page.locator(f"button:has-text('{tab_label}')").first.click()
                time.sleep(1)
                page.screenshot(path=str(OUT / fname), full_page=True)
            except Exception as e:
                print(f"[{tab_label}] 탭 클릭 실패: {e}")

        # 메인 영역에 노출된 텍스트 키워드 체크
        text = page.evaluate("() => document.querySelector('main')?.innerText || ''")

        markers = ["타임스탬프", "[0초]", "초]", "0초", "Hook", "Intro", "Body", "CTA", "분석 결과", "프레임 분석", "감정", "BGM", "효과음", "오류", "에러", "실패"]
        print(f"\n=== /bench/{SC} ===")
        print(f"본문 길이: {len(text)} chars")
        for m in markers:
            count = text.count(m)
            mark = "✓" if count > 0 else "✗"
            print(f"  {mark} '{m}': {count}회")

        # 에러
        if errors:
            print(f"\n콘솔 에러 {len(errors)}건:")
            for e in errors[:5]:
                print(f"  - {e[:160]}")
        if bad:
            print(f"\nAPI 4xx/5xx {len(bad)}건:")
            for b in bad[:5]:
                print(f"  - {b}")

        browser.close()


if __name__ == "__main__":
    main()
