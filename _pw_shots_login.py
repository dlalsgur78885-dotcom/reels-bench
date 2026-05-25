"""shots.so 로그인 세션 자동 캡처 (Google OAuth 우회 버전).

핵심:
  - launch_persistent_context(user_data_dir=...) — 진짜 Chrome 프로필
  - channel="chrome" 우선, 실패 시 channel="msedge" → 마지막 chromium fallback
  - --disable-blink-features=AutomationControlled + ignore_default_args 으로
    navigator.webdriver=true 신호 제거 → Google "안전하지 않은 브라우저" 회피

user_data_dir 안에 cookie/localStorage 다 들어가서 audit 스크립트가 같은
디렉터리로 재오픈하면 로그인 유지됨. storage_state json 도 보조적으로 저장.
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).parent
USER_DATA = ROOT / "_pw_shots_userdata"   # persistent profile
STATE = ROOT / "_pw_shots_state.json"     # 보조 storage_state json
SIGNAL = ROOT / "_pw_shots_login_done.flag"
MAX_MINUTES = 30
POLL_SEC = 10

STEALTH_ARGS = [
    "--disable-blink-features=AutomationControlled",
    "--no-first-run",
    "--no-default-browser-check",
]
IGNORE_ARGS = ["--enable-automation"]


def try_launch(p, channel: str | None):
    """채널별 persistent launch — 실패 시 None."""
    USER_DATA.mkdir(exist_ok=True)
    kwargs = dict(
        user_data_dir=str(USER_DATA),
        headless=False,
        viewport={"width": 1440, "height": 900},
        locale="ko-KR",
        args=STEALTH_ARGS,
        ignore_default_args=IGNORE_ARGS,
    )
    if channel:
        kwargs["channel"] = channel
    try:
        ctx = p.chromium.launch_persistent_context(**kwargs)
        print(f"[login] launched channel={channel or 'chromium'}", flush=True)
        return ctx
    except Exception as e:
        print(f"[login] channel={channel} failed: {str(e)[:200]}",
              file=sys.stderr, flush=True)
        return None


def main() -> int:
    if SIGNAL.exists():
        SIGNAL.unlink()

    with sync_playwright() as p:
        # 시스템 Chrome 우선 → MS Edge → bundled Chromium 순
        ctx = try_launch(p, "chrome")
        if ctx is None:
            ctx = try_launch(p, "msedge")
        if ctx is None:
            ctx = try_launch(p, None)
        if ctx is None:
            print("ERROR: no browser channel could launch", file=sys.stderr)
            return 1

        # webdriver flag 추가 마스킹 (init script)
        try:
            ctx.add_init_script(
                "Object.defineProperty(navigator, 'webdriver', "
                "{get: () => undefined});"
            )
        except Exception:
            pass

        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        try:
            page.goto("https://shots.so/", wait_until="domcontentloaded", timeout=30000)
        except Exception as e:
            print(f"[warn] nav: {e}", file=sys.stderr, flush=True)

        print(f"[login] log in via the GUI window.", flush=True)
        print(f"[login] profile dir = {USER_DATA.name}", flush=True)
        print(f"[login] poll every {POLL_SEC}s, max {MAX_MINUTES}m.", flush=True)
        print(f"[login] terminate via {SIGNAL.name}", flush=True)

        deadline = time.time() + MAX_MINUTES * 60
        last_url = ""
        last_cookies = -1
        while time.time() < deadline:
            try:
                ctx.storage_state(path=str(STATE))
                cookies = len(ctx.cookies())
                url = page.url if not page.is_closed() else "<closed>"
                if cookies != last_cookies or url != last_url:
                    print(f"[login] cookies={cookies}  url={url}", flush=True)
                    last_cookies = cookies
                    last_url = url
            except Exception as e:
                print(f"[login] save fail: {str(e)[:100]}",
                      file=sys.stderr, flush=True)
            if SIGNAL.exists():
                print("[login] signal — exiting", flush=True)
                try:
                    ctx.storage_state(path=str(STATE))
                except Exception:
                    pass
                break
            time.sleep(POLL_SEC)

        try:
            ctx.storage_state(path=str(STATE))
            print(f"[login] final state: {STATE.stat().st_size:,}B", flush=True)
        except Exception as e:
            print(f"[login] final save fail: {e}", file=sys.stderr)

        ctx.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
