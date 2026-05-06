"""
프레임 분석 배치 비교 테스트
1장씩 개별 호출 vs N장 묶어서 1회 호출 — 시간/비용/품질 비교

사용법:
  python test_batch_frames.py --shortcode "DON6F5vk6Ek"
  python test_batch_frames.py --video "path/to/video.mp4"
"""

import os
import sys
import json
import base64
import time
import argparse
import tempfile
from pathlib import Path

import requests
from dotenv import load_dotenv

sys.path.insert(0, str(Path(__file__).parent))
from test_qwen_vision import detect_scene_cuts, get_video_url, download_video, get_ffmpeg

ENV_PATH = Path(__file__).parent / ".env"
load_dotenv(ENV_PATH)

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
GEMINI_URL = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={GEMINI_API_KEY}"

SINGLE_PROMPT = """이 이미지는 인스타 릴스 영상의 컷 전환 프레임이야 (전환 시점: {time}).
다음을 분석해줘:
1. 화면에 보이는 모든 텍스트 (자막, 타이틀 등)
2. 장면 설명 (인물, 배경, 구도)
3. 편집 스타일 (자막 스타일, 색감, 필터)

간결하게 JSON으로 답변해줘:
{{"texts": ["텍스트1"], "scene": "장면 설명", "style": "편집 스타일"}}"""

BATCH_PROMPT = """아래 이미지들은 인스타 릴스 영상의 컷 전환 프레임들이야.
각 프레임의 전환 시점: {times}

모든 프레임을 분석해서 각각에 대해:
1. 화면에 보이는 모든 텍스트 (자막, 타이틀 등)
2. 장면 설명 (인물, 배경, 구도)
3. 편집 스타일 (자막 스타일, 색감, 필터)

반드시 아래 JSON 배열 형식으로 답변해줘:
[
  {{"frame": 1, "time": "0.5s", "texts": ["텍스트"], "scene": "장면 설명", "style": "편집 스타일"}},
  ...
]"""


def load_frame_b64(path):
    with open(path, "rb") as f:
        return base64.b64encode(f.read()).decode()


# ============================================
# 방식 A: 1장씩 개별 호출
# ============================================
def analyze_single(frames, max_frames=8):
    """프레임을 1장씩 개별 Gemini 호출"""
    selected = frames[:max_frames]
    print(f"\n[방식A] 1장씩 개별 호출 — {len(selected)}장")

    results = []
    total_input = 0
    total_output = 0
    start = time.time()

    for i, frame in enumerate(selected):
        img_b64 = load_frame_b64(frame["path"])
        prompt = SINGLE_PROMPT.format(time=frame["time"])

        resp = requests.post(
            GEMINI_URL,
            json={
                "contents": [{"parts": [
                    {"text": prompt},
                    {"inline_data": {"mime_type": "image/jpeg", "data": img_b64}}
                ]}]
            },
            timeout=180
        )

        if resp.status_code == 200:
            data = resp.json()
            content = data["candidates"][0]["content"]["parts"][0]["text"]
            usage = data.get("usageMetadata", {})
            total_input += usage.get("promptTokenCount", 0)
            total_output += usage.get("candidatesTokenCount", 0)
            results.append({"frame": i + 1, "time": frame["time"], "response": content})
            print(f"  프레임 {i+1}/{len(selected)} 완료 ({frame['time']:.1f}s)")
        else:
            print(f"  프레임 {i+1} 실패: {resp.status_code}")

    elapsed = time.time() - start

    # Gemini 2.5 Flash: $0.15/1M input, $0.60/1M output (+ thinking)
    input_cost = total_input * 0.15 / 1_000_000
    output_cost = total_output * 0.60 / 1_000_000
    total_usd = input_cost + output_cost
    total_krw = total_usd * 1380

    return {
        "method": "A: 1장씩 개별",
        "frames": len(selected),
        "api_calls": len(selected),
        "elapsed": elapsed,
        "input_tokens": total_input,
        "output_tokens": total_output,
        "cost_usd": total_usd,
        "cost_krw": total_krw,
        "results": results,
    }


