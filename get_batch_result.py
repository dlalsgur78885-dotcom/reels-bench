"""B방식 프레임 분석 결과만 빠르게 가져와서 JSON 저장"""
import os, sys, json, base64, time, tempfile, subprocess
from pathlib import Path
import requests
from dotenv import load_dotenv

sys.path.insert(0, str(Path(__file__).parent))
from test_qwen_vision import get_video_url, download_video, get_ffmpeg

ENV_PATH = Path(__file__).parent / ".env"
load_dotenv(ENV_PATH)
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
GEMINI_URL = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={GEMINI_API_KEY}"

BATCH_PROMPT = """아래 이미지들은 인스타 릴스 영상에서 1초 간격으로 추출한 프레임 {total}장이야.
순서대로 0초, 1초, 2초, ... {last}초 시점이야.

모든 프레임 각각에 대해 분석해줘:
1. 화면에 보이는 모든 텍스트 (자막, 타이틀 등)
2. 장면 설명 (인물, 배경, 구도)
3. 편집 스타일 (자막 스타일, 색감, 필터)

반드시 아래 JSON 배열 형식으로 답변해줘:
[
  {{"frame": 1, "time": "0s", "texts": ["텍스트"], "scene": "장면 설명", "style": "편집 스타일"}},
  ...
]"""

shortcode = "DON6F5vk6Ek"
video_url = get_video_url(shortcode)
tmpdir = tempfile.mkdtemp()
video_path = os.path.join(tmpdir, "reel.mp4")
download_video(video_url, video_path)

# 프레임 추출
ffmpeg = get_ffmpeg()
frames_dir = os.path.join(tmpdir, "frames")
os.makedirs(frames_dir, exist_ok=True)
subprocess.run([ffmpeg, "-i", video_path, "-vf", "fps=1", "-q:v", "2",
                os.path.join(frames_dir, "frame_%04d.jpg"), "-y"],
               capture_output=True, text=True)

frame_files = sorted(Path(frames_dir).glob("frame_*.jpg"))
frames = [{"index": i+1, "time": float(i), "path": str(f)} for i, f in enumerate(frame_files)]
print(f"[프레임] {len(frames)}장")

# B: 묶음 호출
prompt = BATCH_PROMPT.format(total=len(frames), last=int(frames[-1]["time"]))
parts = [{"text": prompt}]
for f in frames:
    with open(f["path"], "rb") as fp:
        b64 = base64.b64encode(fp.read()).decode()
    parts.append({"inline_data": {"mime_type": "image/jpeg", "data": b64}})

print("[Gemini] 50장 묶음 호출 중...")
start = time.time()
resp = requests.post(GEMINI_URL, json={
    "contents": [{"parts": parts}],
    "generationConfig": {"maxOutputTokens": 16384}
}, timeout=600)
elapsed = time.time() - start

data = resp.json()
content = data["candidates"][0]["content"]["parts"][0]["text"]
usage = data.get("usageMetadata", {})
print(f"[완료] {elapsed:.1f}s | in={usage.get('promptTokenCount',0):,} out={usage.get('candidatesTokenCount',0):,}")

# JSON 파싱
if "```json" in content:
    json_str = content.split("```json")[1].split("```")[0].strip()
elif "```" in content:
    json_str = content.split("```")[1].split("```")[0].strip()
else:
    json_str = content.strip()

parsed = json.loads(json_str)
print(f"[파싱] {len(parsed)}장 분석 결과")

# 저장
with open("batch_frames_result.json", "w", encoding="utf-8") as f:
    json.dump(parsed, f, ensure_ascii=False, indent=2)
print("[저장] batch_frames_result.json")
