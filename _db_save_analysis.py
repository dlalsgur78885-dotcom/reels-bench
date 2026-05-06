"""analysis_<sc>.json → reels_pro_audio.pro_audio 컬럼 upsert."""
import os
import sys
import json
import requests
from pathlib import Path
from dotenv import load_dotenv

ROOT = Path(__file__).parent
load_dotenv(ROOT / ".env")
SUPA = os.getenv("SUPABASE_URL")
KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
H = {"apikey": KEY, "Authorization": f"Bearer {KEY}",
     "Content-Type": "application/json",
     "Prefer": "resolution=merge-duplicates,return=minimal"}

SHORTCODE = sys.argv[1] if len(sys.argv) > 1 else None
if not SHORTCODE:
    sys.exit("usage: python _db_save_analysis.py <shortcode>")

src = ROOT / f"analysis_{SHORTCODE}.json"
if not src.exists():
    sys.exit(f"missing: {src}")

doc = json.loads(src.read_text(encoding="utf-8"))
pro_audio = {
    **doc["analysis"],
    "_meta": {
        "model": doc.get("model"),
        "video_file": doc.get("video_file"),
        "elapsed_sec": doc.get("elapsed_sec"),
        "usage": doc.get("usage"),
    },
}

r = requests.post(
    f"{SUPA}/rest/v1/reels_pro_audio?on_conflict=shortcode",
    headers=H,
    json={"shortcode": SHORTCODE, "pro_audio": pro_audio},
    timeout=20,
)
print(f"[{SHORTCODE}] status={r.status_code}")
if r.status_code not in (200, 201, 204):
    print(r.text[:800])
    sys.exit(1)

# 검증
v = requests.get(
    f"{SUPA}/rest/v1/reels_pro_audio?shortcode=eq.{SHORTCODE}&select=shortcode,pro_audio",
    headers={"apikey": KEY, "Authorization": f"Bearer {KEY}"}, timeout=10,
).json()
if v:
    pa = v[0].get("pro_audio") or {}
    print(f"  emotion={len(pa.get('emotion_timeline',[]))} | tts={len(pa.get('tts_script',[]))} | "
          f"cuts={len(pa.get('visual_cuts',[]))} | bgm={len(pa.get('bgm',[]))} | sfx={len(pa.get('sound_effects',[]))}")
