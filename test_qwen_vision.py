"""
Qwen 3.6 Plus Vision 테스트
영상 1개를 비디오 직접 입력으로 분석하여 비용/속도/품질 비교.

사용법:
  python test_qwen_vision.py --shortcode "ABC123"
  python test_qwen_vision.py --video "path/to/video.mp4"

필요 환경변수:
  OPENROUTER_API_KEY  (openrouter.ai에서 발급)
"""

import os
import sys
import json
import base64
import time
import argparse
import re
import subprocess
import tempfile
from pathlib import Path

import requests
from dotenv import load_dotenv

sys.path.insert(0, str(Path(__file__).parent))
try:
    import gramsnap_util
except ImportError:
    gramsnap_util = None

ENV_PATH = Path(__file__).parent / ".env"
load_dotenv(ENV_PATH)

OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY")
HIKER_API_KEY = os.getenv("HIKER_API_KEY")

MODEL = "qwen/qwen3.6-plus"
OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"

ANALYSIS_PROMPT = """이 영상은 인스타그램 릴스야. 영상을 보고 다음을 모두 분석해줘.

## 1. 대본 추출
영상에서 들리는 음성을 그대로 텍스트로 옮겨줘. (자막이 아닌 실제 음성)

## 2. 대본 구간 분석
추출한 대본을 문장 단위로 쪼개서 각각 태깅:
- section: "hook" / "intro" / "body" / "cta"
- role: 그 문장의 역할 (예: "도발적 질문", "공감 유도", "문제 제기" 등)
- emotion: 감정 톤 (예: "도발", "진지", "공감" 등)

## 3. 영상 분석
- 화면에 보이는 모든 텍스트 (자막, 타이틀, 오버레이)
- 편집 스타일 (컷 수, 자막 스타일, 색감, 필터)
- 장면 구성 (인물, 배경, 구도 변화)

## 4. 종합 분석
- 콘텐츠 주제/카테고리
- 후킹 방식 (첫 장면에서 어떻게 시선을 잡는지)
- 화법 스타일 (말투, 톤)
- 이 릴스가 잘 될 수 있는 이유
- 개선할 점

반드시 아래 JSON 형식으로만 답변해줘:
```json
{
  "transcript": "전체 대본 텍스트",
  "sentences": [
    {"order": 1, "text": "문장", "section": "hook", "role": "역할", "emotion": "감정"}
  ],
  "visual": {
    "on_screen_texts": ["텍스트1", "텍스트2"],
    "edit_style": "편집 스타일 설명",
    "scenes": "장면 구성 설명"
  },
  "analysis": {
    "category": "카테고리",
    "hook_type": "후킹 방식",
    "tone": "화법 스타일",
    "strength": "강점",
    "weakness": "개선점"
  }
}
```"""


def get_ffmpeg():
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except ImportError:
        return "ffmpeg"


