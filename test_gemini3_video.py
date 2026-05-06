"""Gemini 3 Pro 영상+오디오 통합 분석 테스트

효과음 위치 / BGM / 감정 변화를 타임스탬프 단위로 뽑는다.
"""
import os
import time
import json
import requests
from pathlib import Path
from dotenv import load_dotenv

ROOT = Path(__file__).parent
load_dotenv(ROOT / ".env")

API_KEY = os.getenv("GEMINI_API_KEY")
MODEL = "gemini-3-pro-preview"

VIDEO_PATH = ROOT / "녹음 2026-04-07 034010.mp4"
OUT_JSON = ROOT / "gemini3_test_result.json"

PROMPT = """이 인스타 릴스 영상을 분석해줘. 다음 항목을 **반드시 JSON 형식**으로만 출력해.

{
  "duration_sec": <영상 전체 길이(초)>,
  "sound_effects": [
    {"time": "MM:SS", "type": "효과음 종류(벨, 삐-, 댕, 웃음소리 등)", "description": "어떤 의도로 쓰였는지"}
  ],
  "bgm": [
    {"start": "MM:SS", "end": "MM:SS", "description": "BGM 특징(장르, 분위기, 템포)", "identified": "곡명 알 수 있으면"}
  ],
  "emotion_timeline": [
    {"start": "MM:SS", "end": "MM:SS", "emotion": "happy/sad/angry/surprised/neutral/excited 등", "confidence": 0.0~1.0, "source": "speech/music/both", "reason": "판단 근거"}
  ],
  "hook_moment": {"time": "MM:SS", "why": "이 구간이 시청 유지에 중요한 이유"},
  "visual_cuts": [
    {"time": "MM:SS", "description": "컷 전환 내용"}
  ],
  "overall": {
    "mood": "전체 무드 한 문장",
    "audio_visual_sync": "오디오-비주얼이 얼마나 잘 맞물리는지 평가"
  }
}

JSON 외 다른 텍스트는 절대 쓰지 마. 마크다운 코드블록도 쓰지 마."""


def upload_video(path: Path) -> str:
    """Files API로 영상 업로드하고 uri 반환"""
    size = path.stat().st_size
    mime = "video/mp4"
    print(f"[1/3] Uploading {path.name} ({size/1024/1024:.2f} MB)...")

    start_resp = requests.post(
        f"https://generativelanguage.googleapis.com/upload/v1beta/files?key={API_KEY}",
        headers={
            "X-Goog-Upload-Protocol": "resumable",
            "X-Goog-Upload-Command": "start",
            "X-Goog-Upload-Header-Content-Length": str(size),
            "X-Goog-Upload-Header-Content-Type": mime,
            "Content-Type": "application/json",
        },
        json={"file": {"display_name": path.name}},
    )
    start_resp.raise_for_status()
    upload_url = start_resp.headers["X-Goog-Upload-URL"]

    with open(path, "rb") as f:
        data = f.read()
    up_resp = requests.post(
        upload_url,
        headers={
            "Content-Length": str(size),
            "X-Goog-Upload-Offset": "0",
            "X-Goog-Upload-Command": "upload, finalize",
        },
        data=data,
    )
    up_resp.raise_for_status()
    file_info = up_resp.json()["file"]
    uri = file_info["uri"]
    name = file_info["name"]
    print(f"    Uploaded: {uri}")

    print("[2/3] Waiting for processing...")
    while True:
        info = requests.get(
            f"https://generativelanguage.googleapis.com/v1beta/{name}?key={API_KEY}"
        ).json()
        state = info.get("state", "UNKNOWN")
        if state == "ACTIVE":
            break
        if state == "FAILED":
            raise RuntimeError(f"File processing failed: {info}")
        time.sleep(2)
    print(f"    State: ACTIVE")
    return uri, mime


def analyze(uri: str, mime: str) -> dict:
    print(f"[3/3] Analyzing with {MODEL}...")
    t0 = time.time()
    resp = requests.post(
        f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent?key={API_KEY}",
        json={
            "contents": [{
                "parts": [
                    {"file_data": {"mime_type": mime, "file_uri": uri}},
                    {"text": PROMPT},
                ]
            }],
            "generationConfig": {
                "maxOutputTokens": 16384,
                "responseMimeType": "application/json",
            },
        },
        timeout=600,
    )
    elapsed = time.time() - t0
    print(f"    Elapsed: {elapsed:.1f}s, status: {resp.status_code}")
    if resp.status_code != 200:
        print(resp.text[:2000])
        resp.raise_for_status()

    body = resp.json()
    text = body["candidates"][0]["content"]["parts"][0]["text"]
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        print("raw text:")
        print(text[:1500])
        raise
    return parsed, body.get("usageMetadata", {}), elapsed


def main():
    if not VIDEO_PATH.exists():
        raise SystemExit(f"Video not found: {VIDEO_PATH}")

    uri, mime = upload_video(VIDEO_PATH)
    result, usage, elapsed = analyze(uri, mime)

    output = {
        "model": MODEL,
        "video": VIDEO_PATH.name,
        "elapsed_sec": elapsed,
        "usage": usage,
        "analysis": result,
    }
    OUT_JSON.write_text(
        json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"\nSaved: {OUT_JSON}")
    print(f"Tokens: in={usage.get('promptTokenCount', '?')} out={usage.get('candidatesTokenCount', '?')}")
    print(f"\n=== Summary ===")
    print(f"Sound effects: {len(result.get('sound_effects', []))}")
    print(f"Emotion segments: {len(result.get('emotion_timeline', []))}")
    print(f"BGM segments: {len(result.get('bgm', []))}")


if __name__ == "__main__":
    main()
