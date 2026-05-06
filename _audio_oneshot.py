"""오디오 통합 분석: TTS direction + emotion timeline + audio_events 단일 Gemini 호출.

기존 _tts_oneshot.py + _emotion_finegrained.py 두 개 호출을 1개로 합쳐 비용/시간 절감.
출력은 호환성 유지 — `tts_<sc>.json`, `emotion_fine_<sc>.json` 두 파일로 분리 저장.
"""
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

GEMINI_KEY = os.getenv("GEMINI_API_KEY")
OPENAI_KEY = os.getenv("OPENAI_API_KEY")
HIKER = os.getenv("HIKER_API_KEY")
MODEL = "gemini-3-pro-preview"
FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()

SHORTCODE = sys.argv[1] if len(sys.argv) > 1 else "DXf3g2VjZyT"
VIDEO = ROOT / f"_{SHORTCODE}.mp4"
AUDIO = ROOT / f"_{SHORTCODE}.mp3"
OUT_TTS = ROOT / f"tts_{SHORTCODE}.json"
OUT_EMO = ROOT / f"emotion_fine_{SHORTCODE}.json"


def download_video():
    if VIDEO.exists():
        return
    r = requests.get("https://api.hikerapi.com/v1/media/by/code",
        params={"code": SHORTCODE},
        headers={"accept": "application/json", "x-access-key": HIKER}, timeout=30)
    url = r.json().get("video_url")
    if not url:
        sys.exit(f"video_url 없음: {r.text[:300]}")
    vr = requests.get(url, timeout=60, stream=True)
    with open(VIDEO, "wb") as f:
        for chunk in vr.iter_content(8192):
            f.write(chunk)


def extract_audio():
    if AUDIO.exists():
        return
    subprocess.run([FFMPEG, "-y", "-i", str(VIDEO), "-vn",
                    "-c:a", "libmp3lame", "-b:a", "128k", str(AUDIO)],
                   check=True, capture_output=True)


def whisper_segments():
    print("calling whisper-1...")
    with open(AUDIO, "rb") as f:
        r = requests.post(
            "https://api.openai.com/v1/audio/transcriptions",
            headers={"Authorization": f"Bearer {OPENAI_KEY}"},
            files={"file": (AUDIO.name, f, "audio/mpeg")},
            data={"model": "whisper-1", "language": "ko",
                  "response_format": "verbose_json",
                  "timestamp_granularities[]": "segment"},
            timeout=180,
        )
    r.raise_for_status()
    res = r.json()
    segs = [{"start": s["start"], "end": s["end"], "text": s["text"].strip()}
            for s in res.get("segments", [])]
    print(f"  duration: {res.get('duration', 0):.1f}s, segments: {len(segs)}")
    return segs