def detect_scene_cuts(video_path, threshold=0.3):
    """ffmpeg scene detection으로 컷 전환 지점 감지 + 해당 프레임 추출"""
    ffmpeg = get_ffmpeg()

    # 1) scene detection — 전환 지점 타임스탬프 추출
    print(f"[컷분석] scene detection 중 (threshold={threshold})...")
    cmd = [
        ffmpeg, "-i", video_path,
        "-vf", f"select='gt(scene,{threshold})',showinfo",
        "-vsync", "vfr",
        "-f", "null", "-"
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    stderr = result.stderr

    # showinfo 출력에서 pts_time 파싱
    timestamps = []
    for line in stderr.split("\n"):
        if "showinfo" in line and "pts_time:" in line:
            match = re.search(r"pts_time:\s*([\d.]+)", line)
            if match:
                timestamps.append(float(match.group(1)))

    print(f"[컷분석] {len(timestamps)}개 컷 전환 감지: {[f'{t:.1f}s' for t in timestamps]}")

    if not timestamps:
        return {"cuts": [], "frames": []}

    # 2) 전환 지점 프레임 추출
    output_dir = os.path.join(os.path.dirname(video_path), "cuts")
    os.makedirs(output_dir, exist_ok=True)

    frames = []
    for i, ts in enumerate(timestamps):
        out_path = os.path.join(output_dir, f"cut_{i:03d}_{ts:.1f}s.jpg")
        cmd = [
            ffmpeg, "-ss", str(ts),
            "-i", video_path,
            "-vframes", "1", "-q:v", "2",
            out_path, "-y"
        ]
        subprocess.run(cmd, capture_output=True, text=True)
        if os.path.exists(out_path):
            frames.append({"time": ts, "path": out_path})

    print(f"[컷분석] {len(frames)}장 전환 프레임 추출 완료")

    return {
        "cuts": [{"index": i+1, "time": t, "time_str": f"{t:.1f}s"} for i, t in enumerate(timestamps)],
        "frames": frames,
        "total_cuts": len(timestamps),
    }


def compress_video(video_path, target_mb=9):
    """비디오를 target_mb 이하로 압축"""
    ffmpeg = get_ffmpeg()
    file_size = os.path.getsize(video_path) / (1024 * 1024)
    if file_size <= target_mb:
        return video_path

    print(f"[압축] {file_size:.1f}MB → {target_mb}MB 이하로 압축 중...")
    compressed = video_path.replace(".mp4", "_compressed.mp4")
    cmd = [
        ffmpeg, "-i", video_path,
        "-vf", "scale=-2:480",
        "-c:v", "libx264", "-crf", "32", "-preset", "fast",
        "-c:a", "aac", "-b:a", "48k",
        compressed, "-y"
    ]
    subprocess.run(cmd, capture_output=True, text=True)
    new_size = os.path.getsize(compressed) / (1024 * 1024)
    print(f"[압축] 완료: {new_size:.1f}MB")
    return compressed


def analyze_video_with_qwen(video_path):
    """Qwen 3.6 Plus로 비디오 직접 분석 (1회 호출)"""
    if not OPENROUTER_API_KEY:
        print("[ERROR] OPENROUTER_API_KEY가 .env에 없습니다.")
        print("  openrouter.ai에서 API 키 발급 후 .env에 추가해주세요:")
        print("  OPENROUTER_API_KEY=sk-or-...")
        return None

    # 10MB 초과 시 압축
    video_path = compress_video(video_path, target_mb=9)

    # 비디오 → base64
    file_size = os.path.getsize(video_path) / (1024 * 1024)
    print(f"[Qwen] 비디오 로딩 ({file_size:.1f}MB)...")

    with open(video_path, "rb") as f:
        video_b64 = base64.b64encode(f.read()).decode()

    print(f"[Qwen] {MODEL} 호출 중...")
    start_time = time.time()

    resp = requests.post(
        OPENROUTER_URL,
        headers={
            "Authorization": f"Bearer {OPENROUTER_API_KEY}",
            "Content-Type": "application/json",
        },
        json={
            "model": MODEL,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": ANALYSIS_PROMPT},
                        {
                            "type": "video_url",
                            "video_url": {
                                "url": f"data:video/mp4;base64,{video_b64}"
                            },
                        },
                    ],
                }
            ],
            "max_tokens": 4096,
        },
        timeout=300,
    )

    elapsed = time.time() - start_time

    if resp.status_code != 200:
        print(f"[ERROR] API 응답: {resp.status_code}")
        print(resp.text[:500])
        return None

    result = resp.json()
    content = result["choices"][0]["message"]["content"]

    # 사용량 출력
    usage = result.get("usage", {})
    input_tokens = usage.get("prompt_tokens", 0)
    output_tokens = usage.get("completion_tokens", 0)

    # 비용 계산 (Qwen 3.6 Plus: $0.325/1M input, $1.95/1M output)
    input_cost = input_tokens * 0.325 / 1_000_000
    output_cost = output_tokens * 1.95 / 1_000_000
    total_cost_usd = input_cost + output_cost
    total_cost_krw = total_cost_usd * 1380  # 대략적 환율

    print(f"\n{'='*50}")
    print(f"[결과] 응답 시간: {elapsed:.1f}초")
    print(f"[결과] 토큰: input={input_tokens:,} / output={output_tokens:,}")
    print(f"[결과] 비용: ${total_cost_usd:.4f} (약 {total_cost_krw:.1f}원)")
    print(f"{'='*50}")

    # JSON 추출
    if "```json" in content:
        json_str = content.split("```json")[1].split("```")[0].strip()
    elif "```" in content:
        json_str = content.split("```")[1].split("```")[0].strip()
    else:
        json_str = content.strip()

    try:
        parsed = json.loads(json_str)
        print("\n[대본]")
        print(parsed.get("transcript", "(없음)")[:300])
        print(f"\n[문장 분석] {len(parsed.get('sentences', []))}개 문장")
        for s in parsed.get("sentences", []):
            sec_map = {"hook": "후킹", "intro": "인트로", "body": "본문", "cta": "CTA"}
            sec = sec_map.get(s.get("section", ""), s.get("section", ""))
            print(f"  [{sec}] {s.get('text', '')}  ← {s.get('role', '')} / {s.get('emotion', '')}")
        print(f"\n[영상 분석]")
        visual = parsed.get("visual", {})
        print(f"  텍스트: {visual.get('on_screen_texts', [])}")
        print(f"  편집: {visual.get('edit_style', '')}")
        print(f"\n[종합]")
        analysis = parsed.get("analysis", {})
        for k, v in analysis.items():
            print(f"  {k}: {v}")
        return parsed
    except json.JSONDecodeError:
        print("\n[원본 응답]")
        print(content[:1000])
        return content


