"""extra_cache/*.json의 sentences를 reels_transcripts.segments로 일괄 마이그레이션."""
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
     "Content-Type": "application/json", "Prefer": "return=minimal"}


def update(shortcode, segments):
    r = requests.patch(
        f"{SUPA}/rest/v1/reels_transcripts?shortcode=eq.{shortcode}",
        headers=H, json={"segments": segments}, timeout=15,
    )
    return r.status_code in (200, 204)


def insert_if_missing(shortcode, transcript_text, segments):
    """transcripts row 없으면 만들기."""
    r = requests.get(
        f"{SUPA}/rest/v1/reels_transcripts?shortcode=eq.{shortcode}&select=shortcode&limit=1",
        headers={"apikey": KEY, "Authorization": f"Bearer {KEY}"}, timeout=10
    )
    if r.json():
        return update(shortcode, segments)
    # insert
    payload = {"shortcode": shortcode, "transcript": transcript_text, "segments": segments}
    r2 = requests.post(
        f"{SUPA}/rest/v1/reels_transcripts",
        headers=H, json=payload, timeout=15
    )
    return r2.status_code in (200, 201, 204)


def process(jp):
    sc = jp.stem
    try:
        d = json.loads(jp.read_text(encoding="utf-8"))
        sentences = d.get("sentences") or []
        if not sentences:
            return sc, "no_sentences"
        # transcript 텍스트 합치기 (insert 시 사용)
        transcript = " ".join(s.get("text", "") for s in sentences).strip()
        ok = insert_if_missing(sc, transcript, sentences)
        return sc, "updated" if ok else "fail"
    except Exception as e:
        return sc, f"err:{e}"


def main():
    cache_dir = ROOT / "extra_cache"
    files = sorted(cache_dir.glob("*.json"))
    print(f"대상 파일: {len(files)}")
    counts = {}
    with ThreadPoolExecutor(max_workers=6) as ex:
        for i, f in enumerate(as_completed([ex.submit(process, p) for p in files]), 1):
            sc, status = f.result()
            key = status.split(":")[0]
            counts[key] = counts.get(key, 0) + 1
            if i % 20 == 0 or i == len(files):
                print(f"  {i}/{len(files)}  {counts}")
    print(f"\n결과: {counts}")


if __name__ == "__main__":
    main()
