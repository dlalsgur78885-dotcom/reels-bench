"""Vercel dashboard에 접속해 deployment의 runtime logs/functions 정보 추출.

전제: Chrome에 Vercel 로그인 세션이 있어야 함. Chrome 다 닫고 실행.
"""
import os
import time
from pathlib import Path
from playwright.sync_api import sync_playwright

# 새 임시 user data dir에 사용자 Chrome 쿠키만 복사하면 lock 회피 가능하지만
# 여기선 사용자가 Chrome 닫았다고 가정하고 그대로 사용.
USER_DATA_DIR = "C:/Users/PC/AppData/Local/Google/Chrome/User Data"
SCREENSHOT_DIR = Path(__file__).parent / "_pw_screens"
SCREENSHOT_DIR.mkdir(exist_ok=True)

# 가장 최근 깨진 deployment를 직접 열기
DEP_URL = "https://vercel.com/dlalsgur78885-3009s-projects/reels-bench/JBWasmFdvUEa14Rz3Xkkva8mtTAR"
# 위 ID는 최신 dpl_ 추정 — 실제로는 deployment 목록 페이지에서 첫 번째 클릭


def main():
    with sync_playwright() as p:
        # persistent context 사용 — 사용자 로그인 세션 활용
        ctx = p.chromium.launch_persistent_context(
            user_data_dir=USER_DATA_DIR,
            headless=False,
            args=["--profile-directory=Default"],
            viewport={"width": 1400, "height": 900},
        )
        page = ctx.new_page()

        print("[1] Vercel deployments 페이지 접속...")
        page.goto(DEP_URL, timeout=30000)
        page.wait_for_load_state("networkidle", timeout=20000)
        page.screenshot(path=str(SCREENSHOT_DIR / "01_deployments.png"))

        # 가장 최근 deployment 클릭
        print("[2] 첫 deployment 클릭")
        # deployment 링크 패턴 찾기
        links = page.locator('a[href*="/deployments/dpl_"]').all()
        if not links:
            print("  deployment 링크 없음")
            return
        href = links[0].get_attribute("href")
        print(f"  → {href}")
        page.goto(f"https://vercel.com{href}", timeout=30000)
        page.wait_for_load_state("networkidle", timeout=20000)
        page.screenshot(path=str(SCREENSHOT_DIR / "02_deployment.png"))

        # Functions / Runtime Logs 탭 찾기
        print("[3] Functions/Logs 탭 탐색")
        for label in ["Logs", "Functions", "Runtime Logs"]:
            link = page.locator(f'a:has-text("{label}"), button:has-text("{label}")').first
            if link.count() > 0:
                try:
                    link.click(timeout=5000)
                    page.wait_for_load_state("networkidle", timeout=10000)
                    page.screenshot(path=str(SCREENSHOT_DIR / f"03_{label.lower().replace(' ', '_')}.png"))
                    print(f"  ✓ {label} 탭 클릭됨")
                    break
                except Exception as e:
                    print(f"  {label}: {e}")

        # 페이지의 보이는 텍스트 dump (에러 텍스트 잡기)
        body_text = page.locator("body").inner_text()
        out = SCREENSHOT_DIR / "page_text.txt"
        out.write_text(body_text, encoding="utf-8")
        print(f"\n[4] 페이지 텍스트 저장: {out}")

        # 구체적으로 에러/error/Traceback 키워드 찾기
        for kw in ["Error", "Failed", "Traceback", "404", "FUNCTION_INVOCATION"]:
            if kw.lower() in body_text.lower():
                print(f"  ⚠️ '{kw}' 발견")

        # functions 페이지로 직접 이동 (URL 패턴 시도)
        dep_id = href.split("/")[-1]
        for path in ["/functions", "/logs", "/runtime-logs"]:
            url = f"https://vercel.com{href}{path}"
            try:
                page.goto(url, timeout=15000)
                page.wait_for_load_state("networkidle", timeout=10000)
                page.screenshot(path=str(SCREENSHOT_DIR / f"04_{path[1:]}.png"))
                print(f"  ✓ {path}: {page.url}")
            except Exception as e:
                print(f"  {path} fail: {e}")

        time.sleep(3)
        ctx.close()


if __name__ == "__main__":
    main()
