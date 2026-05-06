"""TTS용 발화 지시 추출 — sentences + 영상 → Gemini 3 Pro로 각 문장별 direction."""
import os
import sys
import json
import time
import subprocess
import requests
from pathlib import Path
from dotenv import load_dotenv
import imageio_ffmpeg

ROOT = Path(__file__).parent
load_dotenv(ROOT / ".env")
sys.path.insert(0, str(ROOT))

API_KEY = os.getenv("GEMINI_API_KEY")
HIKER = os.getenv("HIKER_API_KEY")
SUPA = os.getenv("SUPABASE_URL")
SK = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
MODEL = "gemini-3-pro-preview"
FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()

SHORTCODE = sys.argv[1] if len(sys.argv) > 1 else "C9trAtRJapd"
VIDEO = ROOT / f"_{SHORTCODE}.mp4"
AUDIO = ROOT / f"_{SHORTCODE}.mp3"
OUT = ROOT / f"tts_{SHORTCODE}.json"


def get_sentences():
    r = requests.get(
        f"{SUPA}/rest/v1/reels_transcripts?shortcode=eq.{SHORTCODE}&select=segments&limit=1",
        headers={"apikey": SK, "Authorization": f"Bearer {SK}"}, timeout=15,
    )
    rows = r.json()
    return rows[0].get("segments", []) if rows else []


def download_video():
    if VIDEO.exists():
        return
    r = requests.get("https://api.hikerapi.com/v1/media/by/code",
        params={"code": SHORTCODE},
        headers={"accept": "application/json", "x-access-key": HIKER}, timeout=30)
    url = r.json().get("video_url")
    if not url:
        sys.exit("video_url 없음")
    vr = requests.get(url, timeout=60, stream=True)
    with open(VIDEO, "wb") as f:
        for chunk in vr.iter_content(8192):
            f.write(chunk)
    print(f"video downloaded: {VIDEO.stat().st_size/1024/1024:.1f} MB")


def extract_audio():
    if not AUDIO.exists():
        subprocess.run([FFMPEG, "-y", "-i", str(VIDEO), "-vn",
                        "-c:a", "libmp3lame", "-b:a", "128k", str(AUDIO)],
                       check=True, capture_output=True)


def upload(path):
    size = path.stat().st_size
    mime = "audio/mpeg" if path.suffix == ".mp3" else "video/mp4"
    s = requests.post(
        f"https://generativelanguage.googleapis.com/upload/v1beta/files?key={API_KEY}",
        headers={"X-Goog-Upload-Protocol": "resumable",
                 "X-Goog-Upload-Command": "start",
                 "X-Goog-Upload-Header-Content-Length": str(size),
                 "X-Goog-Upload-Header-Content-Type": mime,
                 "Content-Type": "application/json"},
        json={"file": {"display_name": path.name}})
    s.raise_for_status()
    upload_url = s.headers["X-Goog-Upload-URL"]
    with open(path, "rb") as f: data = f.read()
    u = requests.post(upload_url, headers={"Content-Length": str(size),
        "X-Goog-Upload-Offset": "0",
        "X-Goog-Upload-Command": "upload, finalize"}, data=data)
    u.raise_for_status()
    info = u.json()["file"]
    while True:
        st = requests.get(f"https://generativelanguage.googleapis.com/v1beta/{info['name']}?key={API_KEY}").json()
        if st.get("state") == "ACTIVE": break
        if st.get("state") == "FAILED": raise RuntimeError(st)
        time.sleep(2)
    return info["uri"], mime


def main():
    sents = get_sentences()
    if not sents:
        sys.exit(f"{SHORTCODE} sentences 없음")
    print(f"sentences: {len(sents)}")

    download_video()
    extract_audio()
    uri, mime = upload(AUDIO)

    sentences_text = "\n".join(
        f"[{s['start']}-{s['end']}] {s['text']}" for s in sents
    )

    prompt = f"""아래는 영상의 오디오 트랙이고 [start-end] 형식으로 문장별 타임스탬프와 텍스트가 있어.
각 문장이 **어떻게 발화됐는지** 듣고 TTS(text-to-speech) 재현용 발화 지시(direction)를 작성해줘.

지시는 반드시 **"형용사 + 동사"** 형식. 부사 + 발화동사 조합.
예시:
- "차분하게 중얼거린다"
- "흥분되게 외친다"
- "한숨쉬며 말한다"
- "단호하게 강조한다"
- "떨리는 목소리로 속삭인다"
- "웃으며 답한다"
- "낮게 으르렁거린다"
- "당황하며 더듬는다"

원문:
{sentences_text}

출력 형식 (JSON만):
{{
  "tts_script": [
    {{"start": "0.0", "end": "2.8", "direction": "차분하게 중얼거린다", "text": "어제 한 손님이..."}},
    ...
  ]
}}

각 문장에 direction 필수. 반드시 형용사+동사. text는 원문 그대로. JSON 외 다른 텍스트 X."""

    print(f"calling {MODEL}...")
    t0 = time.time()
    r = requests.post(
        f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent?key={API_KEY}",
        json={"contents": [{"parts": [
                {"file_data": {"mime_type": mime, "file_uri": uri}},
                {"text": prompt}]}],
              "generationConfig": {"maxOutputTokens": 16000,
                                   "responseMimeType": "application/json"}},
        timeout=600,
    )
    elapsed = time.time() - t0
    print(f"  {elapsed:.1f}s status={r.status_code}")
    if r.status_code != 200:
        print(r.text[:1500]); sys.exit()
    body = r.json()
    text = body["candidates"][0]["content"]["parts"][0]["text"]
    parsed = json.loads(text)

    OUT.write_text(json.dumps(parsed, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\nsaved: {OUT}")
    print(f"\n=== TTS Script ({len(parsed.get('tts_script', []))}개) ===\n")
    for s in parsed.get("tts_script", []):
        d = s.get("direction", "")
        print(f"  [{s['start']}-{s['end']}] ({d}) {s['text']}")

    # DB 저장 (reels_pro_audio.pro_audio.tts_script 같은 식 또는 별도 컬럼)
    # 일단 PoC: pro_audio JSONB에 추가
    print("\nDB 저장 중...")
    requests.patch(
        f"{SUPA}/rest/v1/reels_pro_audio?shortcode=eq.{SHORTCODE}",
        headers={"apikey": SK, "Authorization": f"Bearer {SK}",
                 "Content-Type": "application/json", "Prefer": "return=minimal"},
        json={"pro_audio": {**(get_pro_audio() or {}), "tts_script": parsed.get("tts_script", [])}},
        timeout=15,
    )
    print("DB 저장 완료")


def get_pro_audio():
    r = requests.get(
        f"{SUPA}/rest/v1/reels_pro_audio?shortcode=eq.{SHORTCODE}&select=pro_audio&limit=1",
        headers={"apikey": SK, "Authorization": f"Bearer {SK}"}, timeout=10)
    rows = r.json()
    if not rows:
        # row 없으면 만들어두기
        requests.post(f"{SUPA}/rest/v1/reels_pro_audio?on_conflict=shortcode",
            headers={"apikey": SK, "Authorization": f"Bearer {SK}",
                     "Content-Type": "application/json",
                     "Prefer": "resolution=merge-duplicates,return=minimal"},
            json={"shortcode": SHORTCODE}, timeout=10)
        return {}
    return rows[0].get("pro_audio") or {}


if __name__ == "__main__":
    main()
