"""
1초 단위 프레임 분석 비교
A: 현재 파이프라인 (1장씩 개별 호출)
B: 묶음 방식 (N장 → 1회 호출)

실제 transcriber 분석 프롬프트 그대로 사용.

사용법:
  python test_1sec_compare.py --shortcode "DON6F5vk6Ek"
"""

import os
import sys
import json
import base64
import time
import argparse
import subprocess
import tempfile
from pathlib import Path

import requests
from dotenv import load_dotenv

sys.path.insert(0, str(Path(__file__).parent))
from test_qwen_vision import get_video_url, download_video, get_ffmpeg

ENV_PATH = Path(__file__).parent / ".env"
load_dotenv(ENV_PATH)

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
GEMINI_URL = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={GEMINI_API_KEY}"


# ============================================
# 1초 간격 프레임 추출
# ============================================
def extract_1sec_frames(video_path, output_dir):
    ffmpeg = get_ffmpeg()
    os.makedirs(output_dir, exist_ok=True)

    cmd = [
        ffmpeg, "-i", video_path,
        "-vf", "fps=1",
        "-q:v", "2",
        os.path.join(output_dir, "frame_%04d.jpg"),
        "-y"
    ]
    subprocess.run(cmd, capture_output=True, text=True)

    frames = sorted(Path(output_dir).glob("frame_*.jpg"))
    result = []
    for i, f in enumerate(frames):
        result.append({"index": i + 1, "time": float(i), "path": str(f)})

    print(f"[프레임] {len(result)}장 추출 (1초 간격)")
    return result


def load_b64(path):
    with open(path, "rb") as f:
        return base64.b64encode(f.read()).decode()


def extract_json(text):
    if "```json" in text:
        return text.split("```json")[1].split("```")[0].strip()
    elif "```" in text:
        return text.split("```")[1].split("```")[0].strip()
    return text.strip()


# ============================================
# 방식 A: 1장씩 개별 호출 (현재 transcriber 방식)
# ============================================
SINGLE_PROMPT = """이 이미지는 인스타 릴스 영상의 {idx}/{total} 프레임이야 ({time}초 시점).
다음을 분석해줘:
1. 화면에 보이는 모든 텍스트 (자막, 타이틀 등)
2. 장면 설명 (인물, 배경, 구도)
3. 편집 스타일 (자막 스타일, 색감, 필터)

간결하게 JSON으로 답변해줘:
{{"texts": ["텍스트1", "텍스트2"], "scene": "장면 설명", "style": "편집 스타일"}}"""


