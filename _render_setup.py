"""Render 배포 자동화 helper.
Chromium 열고 Render dashboard 진입 → 사용자가 로그인 → 자동으로 Blueprint 셋업.
"""
import asyncio
import os
from pathlib import Path
from playwright.async_api import async_playwright
from dotenv import load_dotenv

load_dotenv(Path(__file__).parent / ".env")

SUPA_URL = os.getenv("SUPABASE_URL", "")
SUPA_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")


async def main():
    profile_dir = Path(".browser_profile_render").resolve()
    profile_dir.mkdir(exist_ok=True)
    async with async_playwright() as p:
        ctx = await p.chromium.launch_persistent_context(
            str(profile_dir),
            headless=False,
            viewport={"width": 1400, "height": 900},
            locale="ko-KR",
        )
        page = ctx.pages[0] if ctx.pages else await ctx.new_page()
        # Render dashboard 진입
        await page.goto("https://dashboard.render.com/")
        print("\n=== Render 로그인 자동화 ===")
        print("브라우저에서 Render에 로그인하세요.")
        print("(GitHub 로그인 권장 — 이미 같은 GitHub 계정 사용 중)")
        print("로그인 완료 후 자동 감지됩니다 (최대 10분 대기)...\n")

        # Blueprint URL로 바로 이동 (로그인되어 있으면 감지, 안 되어 있으면 로그인 페이지로 redirect)
        await page.goto("https://dashboard.render.com/blueprints")
        await asyncio.sleep(3)
        print("✅ Blueprint 페이지 (로그인 후 redirect됨)")
        print("   다음 단계는 사용자가 직접 — 'New Blueprint Instance' 클릭 후")
        print("   GitHub repo 'dlalsgur78885-dotcom/reels-bench' 선택")
        print("   render.yaml 자동 감지됨\n")
        print("환경변수 입력 시 아래 값을 사용하세요:")
        print(f"  SUPABASE_URL = {SUPA_URL}")
        print(f"  SUPABASE_SERVICE_ROLE_KEY = {SUPA_KEY[:20]}...{SUPA_KEY[-10:]}")
        print(f"  FB_ADS_PROXY = (비워두기)\n")
        print("브라우저는 30분간 열어둠. 끝나면 X 버튼으로 닫기.")
        await asyncio.sleep(1800)  # 30분 대기
        try:
            await ctx.close()
        except Exception:
            pass


if __name__ == "__main__":
    asyncio.run(main())
