"""Vercel 사이트 실제 확인 — 썸네일 표시 검증."""
import time
from pathlib import Path
from playwright.sync_api import sync_playwright

OUT = Path(__file__).parent / "_pw_screens"
OUT.mkdir(exist_ok=True)

URL = "https://reels-bench.vercel.app/"


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(viewport={"width": 1400, "height": 900})
        page = ctx.new_page()

        # 콘솔/네트워크 에러 수집
        errors = []
        thumb_responses = []
        page.on("console", lambda m: errors.append(f"[console.{m.type}] {m.text}") if m.type in ("error", "warning") else None)
        page.on("pageerror", lambda e: errors.append(f"[pageerror] {e}"))
        page.on("response", lambda r: thumb_responses.append((r.url, r.status)) if "/thumb/" in r.url or "/storage/" in r.url else None)

        print("[1] 홈 페이지 접속...")
        page.goto(URL, timeout=30000)
        page.wait_for_load_state("networkidle", timeout=20000)
        time.sleep(2)
        page.screenshot(path=str(OUT / "site_01_home.png"), full_page=True)

        # 썸네일 element 카운트
        imgs = page.locator("img").all()
        print(f"  IMG 요소: {len(imgs)}개")
        loaded = 0
        broken = 0
        for img in imgs[:30]:
            try:
                w = img.get_attribute("naturalWidth") or "0"
                src = img.get_attribute("src") or ""
                if "thumb" in src or "storage" in src:
                    is_loaded = page.evaluate("(el) => el.complete && el.naturalWidth > 0", img.element_handle())
                    if is_loaded:
                        loaded += 1
                    else:
                        broken += 1
            except Exception:
                pass
        print(f"  로드된 썸네일: {loaded}, 깨진 썸네일: {broken}")

        # bench 페이지로 이동
        print("[2] bench 페이지 시도...")
        try:
            page.goto(URL + "bench", timeout=20000)
            page.wait_for_load_state("networkidle", timeout=15000)
            time.sleep(2)
            page.screenshot(path=str(OUT / "site_02_bench.png"), full_page=True)
        except Exception as e:
            print(f"  bench 페이지 fail: {e}")

        # thumb endpoint 직접 ping
        print("[3] thumb endpoint 직접 확인")
        for sc in ["C1dyjWRr5R7", "C59orfLPDZw", "DXWeet6D7dV"]:
            try:
                r = ctx.request.head(f"{URL}api/thumb/{sc}", timeout=15000)
                print(f"  {sc}: HTTP {r.status}")
            except Exception as e:
                print(f"  {sc}: {e}")

        print(f"\n[4] 썸네일/스토리지 응답 ({len(thumb_responses)}개):")
        for url, status in thumb_responses[:15]:
            short = url.split("/")[-1][:40]
            origin = "vercel" if "vercel.app" in url else "supabase"
            print(f"  [{origin}] HTTP {status}  ...{short}")

        if errors:
            print(f"\n[!] 콘솔/페이지 에러 {len(errors)}개:")
            for e in errors[:10]:
                print(f"  {e[:200]}")
        else:
            print("\n[✓] 콘솔 에러 없음")

        browser.close()


if __name__ == "__main__":
    main()