def run_single(frames):
    """A: 1장씩 개별 호출"""
    total = len(frames)
    print(f"\n{'='*60}")
    print(f"[방식A] 1장씩 개별 호출 — {total}장")
    print(f"{'='*60}")

    results = []
    total_input = 0
    total_output = 0
    total_thinking = 0
    start = time.time()

    for frame in frames:
        prompt = SINGLE_PROMPT.format(
            idx=frame["index"], total=total, time=int(frame["time"])
        )
        img_b64 = load_b64(frame["path"])

        try:
            resp = requests.post(
                GEMINI_URL,
                json={"contents": [{"parts": [
                    {"text": prompt},
                    {"inline_data": {"mime_type": "image/jpeg", "data": img_b64}}
                ]}]},
                timeout=180
            )

            if resp.status_code == 200:
                data = resp.json()
                content = data["candidates"][0]["content"]["parts"][0]["text"]
                usage = data.get("usageMetadata", {})
                total_input += usage.get("promptTokenCount", 0)
                total_output += usage.get("candidatesTokenCount", 0)
                total_thinking += usage.get("thoughtsTokenCount", 0)

                results.append({
                    "frame": frame["index"],
                    "time": f'{int(frame["time"])}s',
                    "raw": content
                })
                print(f"  [{frame['index']:2d}/{total}] {int(frame['time']):2d}s 완료")
            elif resp.status_code == 429:
                print(f"  [{frame['index']:2d}/{total}] rate limit — 10초 대기 후 재시도")
                time.sleep(10)
                # 재시도
                resp = requests.post(
                    GEMINI_URL,
                    json={"contents": [{"parts": [
                        {"text": prompt},
                        {"inline_data": {"mime_type": "image/jpeg", "data": img_b64}}
                    ]}]},
                    timeout=180
                )
                if resp.status_code == 200:
                    data = resp.json()
                    content = data["candidates"][0]["content"]["parts"][0]["text"]
                    usage = data.get("usageMetadata", {})
                    total_input += usage.get("promptTokenCount", 0)
                    total_output += usage.get("candidatesTokenCount", 0)
                    total_thinking += usage.get("thoughtsTokenCount", 0)
                    results.append({
                        "frame": frame["index"],
                        "time": f'{int(frame["time"])}s',
                        "raw": content
                    })
                    print(f"  [{frame['index']:2d}/{total}] {int(frame['time']):2d}s 재시도 완료")
                else:
                    print(f"  [{frame['index']:2d}/{total}] 재시도 실패: {resp.status_code}")
            else:
                print(f"  [{frame['index']:2d}/{total}] 실패: {resp.status_code}")
        except Exception as e:
            print(f"  [{frame['index']:2d}/{total}] 에러: {e}")

    elapsed = time.time() - start

    # Gemini 2.5 Flash 비용: input $0.15/1M, output $0.60/1M, thinking $0.60/1M
    input_cost = total_input * 0.15 / 1_000_000
    output_cost = total_output * 0.60 / 1_000_000
    thinking_cost = total_thinking * 0.60 / 1_000_000
    total_usd = input_cost + output_cost + thinking_cost
    total_krw = total_usd * 1380

    stats = {
        "method": "A: 1장씩 개별",
        "frames": total,
        "api_calls": total,
        "elapsed": elapsed,
        "input_tokens": total_input,
        "output_tokens": total_output,
        "thinking_tokens": total_thinking,
        "cost_usd": total_usd,
        "cost_krw": total_krw,
        "results": results,
    }

    print(f"\n  시간: {elapsed:.1f}s | 토큰: in={total_input:,} out={total_output:,} think={total_thinking:,}")
    print(f"  비용: ${total_usd:.4f} ({total_krw:.1f}원)")
    return stats


# ============================================
# 방식 B: N장 묶어서 1회 호출
# ============================================
BATCH_PROMPT = """아래 이미지들은 인스타 릴스 영상에서 1초 간격으로 추출한 프레임 {total}장이야.
순서대로 0초, 1초, 2초, ... {last}초 시점이야.

모든 프레임 각각에 대해 분석해줘:
1. 화면에 보이는 모든 텍스트 (자막, 타이틀 등)
2. 장면 설명 (인물, 배경, 구도)
3. 편집 스타일 (자막 스타일, 색감, 필터)

반드시 아래 JSON 배열 형식으로 답변해줘:
[
  {{"frame": 1, "time": "0s", "texts": ["텍스트"], "scene": "장면 설명", "style": "편집 스타일"}},
  {{"frame": 2, "time": "1s", "texts": ["텍스트"], "scene": "장면 설명", "style": "편집 스타일"}},
  ...
]"""


def run_batch(frames):
    """B: 전체 프레임 묶어서 1회 호출"""
    total = len(frames)
    print(f"\n{'='*60}")
    print(f"[방식B] {total}장 묶어서 1회 호출")
    print(f"{'='*60}")

    prompt = BATCH_PROMPT.format(total=total, last=int(frames[-1]["time"]))

    parts = [{"text": prompt}]
    for frame in frames:
        img_b64 = load_b64(frame["path"])
        parts.append({"inline_data": {"mime_type": "image/jpeg", "data": img_b64}})

    start = time.time()

    resp = requests.post(
        GEMINI_URL,
        json={
            "contents": [{"parts": parts}],
            "generationConfig": {"maxOutputTokens": 16384}
        },
        timeout=600
    )

    elapsed = time.time() - start

    if resp.status_code != 200:
        print(f"  실패: {resp.status_code}")
        print(resp.text[:500])
        return None

    data = resp.json()
    content = data["candidates"][0]["content"]["parts"][0]["text"]
    usage = data.get("usageMetadata", {})
    total_input = usage.get("promptTokenCount", 0)
    total_output = usage.get("candidatesTokenCount", 0)
    total_thinking = usage.get("thoughtsTokenCount", 0)

    input_cost = total_input * 0.15 / 1_000_000
    output_cost = total_output * 0.60 / 1_000_000
    thinking_cost = total_thinking * 0.60 / 1_000_000
    total_usd = input_cost + output_cost + thinking_cost
    total_krw = total_usd * 1380

    # 결과 파싱
    try:
        json_str = extract_json(content)
        parsed = json.loads(json_str)
        frame_count = len(parsed)
    except:
        frame_count = "파싱실패"
        parsed = content

    stats = {
        "method": "B: N장 묶음",
        "frames": total,
        "api_calls": 1,
        "elapsed": elapsed,
        "input_tokens": total_input,
        "output_tokens": total_output,
        "thinking_tokens": total_thinking,
        "cost_usd": total_usd,
        "cost_krw": total_krw,
        "results": parsed,
        "analyzed_frames": frame_count,
    }

    print(f"  완료 — 분석된 프레임: {frame_count}장")
    print(f"  시간: {elapsed:.1f}s | 토큰: in={total_input:,} out={total_output:,} think={total_thinking:,}")
    print(f"  비용: ${total_usd:.4f} ({total_krw:.1f}원)")
    return stats


