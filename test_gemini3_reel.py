"""실제 인스타 릴스 영상 다운로드 → Gemini 3 Pro 분석"""
import os
import time
import json
import requests
from pathlib import Path
from dotenv import load_dotenv

ROOT = Path(__file__).parent
load_dotenv(ROOT / ".env")

API_KEY = os.getenv("GEMINI_API_KEY")
HIKER_KEY = os.getenv("HIKER_API_KEY")
MODEL = "gemini-3-pro-preview"

SHORTCODE = "DXWeet6D7dV"
VIDEO_PATH = ROOT / f"_{SHORTCODE}.mp4"
OUT_JSON = ROOT / f"gemini3_reel_{SHORTCODE}.json"

PROMPT = """이 인스타 릴스 영상을 분석해줘. 반드시 JSON 형식으로만 답해.

{
  "duration_sec": <길이>,
  "sound_effects": [
    {"time": "MM:SS", "type": "효과음 종류(벨, 삐-, 댕, 웃음소리, 우우, swoosh 등)", "description": "의도/효과"}
  ],
  "bgm": [
    {"start": "MM:SS", "end": "MM:SS", "mood": "분위기", "genre": "장르", "tempo": "빠르기", "identified": "곡명 알 수 있으면"}
  ],
  "emotion_timeline": [
    {"start": "MM:SS", "end": "MM:SS", "emotion": "happy/sad/angry/surprised/neutral/fearful/excited", "intensity": 0.0~1.0, "source": "speech/music/both", "reason": "근거"}
  ],
  "hook": {"time": "MM:SS", "technique": "어떤 훅 기법(질문/충격/비주얼/효과음)", "why": "왜 강력한지"},
  "narration": {"language": "언어", "tone": "톤(차분/격양/유머 등)", "pace": "말빠르기"},
  "visual_cuts": [
    {"time": "MM:SS", "description": "컷 전환"}
  ],
  "audio_visual_sync_score": 0.0~1.0,
  "sync_analysis": "오디오-비주얼이 얼마나 잘 동기화됐는지 짧게",
  "viral_factors": ["이 릴스가 viral될 만한 요소들"]
}

마크다운 코드블록 쓰지 마. 순수 JSON만."""


def download_video():
    if VIDEO_PATH.exists():
        print(f"[0/4] Already downloaded: {VIDEO_PATH}")
        return
    print(f"[0/4] HikerAPI로 {SHORTCODE} 영상 URL 조회...")
    r = requests.get(
        "https://api.hikerapi.com/v1/media/by/code",
        params={"code": SHORTCODE},
        headers={"accept": "application/json", "x-access-key": HIKER_KEY},
        timeout=30,
    )
    r.raise_for_status()
    data = r.json()
    video_url = data.get("video_url")
    if not video_url:
        raise SystemExit(f"No video_url in response: {list(data.keys())}")
    print(f"      video_url: {video_url[:80]}...")
    print(f"      다운로드 중...")
    vr = requests.get(video_url, timeout=60, stream=True)
    vr.raise_for_status()
    with open(VIDEO_PATH, "wb") as f:
        for chunk in vr.iter_content(8192):
            f.write(chunk)
    size_mb = VIDEO_PATH.stat().st_size / 1024 / 1024
    print(f"      저장됨: {VIDEO_PATH} ({size_mb:.2f} MB)")


def upload_video():
    size = VIDEO_PATH.stat().st_size
    print(f"[1/4] Gemini Files API 업로드 ({size/1024/1024:.2f} MB)...")
    start = requests.post(
        f"https://generativelanguage.googleapis.com/upload/v1beta/files?key={API_KEY}",
        headers={
            "X-Goog-Upload-Protocol": "resumable",
            "X-Goog-Upload-Command": "start",
            "X-Goog-Upload-Header-Content-Length": str(size),
            "X-Goog-Upload-Header-Content-Type": "video/mp4",
            "Content-Type": "application/json",
        },
        json={"file": {"display_name": VIDEO_PATH.name}},
    )
    start.raise_for_status()
    url = start.headers["X-Goog-Upload-URL"]
    with open(VIDEO_PATH, "rb") as f:
        data = f.read()
    up = requests.post(
        url,
        headers={
            "Content-Length": str(size),
            "X-Goog-Upload-Offset": "0",
            "X-Goog-Upload-Command": "upload, finalize",
        },
        data=data,
    )
    up.raise_for_status()
    info = up.json()["file"]

    print("[2/4] 처리 대기...")
    while True:
        st = requests.get(
            f"https://generativelanguage.googleapis.com/v1beta/{info['name']}?key={API_KEY}"
        ).json()
        if st.get("state") == "ACTIVE":
            break
        if st.get("state") == "FAILED":
            raise RuntimeError(st)
        time.sleep(2)
    print(f"      uri: {info['uri']}")
    return info["uri"]


def analyze(uri):
    print(f"[3/4] {MODEL}로 분석 중...")
    t0 = time.time()
    r = requests.post(
        f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent?key={API_KEY}",
        json={
            "contents": [{
                "parts": [
                    {"file_data": {"mime_type": "video/mp4", "file_uri": uri}},
                    {"text": PROMPT},
                ]
            }],
            "generationConfig": {
                "maxOutputTokens": 20000,
                "responseMimeType": "application/json",
            },
        },
        timeout=900,
    )
    elapsed = time.time() - t0
    print(f"      {elapsed:.1f}s, status: {r.status_code}")
    if r.status_code != 200:
        print(r.text[:2000])
        r.raise_for_status()
    body = r.json()
    text = body["candidates"][0]["content"]["parts"][0]["text"]
    return json.loads(text), body.get("usageMetadata", {}), elapsed


def main():
    download_video()
    uri = upload_video()
    result, usage, elapsed = analyze(uri)

    out = {
        "model": MODEL,
        "shortcode": SHORTCODE,
        "video_file": VIDEO_PATH.name,
        "elapsed_sec": elapsed,
        "usage": usage,
        "analysis": result,
    }
    OUT_JSON.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n[4/4] 저장: {OUT_JSON}")
    print(f"\nTokens: in={usage.get('promptTokenCount')} out={usage.get('candidatesTokenCount')} thoughts={usage.get('thoughtsTokenCount')}")
    print(f"Sound effects: {len(result.get('sound_effects', []))}")
    print(f"Emotion segments: {len(result.get('emotion_timeline', []))}")
    print(f"BGM segments: {len(result.get('bgm', []))}")
    print(f"Visual cuts: {len(result.get('visual_cuts', []))}")


if __name__ == "__main__":
    main()