# ============================================
# 방식 B: N장 묶어서 1회 호출
# ============================================
def analyze_batch(frames, max_frames=8):
    """프레임을 모아서 1회 Gemini 호출"""
    selected = frames[:max_frames]
    print(f"\n[방식B] {len(selected)}장 묶어서 1회 호출")

    times_str = ", ".join([f"{f['time']:.1f}s" for f in selected])
    prompt = BATCH_PROMPT.format(times=times_str)

    parts = [{"text": prompt}]
    for frame in selected:
        img_b64 = load_frame_b64(frame["path"])
        parts.append({"inline_data": {"mime_type": "image/jpeg", "data": img_b64}})

    start = time.time()

    resp = requests.post(
        GEMINI_URL,
        json={"contents": [{"parts": parts}]},
        timeout=300
    )

    elapsed = time.time() - start

    if resp.status_code != 200:
        print(f"  실패: {resp.status_code} {resp.text[:300]}")
        return None

    data = resp.json()
    content = data["candidates"][0]["content"]["parts"][0]["text"]
    usage = data.get("usageMetadata", {})
    total_input = usage.get("promptTokenCount", 0)
    total_output = usage.get("candidatesTokenCount", 0)

    input_cost = total_input * 0.15 / 1_000_000
    output_cost = total_output * 0.60 / 1_000_000
    total_usd = input_cost + output_cost
    total_krw = total_usd * 1380

    print(f"  완료 — {len(selected)}장 한번에 처리")

    return {
        "method": "B: N장 묶음",
        "frames": len(selected),
        "api_calls": 1,
        "elapsed": elapsed,
        "input_tokens": total_input,
        "output_tokens": total_output,
        "cost_usd": total_usd,
        "cost_krw": total_krw,
        "results": content,
    }


def print_comparison(a, b):
    print(f"\n{'='*60}")
    print(f"{'비교 항목':<20} {'A: 1장씩 개별':>18} {'B: N장 묶음':>18}")
    print(f"{'='*60}")
    print(f"{'프레임 수':<20} {a['frames']:>18} {b['frames']:>18}")
    print(f"{'API 호출':<20} {str(a['api_calls'])+'회':>18} {str(b['api_calls'])+'회':>18}")
    print(f"{'소요 시간':<20} {a['elapsed']:>17.1f}s {b['elapsed']:>17.1f}s")
    print(f"{'Input 토큰':<20} {a['input_tokens']:>17,} {b['input_tokens']:>17,}")
    print(f"{'Output 토큰':<20} {a['output_tokens']:>17,} {b['output_tokens']:>17,}")
    print(f"{'비용 (USD)':<20} {'$'+f'{a["cost_usd"]:.4f}':>18} {'$'+f'{b["cost_usd"]:.4f}':>18}")
    print(f"{'비용 (KRW)':<20} {f'{a["cost_krw"]:.1f}원':>18} {f'{b["cost_krw"]:.1f}원':>18}")
    print(f"{'='*60}")

    speed_diff = (1 - b["elapsed"] / a["elapsed"]) * 100
    cost_diff = (1 - b["cost_krw"] / a["cost_krw"]) * 100 if a["cost_krw"] > 0 else 0
    print(f"\n묶음 방식이 {speed_diff:.0f}% 빠르고, {cost_diff:.0f}% 저렴")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="프레임 배치 분석 비교")
    parser.add_argument("--shortcode", help="릴스 shortcode")
    parser.add_argument("--video", help="��컬 비디오 파일")
    parser.add_argument("--max-frames", type=int, default=8, help="분석할 최대 프레임 수 (기본 8)")
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

    # 컷 전환 감지
    cut_result = detect_scene_cuts(video_path, threshold=0.3)
    frames = cut_result["frames"]

    if not frames:
        print("[ERROR] 컷 전환 프레임이 없습니다.")
        sys.exit(1)

    # 프레임 균등 샘플링 (너무 많으면)
    max_f = args.max_frames
    if len(frames) > max_f:
        step = len(frames) / max_f
        frames = [frames[int(i * step)] for i in range(max_f)]
        print(f"[샘플링] {cut_result['total_cuts']}장 → {len(frames)}장 균등 추��")

    # A: 개별 호출
    result_a = analyze_single(frames, max_frames=max_f)

    # B: 묶음 호출
    result_b = analyze_batch(frames, max_frames=max_f)

    if result_a and result_b:
        print_comparison(result_a, result_b)

        # 품질 비교용 출력
        print(f"\n{'='*60}")
        print("[방식A 샘플 — 첫 번째 프레임]")
        if result_a["results"]:
            print(result_a["results"][0]["response"][:300])

        print(f"\n[방식B 샘플 — 전체 응답 앞부분]")
        if isinstance(result_b["results"], str):
            print(result_b["results"][:500])

    if tmpdir_obj:
        tmpdir_obj.cleanup()