# ============================================
# 비교 출력
# ============================================
def print_comparison(a, b):
    sep = "=" * 65
    dash = "-" * 65
    print(f"\n{sep}")
    print(f" 1초 단위 프레임 분석 비교 (Gemini 2.5 Flash)")
    print(sep)

    rows = [
        ("항목", "A: 1장씩 개별", "B: 전체 묶음"),
        None,  # dash
        ("프레임 수", str(a["frames"]), str(b["frames"])),
        ("API 호출", f'{a["api_calls"]}회', f'{b["api_calls"]}회'),
        ("소요 시간", f'{a["elapsed"]:.1f}s', f'{b["elapsed"]:.1f}s'),
        ("Input 토큰", f'{a["input_tokens"]:,}', f'{b["input_tokens"]:,}'),
        ("Output 토큰", f'{a["output_tokens"]:,}', f'{b["output_tokens"]:,}'),
        ("Thinking 토큰", f'{a["thinking_tokens"]:,}', f'{b["thinking_tokens"]:,}'),
        ("비용 (USD)", f'${a["cost_usd"]:.4f}', f'${b["cost_usd"]:.4f}'),
        ("비용 (KRW)", f'{a["cost_krw"]:.1f}원', f'{b["cost_krw"]:.1f}원'),
    ]
    if "analyzed_frames" in b:
        rows.append(("분석된 프레임", str(len(a["results"])), str(b["analyzed_frames"])))

    for row in rows:
        if row is None:
            print(dash)
        else:
            label, va, vb = row
            print(f"  {label:<18} {va:>20} {vb:>20}")

    print(sep)

    speed_pct = (1 - b["elapsed"] / a["elapsed"]) * 100 if a["elapsed"] > 0 else 0
    cost_pct = (1 - b["cost_krw"] / a["cost_krw"]) * 100 if a["cost_krw"] > 0 else 0
    print(f"\n  속도: B가 {speed_pct:.0f}% 빠름 ({a['elapsed']:.0f}s -> {b['elapsed']:.0f}s)")
    print(f"  비용: B가 {cost_pct:.0f}% 저렴 ({a['cost_krw']:.1f}원 -> {b['cost_krw']:.1f}원)")

    # JSON으로 저장
    output = {
        "shortcode": "DON6F5vk6Ek",
        "total_frames": a["frames"],
        "method_a": {k: v for k, v in a.items() if k != "results"},
        "method_b": {k: v for k, v in b.items() if k != "results"},
        "speed_improvement": f"{speed_pct:.0f}%",
        "cost_improvement": f"{cost_pct:.0f}%",
    }
    with open("compare_1sec_result.json", "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)
    print(f"\n  결과 저장: compare_1sec_result.json")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="1초 단위 프레임 분석 비교")
    parser.add_argument("--shortcode", help="릴스 shortcode")
    parser.add_argument("--video", help="로컬 비디오 파일")
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

    # 1초 간격 프레임 추출
    frames_dir = os.path.join(os.path.dirname(video_path), "frames_1sec")
    frames = extract_1sec_frames(video_path, frames_dir)

    print(f"\n총 {len(frames)}장 프레임으로 A/B 비교 시작\n")

    # A: 개별 호출
    result_a = run_single(frames)

    # B: 묶음 호출
    result_b = run_batch(frames)

    if result_a and result_b:
        print_comparison(result_a, result_b)

    if tmpdir_obj:
        tmpdir_obj.cleanup()
