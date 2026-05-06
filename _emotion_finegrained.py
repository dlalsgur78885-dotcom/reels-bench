"""TTS 세그먼트 기준 fine-grained emotion 분석 — Gemini 3 Pro 오디오 호출."""
import os
import sys
import json
import time
import requests
from pathlib import Path
from dotenv import load_dotenv

ROOT = Path(__file__).parent
load_dotenv(ROOT / ".env")

API_KEY = os.getenv("GEMINI_API_KEY")
MODEL = "gemini-3-pro-preview"

SHORTCODE = sys.argv[1] if len(sys.argv) > 1 else "DXf3g2VjZyT"
AUDIO = ROOT / f"_{SHORTCODE}.mp3"
TTS_JSON = ROOT / f"tts_{SHORTCODE}.json"
OUT = ROOT / f"emotion_fine_{SHORTCODE}.json"


def upload(path):
    size = path.stat().st_size
    s = requests.post(
        f"https://generativelanguage.googleapis.com/upload/v1beta/files?key={API_KEY}",
        headers={"X-Goog-Upload-Protocol": "resumable",
                 "X-Goog-Upload-Command": "start",
                 "X-Goog-Upload-Header-Content-Length": str(size),
                 "X-Goog-Upload-Header-Content-Type": "audio/mpeg",
                 "Content-Type": "application/json"},
        json={"file": {"display_name": path.name}})
    s.raise_for_status()
    upload_url = s.headers["X-Goog-Upload-URL"]
    with open(path, "rb") as f:
        data = f.read()
    u = requests.post(upload_url, headers={"Content-Length": str(size),
        "X-Goog-Upload-Offset": "0",
        "X-Goog-Upload-Command": "upload, finalize"}, data=data)
    u.raise_for_status()
    info = u.json()["file"]
    while True:
        st = requests.get(f"https://generativelanguage.googleapis.com/v1beta/{info['name']}?key={API_KEY}").json()
        if st.get("state") == "ACTIVE":
            break
        if st.get("state") == "FAILED":
            raise RuntimeError(st)
        time.sleep(2)
    return info["uri"]


def main():
    tts = json.loads(TTS_JSON.read_text(encoding="utf-8"))
    segs = tts["tts_script"]
    seg_text = "\n".join(f"[{s['start']}-{s['end']}s] direction={s['direction']} text={s['text']}" for s in segs)

    uri = upload(AUDIO)
    prompt = f"""아래는 인스타 릴스 오디오와, 이미 추출된 발화 세그먼트(TTS direction)야.
각 세그먼트의 **감정 + 전달 방식 + 인간 반응/타이밍 이벤트**를 세분화해서 분석해줘.
같은 문장 안에서 감정이 변하면 쪼개도 됨.

세그먼트:
{seg_text}

# 감정 태그 (14)
excited(흥분/신난), happy(행복), sad(슬픈), crying(우는), angry(화난),
nervous(긴장/불안), curious(호기심), serious(진지한), tired(피곤한), calm(차분한),
frustrated(좌절), cheerful(명랑), sarcastic(비꼬는), mischievously(장난스러운)

# 전달 방식 (delivery, 4 + normal)
whispers(속삭임), shouts(소리침), slowly(천천히), very_fast(매우 빠름), normal(보통)

# 오디오 이벤트 — 시점 단위 (audio_events)
- 인간 반응/소리: laughs(웃음 짧음), laughing(웃고있음/긴 웃음), sighs(한숨), clears_throat(헛기침), gulps(침삼킴), gasps(숨헐떡)
- 타이밍/리듬: pause(멈춤), hesitates(망설임)

JSON만:
{{
  "emotion_timeline": [
    {{"start": "0.0", "end": "1.9",
      "emotion": "excited|happy|sad|crying|angry|nervous|curious|serious|tired|calm|frustrated|cheerful|sarcastic|mischievously",
      "intensity": 0.0~1.0,
      "delivery": "whispers|shouts|slowly|very_fast|normal",
      "source": "speech|music|both",
      "reason": "근거 (목소리 톤/BGM/단어 등)"}}
  ],
  "audio_events": [
    {{"time": "1.5",
      "event": "laughs|laughing|sighs|clears_throat|gulps|gasps|pause|hesitates",
      "reason": "근거"}}
  ]
}}

규칙:
- 각 TTS 세그먼트마다 emotion_timeline 최소 1개 필수.
- 전달 방식이 평범하면 delivery="normal".
- audio_events는 실제로 들리는 이벤트만. 없으면 빈 배열.
- 코드블록 X."""

    print(f"calling {MODEL}...")
    t0 = time.time()
    r = requests.post(
        f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent?key={API_KEY}",
        json={"contents": [{"parts": [
                {"file_data": {"mime_type": "audio/mpeg", "file_uri": uri}},
                {"text": prompt}]}],
              "generationConfig": {"maxOutputTokens": 16000,
                                   "responseMimeType": "application/json"}},
        timeout=600)
    elapsed = time.time() - t0
    print(f"  {elapsed:.1f}s status={r.status_code}")
    if r.status_code != 200:
        print(r.text[:1500])
        sys.exit()
    body = r.json()
    raw = body["candidates"][0]["content"]["parts"][0]["text"]
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        # Gemini가 객체 두 개 이어붙이는 경우 → 첫 객체만 추출
        dec = json.JSONDecoder()
        parsed, _ = dec.raw_decode(raw.lstrip())
    out = {"shortcode": SHORTCODE, "model": MODEL, "elapsed_sec": elapsed,
           "usage": body.get("usageMetadata", {}),
           "emotion_timeline": parsed.get("emotion_timeline", []),
           "audio_events": parsed.get("audio_events", [])}
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"saved: {OUT}")
    for e in out["emotion_timeline"]:
        deliv = e.get("delivery", "normal")
        print(f"  [{e['start']}-{e['end']}s] {e['emotion']} ({e.get('intensity')}) deliv={deliv} — {e.get('reason','')}")
    for ev in out["audio_events"]:
        print(f"  @{ev['time']}s {ev['event']} — {ev.get('reason','')}")


if __name__ == "__main__":
    main()
