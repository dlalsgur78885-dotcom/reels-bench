"""오디오만 추출해서 Gemini 3 Pro에 전송 → 비디오 버전이랑 비교"""
import os
import time
import json
import subprocess
import requests
from pathlib import Path
from dotenv import load_dotenv
import imageio_ffmpeg

ROOT = Path(__file__).parent
load_dotenv(ROOT / ".env")

API_KEY = os.getenv("GEMINI_API_KEY")
MODEL = "gemini-3-pro-preview"
FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()

SHORTCODE = "DXWeet6D7dV"
VIDEO_PATH = ROOT / f"_{SHORTCODE}.mp4"
AUDIO_PATH = ROOT / f"_{SHORTCODE}.mp3"
OUT_JSON = ROOT / f"gemini3_audio_{SHORTCODE}.json"

PROMPT = """이 인스타 릴스의 **오디오**를 분석해줘. 반드시 JSON만.

{
  "duration_sec": <길이>,
  "sound_effects": [
    {"time": "MM:SS", "type": "효과음 종류(swoosh/벨/폭발음/웃음 등)", "description": "의도"}
  ],
  "bgm": [
    {"start": "MM:SS", "end": "MM:SS", "mood": "분위기", "genre": "장르", "tempo": "빠르기", "identified": "곡명 알면"}
  ],
  "emotion_timeline": [
    {"start": "MM:SS", "end": "MM:SS", "emotion": "happy/sad/angry/surprised/neutral/fearful/excited", "intensity": 0.0~1.0, "source": "speech/music/both", "reason": "근거"}
  ],
  "narration": {"language": "언어", "tone": "톤", "pace": "말빠르기"},
  "audio_summary": "전체 오디오 구성 한 줄"
}

순수 JSON만. 코드블록 쓰지 마."""


def extract_audio():
    if AUDIO_PATH.exists():
        print(f"[0/4] Already extracted: {AUDIO_PATH}")
        return
    print(f"[0/4] ffmpeg로 오디오 추출 중...")
    subprocess.run(
        [FFMPEG, "-y", "-i", str(VIDEO_PATH), "-vn", "-c:a", "libmp3lame", "-b:a", "128k", str(AUDIO_PATH)],
        check=True, capture_output=True,
    )
    size_kb = AUDIO_PATH.stat().st_size / 1024
    print(f"      저장됨: {AUDIO_PATH.name} ({size_kb:.1f} KB)")


def upload_audio():
    size = AUDIO_PATH.stat().st_size
    print(f"[1/3] 업로드 ({size/1024:.1f} KB)...")
    start = requests.post(
        f"https://generativelanguage.googleapis.com/upload/v1beta/files?key={API_KEY}",
        headers={
            "X-Goog-Upload-Protocol": "resumable",
            "X-Goog-Upload-Command": "start",
            "X-Goog-Upload-Header-Content-Length": str(size),
            "X-Goog-Upload-Header-Content-Type": "audio/mpeg",
            "Content-Type": "application/json",
        },
        json={"file": {"display_name": AUDIO_PATH.name}},
    )
    start.raise_for_status()
    url = start.headers["X-Goog-Upload-URL"]
    with open(AUDIO_PATH, "rb") as f:
        data = f.read()
    up = requests.post(url, headers={
        "Content-Length": str(size),
        "X-Goog-Upload-Offset": "0",
        "X-Goog-Upload-Command": "upload, finalize",
    }, data=data)
    up.raise_for_status()
    info = up.json()["file"]
    print(f"      uri: {info['uri']}")

    print("[2/3] 처리 대기...")
    while True:
        st = requests.get(
            f"https://generativelanguage.googleapis.com/v1beta/{info['name']}?key={API_KEY}"
        ).json()
        if st.get("state") == "ACTIVE":
            break
        if st.get("state") == "FAILED":
            raise RuntimeError(st)
        time.sleep(2)
    return info["uri"]


def analyze(uri):
    print(f"[3/3] {MODEL} 호출...")
    t0 = time.time()
    r = requests.post(
        f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent?key={API_KEY}",
        json={
            "contents": [{
                "parts": [
                    {"file_data": {"mime_type": "audio/mpeg", "file_uri": uri}},
                    {"text": PROMPT},
                ]
            }],
            "generationConfig": {
                "maxOutputTokens": 10000,
                "responseMimeType": "application/json",
            },
        },
        timeout=600,
    )
    elapsed = time.time() - t0
    print(f"      {elapsed:.1f}s, status: {r.status_code}")
    if r.status_code != 200:
        print(r.text[:1500])
        r.raise_for_status()
    body = r.json()
    text = body["candidates"][0]["content"]["parts"][0]["text"]
    return json.loads(text), body.get("usageMetadata", {}), elapsed


def main():
    extract_audio()
    uri = upload_audio()
    result, usage, elapsed = analyze(uri)

    out = {
        "model": MODEL,
        "shortcode": SHORTCODE,
        "input_mode": "audio_only",
        "audio_file": AUDIO_PATH.name,
        "audio_size_bytes": AUDIO_PATH.stat().st_size,
        "elapsed_sec": elapsed,
        "usage": usage,
        "analysis": result,
    }
    OUT_JSON.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n저장: {OUT_JSON}")
    print(f"Tokens: in={usage.get('promptTokenCount')} out={usage.get('candidatesTokenCount')} thoughts={usage.get('thoughtsTokenCount')}")
    print(f"Sound effects: {len(result.get('sound_effects', []))}")
    print(f"Emotion: {len(result.get('emotion_timeline', []))}")
    print(f"BGM: {len(result.get('bgm', []))}")


if __name__ == "__main__":
    main()