def upload(path):
    size = path.stat().st_size
    s = requests.post(
        f"https://generativelanguage.googleapis.com/upload/v1beta/files?key={GEMINI_KEY}",
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
        st = requests.get(f"https://generativelanguage.googleapis.com/v1beta/{info['name']}?key={GEMINI_KEY}").json()
        if st.get("state") == "ACTIVE":
            break
        if st.get("state") == "FAILED":
            raise RuntimeError(st)
        time.sleep(2)
    return info["uri"]


def gemini_combined(uri, sents):
    sentences_text = "\n".join(
        f"[{s['start']:.1f}-{s['end']:.1f}] {s['text']}" for s in sents
    )
    prompt = f"""아래는 영상의 오디오 트랙이고 [start-end] 형식으로 문장별 타임스탬프와 텍스트야.
**3가지 작업을 동시에 수행해서 단일 JSON으로 응답.**

# 작업 1: TTS direction (각 문장)
**부사 + 발화동사** 두 단어 조합. 부사는 반드시 `-게/-히/-며/-듯이` 어미.
✓ OK: "차분하게 중얼거린다", "흥분되게 외친다", "단호하게 강조한다",
       "한숨쉬며 말한다", "또박또박 말한다", "감정적으로 호소한다"
✗ 금지: "만족스러운 표정으로 평가한다" (명사+조사 사용 X)
        "차분한 목소리로 말한다"        (명사+조사 사용 X)
        "기쁘게 웃는다"                  (웃다는 발화동사 X)
규칙: 명사+조사("표정으로", "목소리로", "톤으로") 사용 금지. 한 단어 부사 + 한 단어 발화동사만.

# 작업 2: 감정 타임라인 (각 문장 최소 1개, 같은 문장 안에서 변하면 쪼개도 됨)
- 감정 14: excited(흥분/신난), happy(행복), sad(슬픈), crying(우는), angry(화난),
  nervous(긴장/불안), curious(호기심), serious(진지한), tired(피곤한), calm(차분한),
  frustrated(좌절), cheerful(명랑), sarcastic(비꼬는), mischievously(장난스러운)
- 전달 방식 (delivery): whispers(속삭임), shouts(소리침), slowly(천천히), very_fast(매우 빠름), normal(보통)

# 작업 3: 오디오 이벤트 (시점 단위, 실제로 들리는 것만)
- 인간 반응: laughs, laughing, sighs, clears_throat, gulps, gasps
- 타이밍: pause, hesitates

원문:
{sentences_text}

JSON만 (코드블록 X):
{{
  "tts_script": [
    {{"start": "0.0", "end": "2.8", "direction": "차분하게 중얼거린다", "text": "원문 그대로"}}
  ],
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
"""

    print(f"calling {MODEL} (combined)...")
    t0 = time.time()
    r = requests.post(
        f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent?key={GEMINI_KEY}",
        json={"contents": [{"parts": [
                {"file_data": {"mime_type": "audio/mpeg", "file_uri": uri}},
                {"text": prompt}]}],
              "generationConfig": {"maxOutputTokens": 24000,
                                   "responseMimeType": "application/json"}},
        timeout=600,
    )
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
        dec = json.JSONDecoder()
        parsed, _ = dec.raw_decode(raw.lstrip())
    return parsed, body.get("usageMetadata", {}), elapsed


def main():
    download_video()
    extract_audio()
    sents = whisper_segments()
    if not sents:
        sys.exit("Whisper segments 없음")
    uri = upload(AUDIO)
    parsed, usage, elapsed = gemini_combined(uri, sents)

    # parsed가 list로 올 수 있음 — array wrap 풀기
    if isinstance(parsed, list):
        parsed = parsed[0] if parsed else {}
    if not isinstance(parsed, dict):
        parsed = {}

    tts_out = {
        "shortcode": SHORTCODE, "model": MODEL,
        "whisper_segments": len(sents),
        "usage": usage,  # 전체 통합 호출 usage (tts/emotion 분리 불가)
        "tts_script": parsed.get("tts_script", []),
    }
    emo_out = {
        "shortcode": SHORTCODE, "model": MODEL, "elapsed_sec": elapsed,
        "usage": {},  # 통합 호출이라 emotion 단독 usage 없음 (tts에 합산됨)
        "emotion_timeline": parsed.get("emotion_timeline", []),
        "audio_events": parsed.get("audio_events", []),
    }
    OUT_TTS.write_text(json.dumps(tts_out, ensure_ascii=False, indent=2), encoding="utf-8")
    OUT_EMO.write_text(json.dumps(emo_out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"saved: {OUT_TTS}")
    print(f"saved: {OUT_EMO}")
    print(f"  tts segs: {len(tts_out['tts_script'])}")
    print(f"  emotion segs: {len(emo_out['emotion_timeline'])}")
    print(f"  audio events: {len(emo_out['audio_events'])}")
    u = usage
    print(f"  tokens: in={u.get('promptTokenCount',0)} out={u.get('candidatesTokenCount',0)} thoughts={u.get('thoughtsTokenCount',0)}")


if __name__ == "__main__":
    main()