def download_video(video_url, output_path):
    """영상 다운로드"""
    print(f"[다운로드] {video_url[:80]}...")
    resp = requests.get(video_url, stream=True, timeout=60)
    resp.raise_for_status()
    with open(output_path, "wb") as f:
        for chunk in resp.iter_content(chunk_size=8192):
            f.write(chunk)
    size_mb = os.path.getsize(output_path) / (1024 * 1024)
    print(f"[다운로드] 완료 ({size_mb:.1f}MB)")


def get_video_url(shortcode):
    """shortcode → video URL"""
    if HIKER_API_KEY:
        resp = requests.get(
            "https://api.hikerapi.com/v1/media/by/code",
            params={"code": shortcode},
            headers={"accept": "application/json", "x-access-key": HIKER_API_KEY},
            timeout=30,
        )
        if resp.status_code == 200:
            return resp.json().get("video_url")
    return None


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Qwen 3.6 Plus Vision 테스트")
    parser.add_argument("--shortcode", help="릴스 shortcode")
    parser.add_argument("--video", help="로컬 비디오 파일 경로")
    args = parser.parse_args()

    video_path = None
    tmpdir_obj = None

    if args.video:
        video_path = args.video
    elif args.shortcode:
        video_url = get_video_url(args.shortcode)
        if not video_url:
            print("[ERROR] 비디오 URL을 가져올 수 없습니다.")
            sys.exit(1)
        tmpdir_obj = tempfile.TemporaryDirectory()
        video_path = os.path.join(tmpdir_obj.name, "reel.mp4")
        download_video(video_url, video_path)
    else:
        parser.print_help()
        sys.exit(0)

    # 1) 컷 전환 분석
    cut_result = detect_scene_cuts(video_path, threshold=0.3)

    # 2) Qwen 영상 분석
    qwen_result = analyze_video_with_qwen(video_path)

    # 3) 컷 분석 결과 출력
    if cut_result["cuts"]:
        print(f"\n{'='*50}")
        print(f"[컷 전환] 총 {cut_result['total_cuts']}회")
        for c in cut_result["cuts"]:
            print(f"  컷 #{c['index']}: {c['time_str']}")

        # 평균 컷 간격 계산
        times = [c["time"] for c in cut_result["cuts"]]
        if len(times) >= 2:
            intervals = [times[i+1] - times[i] for i in range(len(times)-1)]
            avg = sum(intervals) / len(intervals)
            print(f"\n  평균 컷 간격: {avg:.1f}초")
            print(f"  최단 간격: {min(intervals):.1f}초")
            print(f"  최장 간격: {max(intervals):.1f}초")

    if tmpdir_obj:
        tmpdir_obj.cleanup()
