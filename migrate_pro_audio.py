"""extra_cache/*.json 의 audio_emotions / bgm_changes / pro_audio → reels_pro_audio."""
import json
import os
import sys
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed
import requests
from dotenv import load_dotenv

ROOT = Path(__file__).parent
load_dotenv(ROOT / ".env")

SUPA = os.getenv("SUPABASE_URL")
KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_ANON_KEY")
H = {"apikey": KEY, "Authorization": f"Bearer {KEY}",
     "Content-Type": "application/json",
     "Prefer": "resolution=merge-duplicates,return=minimal"}


def upsert(shortcode, audio_emotions, bgm_changes, pro_audio):
    payload = {
        "shortcode": shortcode,
        "audio_emotions": audio_emotions,
        "bgm_changes": bgm_changes,
        "pro_audio": pro_audio,
    }
    r = requests.post(
        f"{SUPA}/rest/v1/reels_pro_audio?on_conflict=shortcode",
        headers=H, json=payload, timeout=15,
    )
    return r.status_code in (200, 201, 204)


def process(jp):
    sc = jp.stem
    try:
        d = json.loads(jp.read_text(encoding="utf-8"))
        ae = d.get("audio_emotions") or {}
        bc = d.get("bgm_changes") or []
        pa = d.get("pro_audio")
        if not ae and not bc and not pa:
            return sc, "empty"
        ok = upsert(sc, ae, bc, pa)
        return sc, "ok" if ok else "fail"
    except Exception as e:
        return sc, f"err:{e}"


def main():
    files = sorted((ROOT / "extra_cache").glob("*.json"))
    print(f"대상: {len(files)}")
    counts = {}
    with ThreadPoolExecutor(max_workers=6) as ex:
        for i, f in enumerate(as_completed([ex.submit(process, p) for p in files]), 1):
            sc, status = f.result()
            key = status.split(":")[0]
            counts[key] = counts.get(key, 0) + 1
            if i % 30 == 0 or i == len(files):
                print(f"  {i}/{len(files)}  {counts}")
    print(f"\n결과: {counts}")


if __name__ == "__main__":
    main()
