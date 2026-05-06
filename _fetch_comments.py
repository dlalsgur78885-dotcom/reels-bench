"""Playwright로 댓글 수집 → reels_comments 저장.

usage: python _fetch_comments.py <shortcode>
"""
from __future__ import annotations

import os
import sys
from pathlib import Path
from dotenv import load_dotenv
import requests

ROOT = Path(__file__).parent
load_dotenv(ROOT / ".env")
sys.path.insert(0, str(ROOT))

from api.services import comments  # noqa: E402

if len(sys.argv) < 2:
    sys.exit("usage: python _fetch_comments.py <shortcode>")

SC = sys.argv[1]
SUPA = os.getenv("SUPABASE_URL")
KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_ANON_KEY")

# 이미 있으면 skip
existing = requests.get(
    f"{SUPA}/rest/v1/reels_comments?shortcode=eq.{SC}&select=shortcode&limit=1",
    headers={"apikey": KEY, "Authorization": f"Bearer {KEY}"},
    timeout=10,
).json()
if existing:
    print(f"[comments] {SC} already has {len(existing)}+ rows, skip")
    sys.exit(0)

print(f"[comments] fetching via Playwright {SC}...")
cmts = comments.fetch_playwright(SC)
print(f"[comments] got {len(cmts)} comments")
if cmts:
    r = requests.post(
        f"{SUPA}/rest/v1/reels_comments",
        headers={
            "apikey": KEY,
            "Authorization": f"Bearer {KEY}",
            "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates,return=minimal",
        },
        json=cmts,
        timeout=20,
    )
    print(f"[comments] DB insert: {r.status_code}")
