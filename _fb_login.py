"""FB 로그인 헬퍼 — 브라우저 열고 사용자 로그인 자동 감지 후 storage state 저장."""
import asyncio
import json
from pathlib import Path
from playwright.async_api import async_playwright


async def main():
    profile_dir = Path(".browser_profile").resolve()
    profile_dir.mkdir(exist_ok=True)
    state_path = Path("fb_storage_state.json").resolve()

    async with async_playwright() as p:
        ctx = await p.chromium.launch_persistent_context(
            str(profile_dir),
            headless=False,
            viewport={"width": 1400, "height": 900},
            locale="ko-KR",
        )
        page = ctx.pages[0] if ctx.pages else await ctx.new_page()
        await page.goto("https://www.facebook.com/login", wait_until="domcontentloaded")
        print("\n브라우저에서 페이스북 로그인하세요...")
        print("로그인 완료되면 자동으로 storage state 저장 후 닫힙니다 (최대 10분 대기)\n")

        for i in range(300):  # 10분 (2s * 300)
            await asyncio.sleep(2)
            try:
                cookies = await ctx.cookies()
                if any(c.get('name') == 'c_user' for c in cookies):
                    print(f"✅ 로그인 감지 ({i*2}초 후) — storage state 저장 중...")
                    # ads/library 페이지로 이동해서 cookies 추가 확보
                    try:
                        await page.goto("https://www.facebook.com/ads/library/?country=KR&q=test", timeout=30000)
                        await asyncio.sleep(3)
                    except Exception:
                        pass
                    state = await ctx.storage_state()
                    state_path.write_text(json.dumps(state, ensure_ascii=False), encoding="utf-8")
                    print(f"✅ 저장 완료: {state_path}")
                    break
            except Exception as e:
                pass
        else:
            print("⚠️ 10분 timeout — 로그인 미감지")
        await ctx.close()


if __name__ == "__main__":
    asyncio.run(main())
