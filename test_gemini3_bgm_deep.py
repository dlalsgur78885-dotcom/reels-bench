"""BGM 변화 구간 전용 프롬프트로 재분석"""
import os, time, json, requests, subprocess
from pathlib import Path
from dotenv import load_dotenv
import imageio_ffmpeg

ROOT = Path(__file__).parent
load_dotenv(ROOT / ".env")

API_KEY = os.getenv("GEMINI_API_KEY")
MODEL = "gemini-3-pro-preview"
FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()

SHORTCODE = "C59orfLPDZw"  # librosa가 BGM 변화 4개 감지했던 릴스
VIDEO_PATH = ROOT / f"_{SHORTCODE}.mp4"
AUDIO_PATH = ROOT / f"_{SHORTCODE}.mp3"
OUT_JSON = ROOT / f"gemini3_bgm_deep_{SHORTCODE}.json"

PROMPT = """이 오디오의 **BGM 변화**를 정밀하게 분석해줘. 반드시 JSON만.

**중요**:
- 릴스 중간에 BGM이 바뀌거나 다른 곡으로 전환되는 구간을 **빠짐없이** 잡아내줘.
- 같은 곡의 다른 섹션(intro→verse→chorus)도 분위기가 확 바뀌면 별도 구간.
- BGM이 잠시 멈추는 구간(무음/voiceover only)도 표시.
- 곡이 확실히 식별되면 아티스트-곡명 형식.

{
  "duration_sec": <길이>,
  "bgm_segments": [
    {
      "start": "MM:SS",
      "end": "MM:SS",
      "state": "playing/paused/transition",
      "mood": "분위기",
      "genre": "장르",
      "tempo_bpm": <추정 BPM 숫자>,
      "volume_level": "high/medium/low/muted",
      "identified": "아티스트 - 곡명 또는 unknown",
      "change_reason": "이 구간이 이전 구간과 왜 다른지 (곡 바뀜/템포 변화/볼륨 변화/섹션 전환 등)"
    }
  ],
  "total_transitions": <BGM 전환 횟수>,
  "narration_only_segments": [
    {"start": "MM:SS", "end": "MM:SS", "reason": "BGM 없이 내레이션만 있는 구간"}
  ],
  "analysis_note": "BGM 구성 총평 한 줄"
}

절대 순수 JSON만."""


def extract_audio():
    if AUDIO_PATH.exists():
        print(f"[0/3] Already: {AUDIO_PATH.name}")
        return
    print("[0/3] 오디오 추출...")
    subprocess.run([FFMPEG, "-y", "-i", str(VIDEO_PATH), "-vn", "-c:a", "libmp3lame", "-b:a", "128k", str(AUDIO_PATH)],
        check=True, capture_output=True)


def upload():
    size = AUDIO_PATH.stat().st_size
    print(f"[1/3] 업로드 ({size/1024:.1f} KB)")
    start = requests.post(
        f"https://generativelanguage.googleapis.com/upload/v1beta/files?key={API_KEY}",
        headers={"X-Goog-Upload-Protocol": "resumable", "X-Goog-Upload-Command": "start",
                 "X-Goog-Upload-Header-Content-Length": str(size),
                 "X-Goog-Upload-Header-Content-Type": "audio/mpeg", "Content-Type": "application/json"},
        json={"file": {"display_name": AUDIO_PATH.name}})
    start.raise_for_status()
    url = start.headers["X-Goog-Upload-URL"]
    with open(AUDIO_PATH, "rb") as f: data = f.read()
    up = requests.post(url, headers={"Content-Length": str(size), "X-Goog-Upload-Offset": "0",
        "X-Goog-Upload-Command": "upload, finalize"}, data=data)
    up.raise_for_status()
    info = up.json()["file"]
    while True:
        st = requests.get(f"https://generativelanguage.googleapis.com/v1beta/{info['name']}?key={API_KEY}").json()
        if st.get("state") == "ACTIVE": break
        if st.get("state") == "FAILED": raise RuntimeError(st)
        time.sleep(2)
    return info["uri"]


def analyze(uri):
    print(f"[2/3] {MODEL} BGM 심층 분석...")
    t0 = time.time()
    r = requests.post(
        f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent?key={API_KEY}",
        json={"contents": [{"parts": [
            {"file_data": {"mime_type": "audio/mpeg", "file_uri": uri}},
            {"text": PROMPT}]}],
            "generationConfig": {"maxOutputTokens": 12000, "responseMimeType": "application/json"}},
        timeout=600)
    elapsed = time.time() - t0
    print(f"   {elapsed:.1f}s, status: {r.status_code}")
    if r.status_code != 200:
        print(r.text[:1500]); r.raise_for_status()
    body = r.json()
    return json.loads(body["candidates"][0]["content"]["parts"][0]["text"]), body.get("usageMetadata", {}), elapsed


def main():
    extract_audio()
    uri = upload()
    result, usage, elapsed = analyze(uri)
    out = {"model": MODEL, "shortcode": SHORTCODE, "elapsed_sec": elapsed, "usage": usage, "analysis": result}
    OUT_JSON.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n[3/3] 저장: {OUT_JSON.name}")
    print(f"Total transitions: {result.get('total_transitions')}")
    print(f"BGM segments: {len(result.get('bgm_segments', []))}")
    print(f"Narration-only: {len(result.get('narration_only_segments', []))}")
    print(f"Tokens: in={usage.get('promptTokenCount')} out={usage.get('candidatesTokenCount')} think={usage.get('thoughtsTokenCount')}")


if __name__ == "__main__":
    main()
