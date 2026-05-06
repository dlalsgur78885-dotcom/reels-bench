"""사이트 + API 속도 체크."""
import time
import statistics
from pathlib import Path
from playwright.sync_api import sync_playwright

URL = "https://reels-bench.vercel.app/"
OUT = Path(__file__).parent / "_pw_screens"
OUT.mkdir(exist_ok=True)


def measure_page(page, label):
    t0 = time.time()
    page.goto(URL, wait_until="commit")
    t_commit = (time.time() - t0) * 1000

    page.wait_for_load_state("domcontentloaded")
    t_dcl = (time.time() - t0) * 1000

    page.wait_for_load_state("networkidle", timeout=30000)
    t_idle = (time.time() - t0) * 1000

    # web vitals via Performance API
    perf = page.evaluate(
        """() => {
            const nav = performance.getEntriesByType('navigation')[0] || {};
            const paint = performance.getEntriesByType('paint');
            const fcp = paint.find(p => p.name === 'first-contentful-paint');
            const lcp = performance.getEntriesByType('largest-contentful-paint').slice(-1)[0];
            return {
                ttfb: nav.responseStart - nav.requestStart,
                dom_complete: nav.domComplete - nav.requestStart,
                load: nav.loadEventEnd - nav.requestStart,
                fcp: fcp?.startTime || 0,
                lcp: lcp?.startTime || 0,
                transferSize: nav.transferSize || 0,
            };
        }"""
    )
    print(f"[{label}]")
    print(f"  commit:        {t_commit:7.0f} ms")
    print(f"  TTFB:          {perf['ttfb']:7.0f} ms")
    print(f"  DOMContentLoaded: {t_dcl:7.0f} ms")
    print(f"  FCP:           {perf['fcp']:7.0f} ms")
    print(f"  LCP:           {perf['lcp']:7.0f} ms")
    print(f"  Load complete: {perf['load']:7.0f} ms")
    print(f"  Network idle:  {t_idle:7.0f} ms")
    print(f"  Transfer:      {perf['transferSize']/1024:7.1f} KB")
    return perf


def measure_api(ctx, path, n=3):
    """API endpoint 평균 응답 시간 (n회 호출)."""
    times = []
    sizes = []
    statuses = []
    for _ in range(n):
        t0 = time.time()
        r = ctx.request.get(URL.rstrip("/") + path, timeout=30000)
        elapsed = (time.time() - t0) * 1000
        times.append(elapsed)
        sizes.append(len(r.body() or b""))
        statuses.append(r.status)
    return {
        "min": min(times),
        "avg": statistics.mean(times),
        "max": max(times),
        "size": statistics.mean(sizes),
        "status": statuses[0],
    }


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(viewport={"width": 1400, "height": 900})
        page = ctx.new_page()

        print("=" * 60)
        print("PAGE LOAD")
        print("=" * 60)
        # Cold (cache 없음)
        measure_page(page, "Cold (1차)")
        page.close()
        time.sleep(1)

        # Warm
        page = ctx.new_page()
        measure_page(page, "Warm (2차, cache hit)")

        print()
        print("=" * 60)
        print("API ENDPOINTS (3회 평균)")
        print("=" * 60)

        endpoints = [
            "/api/reels",
            "/api/metadata",
            "/api/bench?page=1&limit=20",
            "/api/thumb/DXWeBY4Dyai",
            "/api/thumb/DUR-Dy_iY0P",
        ]
        for ep in endpoints:
            try:
                m = measure_api(ctx, ep, n=3)
                print(f"  {ep:40s}  HTTP {m['status']}  "
                      f"min={m['min']:5.0f}ms  avg={m['avg']:5.0f}ms  "
                      f"max={m['max']:5.0f}ms  size={m['size']/1024:6.1f}KB")
            except Exception as e:
                print(f"  {ep}: error {e}")

        print()
        print("=" * 60)
        print("Storage 직접 (CDN)")
        print("=" * 60)
        m = measure_api(ctx,
            "/storage/v1/object/public/thumbs/DXWeBY4Dyai.webp",
            n=3)
        # 전체 URL은 Supabase. 위는 reels-bench.vercel.app 기준 path → 무효.
        # 직접 호출
        SUPA = "https://mrpbovbxtablvawszhey.supabase.co"
        times = []
        for _ in range(3):
            t0 = time.time()
            r = ctx.request.get(f"{SUPA}/storage/v1/object/public/thumbs/DXWeBY4Dyai.webp")
            times.append((time.time() - t0) * 1000)
        print(f"  Supabase Storage direct:  min={min(times):.0f}ms  avg={statistics.mean(times):.0f}ms  max={max(times):.0f}ms")

        browser.close()


if __name__ == "__main__":
    main()
