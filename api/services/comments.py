"""Instagram comment scraping via Playwright"""

import sys
import logging

logger = logging.getLogger(__name__)


def fetch_playwright(shortcode):
    """Headless Chrome comment scraping (no login)"""
    result_holder = []

    def _run_in_thread():
        import asyncio
        if sys.platform == "win32":
            loop = asyncio.ProactorEventLoop()
            asyncio.set_event_loop(loop)
        try:
            from playwright.sync_api import sync_playwright
        except ImportError:
            logger.warning("playwright not installed")
            return

        extract_js = r"""(shortcode) => {
    const results = [];
    const seen = new Set();
    const NOISE = /^(좋아요|답글 달기|번역 보기|로그인|가입하기|Meta|소개|블로그|채용|도움말|API|개인정보|약관|위치|Threads|한국어|©).*$/;
    const TIME_RE = /^\d+[초분시일주월년](전)?$|^\d+[smhdwy]$/;
    const commentLinks = document.querySelectorAll('a[href*="/c/"]');
    for (const a of commentLinks) {
        const href = a.getAttribute('href') || '';
        if (!href.includes('/p/' + shortcode + '/c/')) continue;
        let container = a;
        for (let i = 0; i < 6; i++) { if (container.parentElement) container = container.parentElement; }
        const full = container.innerText || '';
        const lines = full.split('\n').map(l => l.replace(/\u00a0/g, '').trim()).filter(Boolean);
        if (lines.length < 2) continue;
        const author = lines[0];
        if (!/^[a-zA-Z0-9_.]+$/.test(author)) continue;
        const textLines = lines.slice(1).filter(l => !TIME_RE.test(l) && !NOISE.test(l));
        const text = textLines.join(' ').trim();
        if (text.length >= 1 && !seen.has(author + '|' + text.slice(0, 30))) {
            seen.add(author + '|' + text.slice(0, 30));
            results.push({ author, text });
        }
    }
    if (results.length === 0) {
        const spans = document.querySelectorAll('span[dir=auto]');
        for (const span of spans) {
            const a = span.querySelector('a[href]');
            if (!a) continue;
            const href = a.getAttribute('href') || '';
            const m = href.match(/^\/([a-zA-Z0-9_.]+)\/$/);
            if (!m) continue;
            const username = m[1];
            const spanText = span.innerText || '';
            if (!spanText.startsWith(username) || spanText.length <= username.length + 3) continue;
            const rest = spanText.slice(username.length);
            const lines = rest.split('\n').map(l => l.replace(/\u00a0/g, '').trim())
                .filter(l => l.length > 0 && !TIME_RE.test(l) && !NOISE.test(l));
            const text = lines.join(' ').trim();
            if ((text.match(/#/g) || []).length >= 3) continue;
            if (text.length >= 1 && !seen.has(username + '|' + text.slice(0, 30))) {
                seen.add(username + '|' + text.slice(0, 30));
                results.push({ author: username, text });
            }
        }
    }
    return results;
}"""
        try:
            with sync_playwright() as p:
                browser = p.chromium.launch(headless=True)
                ctx = browser.new_context(
                    user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                    locale="ko-KR",
                )
                page = ctx.new_page()
                page.goto(f"https://www.instagram.com/reel/{shortcode}/", wait_until="domcontentloaded", timeout=20000)
                page.wait_for_timeout(4000)
                try:
                    close_btn = page.locator('[role="dialog"] button:has-text("닫기"), [role="dialog"] [aria-label="닫기"]')
                    if close_btn.count() > 0:
                        close_btn.first.click()
                        page.wait_for_timeout(1000)
                except Exception:
                    pass
                for _ in range(3):
                    try:
                        more_btn = page.locator('button:has-text("댓글 모두 보기"), button:has-text("댓글"), span:has-text("댓글 모두 보기")')
                        if more_btn.count() > 0:
                            more_btn.first.click()
                            page.wait_for_timeout(2000)
                    except Exception:
                        break
                for _ in range(3):
                    page.evaluate("window.scrollBy(0, 500)")
                    page.wait_for_timeout(1000)
                raw = page.evaluate(extract_js, shortcode)
                browser.close()
            for c in raw:
                result_holder.append({
                    "shortcode": shortcode,
                    "comment_text": c.get("text", ""),
                    "comment_author": c.get("author", ""),
                    "comment_likes": 0,
                })
        except Exception as e:
            logger.warning("Playwright comments error: %s", e)

    import threading
    t = threading.Thread(target=_run_in_thread, daemon=True)
    t.start()
    t.join(timeout=60)
    return result_holder
