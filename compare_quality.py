"""
Gemini 2.5 Flash 품질 비교: 1장씩 vs 3장씩
- A: 1초=1frame, 1장씩 개별 호출
- B: 1초=1frame, 3장씩 묶어서 호출
결과를 HTML 비교 페이지로 출력.

사용법:
  python compare_quality.py --shortcode "DON6F5vk6Ek"
  python compare_quality.py --video "path/to/video.mp4"
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
        with open(f, "rb") as fp:
            b64 = base64.b64encode(fp.read()).decode()
        result.append({"index": i + 1, "time": i, "path": str(f), "b64": b64})
    print(f"[프레임] {len(result)}장 추출 (1초 간격)")
    return result


def extract_json(text):
    if "```json" in text:
        return text.split("```json")[1].split("```")[0].strip()
    elif "```" in text:
        return text.split("```")[1].split("```")[0].strip()
    return text.strip()


def call_gemini(parts, timeout=300):
    """Gemini API 호출 + rate limit 재시도"""
    for attempt in range(3):
        resp = requests.post(
            GEMINI_URL,
            json={
                "contents": [{"parts": parts}],
                "generationConfig": {"maxOutputTokens": 8192}
            },
            timeout=timeout,
        )
        if resp.status_code == 200:
            data = resp.json()
            content = data["candidates"][0]["content"]["parts"][0]["text"]
            usage = data.get("usageMetadata", {})
            return {
                "content": content,
                "input_tokens": usage.get("promptTokenCount", 0),
                "output_tokens": usage.get("candidatesTokenCount", 0),
                "thinking_tokens": usage.get("thoughtsTokenCount", 0),
            }
        elif resp.status_code == 429:
            wait = 10 * (attempt + 1)
            print(f"    rate limit — {wait}초 대기 후 재시도")
            time.sleep(wait)
        else:
            print(f"    API 에러: {resp.status_code}")
            return None
    return None


SINGLE_PROMPT = """이 이미지는 인스타 릴스 영상의 {idx}/{total} 프레임이야 ({time}초 시점).
다음을 분석해줘:
1. 화면에 보이는 모든 텍스트 (자막, 타이틀 등)
2. 장면 설명 (인물, 배경, 구도)
3. 편집 스타일 (자막 스타일, 색감, 필터)

간결하게 JSON으로 답변해줘:
{{"texts": ["텍스트1", "텍스트2"], "scene": "장면 설명", "style": "편집 스타일"}}"""


BATCH3_PROMPT = """아래 이미지 3장은 인스타 릴스 영상에서 1초 간격으로 추출한 연속 프레임이야.
순서대로 {t0}초, {t1}초, {t2}초 시점이야. (전체 {total}프레임 중 {start}~{end}번째)

각 프레임마다 분석해줘:
1. 화면에 보이는 모든 텍스트 (자막, 타이틀 등)
2. 장면 설명 (인물, 배경, 구도)
3. 편집 스타일 (자막 스타일, 색감, 필터)

반드시 아래 JSON 배열 형식으로 답변해줘:
[
  {{"frame": {f0}, "time": "{t0}s", "texts": ["텍스트"], "scene": "장면 설명", "style": "편집 스타일"}},
  {{"frame": {f1}, "time": "{t1}s", "texts": ["텍스트"], "scene": "장면 설명", "style": "편집 스타일"}},
  {{"frame": {f2}, "time": "{t2}s", "texts": ["텍스트"], "scene": "장면 설명", "style": "편집 스타일"}}
]"""


BATCH3_PROMPT_TAIL = """아래 이미지 {n}장은 인스타 릴스 영상에서 1초 간격으로 추출한 연속 프레임이야.
순서대로 {times} 시점이야. (전체 {total}프레임 중 {start}~{end}번째)

각 프레임마다 분석해줘:
1. 화면에 보이는 모든 텍스트 (자막, 타이틀 등)
2. 장면 설명 (인물, 배경, 구도)
3. 편집 스타일 (자막 스타일, 색감, 필터)

반드시 아래 JSON 배열 형식으로 답변해줘:
[{entries}]"""


# ============================================
# 방식 A: 1장씩 개별 호출
# ============================================
def run_method_a(frames):
    total = len(frames)
    print(f"\n{'='*60}")
    print(f"[방식A] 1장씩 개별 호출 — {total}장")
    print(f"{'='*60}")

    results = []
    total_input = total_output = total_thinking = 0
    start = time.time()

    for frame in frames:
        prompt = SINGLE_PROMPT.format(idx=frame["index"], total=total, time=frame["time"])
        parts = [
            {"text": prompt},
            {"inline_data": {"mime_type": "image/jpeg", "data": frame["b64"]}}
        ]
        resp = call_gemini(parts, timeout=180)

        if resp:
            total_input += resp["input_tokens"]
            total_output += resp["output_tokens"]
            total_thinking += resp["thinking_tokens"]

            # parse
            try:
                parsed = json.loads(extract_json(resp["content"]))
            except:
                parsed = {"texts": [], "scene": resp["content"][:200], "style": ""}

            results.append({
                "frame": frame["index"],
                "time": f'{frame["time"]}s',
                "texts": parsed.get("texts", []),
                "scene": parsed.get("scene", ""),
                "style": parsed.get("style", ""),
            })
            print(f"  [{frame['index']:2d}/{total}] {frame['time']:2d}s ✓")
        else:
            results.append({
                "frame": frame["index"],
                "time": f'{frame["time"]}s',
                "texts": [], "scene": "(분석 실패)", "style": "",
            })
            print(f"  [{frame['index']:2d}/{total}] {frame['time']:2d}s ✗")

    elapsed = time.time() - start
    cost_usd = (total_input * 0.15 + total_output * 0.60 + total_thinking * 0.60) / 1_000_000
    cost_krw = cost_usd * 1380

    stats = {
        "method": "A: 1장씩 개별",
        "frames": total,
        "api_calls": total,
        "elapsed": elapsed,
        "input_tokens": total_input,
        "output_tokens": total_output,
        "thinking_tokens": total_thinking,
        "cost_usd": cost_usd,
        "cost_krw": cost_krw,
    }
    print(f"\n  시간: {elapsed:.1f}s | 토큰: in={total_input:,} out={total_output:,} think={total_thinking:,}")
    print(f"  비용: ${cost_usd:.4f} ({cost_krw:.1f}원)")
    return results, stats


# ============================================
# 방식 B: 3장씩 묶어서 호출
# ============================================
def run_method_b(frames):
    total = len(frames)
    print(f"\n{'='*60}")
    print(f"[방식B] 3장씩 묶어서 호출 — {total}장")
    print(f"{'='*60}")

    results = []
    total_input = total_output = total_thinking = 0
    start = time.time()
    call_count = 0

    for i in range(0, total, 3):
        chunk = frames[i:i+3]
        n = len(chunk)

        if n == 3:
            prompt = BATCH3_PROMPT.format(
                t0=chunk[0]["time"], t1=chunk[1]["time"], t2=chunk[2]["time"],
                total=total, start=chunk[0]["index"], end=chunk[-1]["index"],
                f0=chunk[0]["index"], f1=chunk[1]["index"], f2=chunk[2]["index"],
            )
        else:
            # 마지막 잔여 (1~2장)
            times = ", ".join([f'{c["time"]}초' for c in chunk])
            entries = ", ".join([
                f'{{"frame": {c["index"]}, "time": "{c["time"]}s", "texts": ["텍스트"], "scene": "장면 설명", "style": "편집 스타일"}}'
                for c in chunk
            ])
            prompt = BATCH3_PROMPT_TAIL.format(
                n=n, times=times, total=total,
                start=chunk[0]["index"], end=chunk[-1]["index"],
                entries=entries,
            )

        parts = [{"text": prompt}]
        for c in chunk:
            parts.append({"inline_data": {"mime_type": "image/jpeg", "data": c["b64"]}})

        resp = call_gemini(parts, timeout=300)
        call_count += 1

        # rate limit 방지 딜레이
        if i + 3 < total:
            time.sleep(2)

        if resp:
            total_input += resp["input_tokens"]
            total_output += resp["output_tokens"]
            total_thinking += resp["thinking_tokens"]

            try:
                parsed = json.loads(extract_json(resp["content"]))
                if not isinstance(parsed, list):
                    parsed = [parsed]
            except:
                parsed = []

            # 결과 매핑
            for j, c in enumerate(chunk):
                if j < len(parsed):
                    p = parsed[j]
                    results.append({
                        "frame": c["index"],
                        "time": f'{c["time"]}s',
                        "texts": p.get("texts", []),
                        "scene": p.get("scene", ""),
                        "style": p.get("style", ""),
                    })
                else:
                    results.append({
                        "frame": c["index"],
                        "time": f'{c["time"]}s',
                        "texts": [], "scene": "(응답에서 누락)", "style": "",
                    })

            frame_range = f"{chunk[0]['index']}~{chunk[-1]['index']}"
            print(f"  [{frame_range}] {chunk[0]['time']}~{chunk[-1]['time']}s ✓ ({len(parsed)}장 파싱)")
        else:
            for c in chunk:
                results.append({
                    "frame": c["index"],
                    "time": f'{c["time"]}s',
                    "texts": [], "scene": "(분석 실패)", "style": "",
                })
            print(f"  [{chunk[0]['index']}~{chunk[-1]['index']}] ✗")

    elapsed = time.time() - start
    cost_usd = (total_input * 0.15 + total_output * 0.60 + total_thinking * 0.60) / 1_000_000
    cost_krw = cost_usd * 1380

    stats = {
        "method": "B: 3장씩 묶음",
        "frames": total,
        "api_calls": call_count,
        "elapsed": elapsed,
        "input_tokens": total_input,
        "output_tokens": total_output,
        "thinking_tokens": total_thinking,
        "cost_usd": cost_usd,
        "cost_krw": cost_krw,
    }
    print(f"\n  시간: {elapsed:.1f}s | API {call_count}회 | 토큰: in={total_input:,} out={total_output:,} think={total_thinking:,}")
    print(f"  비용: ${cost_usd:.4f} ({cost_krw:.1f}원)")
    return results, stats


# ============================================
# HTML 비교 페이지 생성
# ============================================
def generate_html(shortcode, frames, results_a, results_b, stats_a, stats_b):
    # 프레임 b64 맵
    frame_b64 = {f["index"]: f["b64"] for f in frames}

    # 프레임별 비교 행 생성
    rows_html = ""
    for i in range(len(results_a)):
        a = results_a[i] if i < len(results_a) else {}
        b = results_b[i] if i < len(results_b) else {}
        idx = a.get("frame", i + 1)
        t = a.get("time", f"{i}s")
        img_b64 = frame_b64.get(idx, "")

        a_texts = ", ".join(a.get("texts", [])) or "<span class='empty'>없음</span>"
        b_texts = ", ".join(b.get("texts", [])) or "<span class='empty'>없음</span>"
        a_scene = a.get("scene", "") or "-"
        b_scene = b.get("scene", "") or "-"
        a_style = a.get("style", "") or "-"
        b_style = b.get("style", "") or "-"

        rows_html += f"""
    <div class="frame-row" id="frame-{idx}">
      <div class="frame-thumb">
        <img src="data:image/jpeg;base64,{img_b64}" alt="frame {idx}" loading="lazy">
        <div class="frame-label">#{idx} ({t})</div>
      </div>
      <div class="analysis-col a-col">
        <div class="field"><span class="field-label">텍스트</span>{a_texts}</div>
        <div class="field"><span class="field-label">장면</span>{a_scene}</div>
        <div class="field"><span class="field-label">스타일</span>{a_style}</div>
      </div>
      <div class="analysis-col b-col">
        <div class="field"><span class="field-label">텍스트</span>{b_texts}</div>
        <div class="field"><span class="field-label">장면</span>{b_scene}</div>
        <div class="field"><span class="field-label">스타일</span>{b_style}</div>
      </div>
    </div>"""

    speed_pct = (1 - stats_b["elapsed"] / stats_a["elapsed"]) * 100 if stats_a["elapsed"] > 0 else 0
    cost_pct = (1 - stats_b["cost_krw"] / stats_a["cost_krw"]) * 100 if stats_a["cost_krw"] > 0 else 0

    html = f"""<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>품질 비교 — 1장씩 vs 3장씩 | {shortcode}</title>
<style>
  * {{ margin: 0; padding: 0; box-sizing: border-box; }}
  body {{ font-family: 'Pretendard', -apple-system, sans-serif; background: #0a0a0a; color: #e0e0e0; padding: 20px; }}

  .header {{ text-align: center; margin-bottom: 28px; }}
  .header h1 {{ font-size: 22px; color: #fff; margin-bottom: 6px; }}
  .header .sub {{ color: #888; font-size: 13px; }}

  /* 통계 카드 */
  .stats {{ display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; max-width: 900px; margin: 0 auto 28px; }}
  .stat {{ background: #161616; border: 1px solid #2a2a2a; border-radius: 10px; padding: 16px; text-align: center; }}
  .stat .label {{ font-size: 11px; color: #888; text-transform: uppercase; letter-spacing: .5px; margin-bottom: 8px; }}
  .stat .row {{ display: flex; justify-content: center; align-items: baseline; gap: 8px; }}
  .stat .val {{ font-size: 16px; font-weight: 600; }}
  .stat .val.a {{ color: #f87171; }}
  .stat .val.b {{ color: #60a5fa; }}
  .stat .vs {{ color: #555; font-size: 12px; }}
  .stat .diff {{ font-size: 12px; color: #4ade80; margin-top: 4px; }}

  /* 컬럼 헤더 */
  .col-header {{ display: grid; grid-template-columns: 140px 1fr 1fr; gap: 12px; max-width: 1400px; margin: 0 auto 8px; padding: 0 4px; position: sticky; top: 0; z-index: 10; background: #0a0a0a; padding-top: 8px; padding-bottom: 8px; }}
  .col-header .label {{ font-size: 13px; font-weight: 700; text-align: center; padding: 8px; border-radius: 8px; }}
  .col-header .label.a {{ background: #2d1b1b; color: #f87171; }}
  .col-header .label.b {{ background: #1b2d3d; color: #60a5fa; }}
  .col-header .label.thumb {{ color: #666; }}

  /* 프레임 행 */
  .frame-row {{ display: grid; grid-template-columns: 140px 1fr 1fr; gap: 12px; max-width: 1400px; margin: 0 auto 8px; background: #131313; border: 1px solid #1e1e1e; border-radius: 10px; overflow: hidden; }}
  .frame-row:hover {{ border-color: #333; }}

  .frame-thumb {{ display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 8px; background: #0e0e0e; }}
  .frame-thumb img {{ width: 120px; height: auto; border-radius: 6px; }}
  .frame-label {{ font-size: 11px; color: #888; margin-top: 4px; }}

  .analysis-col {{ padding: 12px 16px; font-size: 13px; line-height: 1.7; }}
  .a-col {{ border-right: 1px solid #1e1e1e; }}

  .field {{ margin-bottom: 8px; }}
  .field-label {{ display: inline-block; font-size: 11px; font-weight: 600; color: #666; background: #1a1a1a; padding: 1px 6px; border-radius: 4px; margin-right: 6px; }}
  .empty {{ color: #555; font-style: italic; }}

  /* 하이라이트 차이 */
  .diff-marker {{ background: #3b2f00; padding: 1px 3px; border-radius: 3px; }}

  /* 필터 */
  .filter-bar {{ text-align: center; margin-bottom: 16px; }}
  .filter-bar button {{ background: #1a1a1a; border: 1px solid #333; color: #ccc; padding: 6px 14px; border-radius: 6px; margin: 0 4px; cursor: pointer; font-size: 12px; }}
  .filter-bar button:hover, .filter-bar button.active {{ background: #2a2a2a; color: #fff; border-color: #555; }}
</style>
</head>
<body>

<div class="header">
  <h1>Gemini 2.5 Flash — 1장씩 vs 3장씩 품질 비교</h1>
  <div class="sub">reel: {shortcode} | {stats_a['frames']}프레임 | {time.strftime('%Y-%m-%d %H:%M')}</div>
</div>

<div class="stats">
  <div class="stat">
    <div class="label">API 호출</div>
    <div class="row"><span class="val a">{stats_a['api_calls']}회</span><span class="vs">vs</span><span class="val b">{stats_b['api_calls']}회</span></div>
  </div>
  <div class="stat">
    <div class="label">소요 시간</div>
    <div class="row"><span class="val a">{stats_a['elapsed']:.0f}s</span><span class="vs">vs</span><span class="val b">{stats_b['elapsed']:.0f}s</span></div>
    <div class="diff">B가 {speed_pct:.0f}% 빠름</div>
  </div>
  <div class="stat">
    <div class="label">총 토큰</div>
    <div class="row"><span class="val a">{stats_a['input_tokens']+stats_a['output_tokens']+stats_a['thinking_tokens']:,}</span><span class="vs">vs</span><span class="val b">{stats_b['input_tokens']+stats_b['output_tokens']+stats_b['thinking_tokens']:,}</span></div>
  </div>
  <div class="stat">
    <div class="label">비용</div>
    <div class="row"><span class="val a">{stats_a['cost_krw']:.1f}원</span><span class="vs">vs</span><span class="val b">{stats_b['cost_krw']:.1f}원</span></div>
    <div class="diff">B가 {cost_pct:.0f}% 저렴</div>
  </div>
</div>

<div class="col-header">
  <div class="label thumb">프레임</div>
  <div class="label a">A: 1장씩 개별 호출</div>
  <div class="label b">B: 3장씩 묶음 호출</div>
</div>

{rows_html}

<script>
// 텍스트 차이 하이라이트 (간단 버전)
document.querySelectorAll('.frame-row').forEach(row => {{
  const cols = row.querySelectorAll('.analysis-col');
  if (cols.length < 2) return;
  const aText = cols[0].querySelector('.field')?.textContent || '';
  const bText = cols[1].querySelector('.field')?.textContent || '';
}});
</script>
</body>
</html>"""

    output_path = os.path.join(os.path.dirname(__file__), "compare_quality.html")
    with open(output_path, "w", encoding="utf-8") as f:
        f.write(html)
    print(f"\n[HTML] 비교 페이지 저장: {output_path}")
    return output_path


# ============================================
# 결과 JSON 저장
# ============================================
def save_results(shortcode, results_a, results_b, stats_a, stats_b):
    output = {
        "shortcode": shortcode,
        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
        "stats_a": stats_a,
        "stats_b": stats_b,
        "results_a": results_a,
        "results_b": results_b,
    }
    path = os.path.join(os.path.dirname(__file__), "compare_quality_data.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)
    print(f"[JSON] 데이터 저장: {path}")


# ============================================
# main
# ============================================
if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Gemini 2.5 Flash 1장씩 vs 3장씩 품질 비교")
    parser.add_argument("--shortcode", default="DON6F5vk6Ek", help="릴스 shortcode")
    parser.add_argument("--video", help="로컬 비디오 파일")
    parser.add_argument("--only-b", action="store_true", help="A 결과 캐시 사용, B만 실행")
    args = parser.parse_args()

    shortcode = args.shortcode
    video_path = None
    tmpdir_obj = None
    cache_path = os.path.join(os.path.dirname(__file__), "compare_quality_data.json")

    if args.video:
        video_path = args.video
    else:
        video_url = get_video_url(shortcode)
        if not video_url:
            print("[ERROR] 비디오 URL을 가져올 수 없습니다.")
            sys.exit(1)
        tmpdir_obj = tempfile.TemporaryDirectory()
        video_path = os.path.join(tmpdir_obj.name, "reel.mp4")
        download_video(video_url, video_path)

    # 1초 간격 프레임 추출
    frames_dir = os.path.join(os.path.dirname(video_path), "frames_quality")
    frames = extract_1sec_frames(video_path, frames_dir)

    if not frames:
        print("[ERROR] 프레임 추출 실패")
        sys.exit(1)

    # A 결과: 캐시 있으면 재사용
    if args.only_b and os.path.exists(cache_path):
        print("[캐시] A 결과 재사용")
        with open(cache_path, "r", encoding="utf-8") as f:
            cached = json.load(f)
        results_a = cached["results_a"]
        stats_a = cached["stats_a"]
    else:
        print(f"\n총 {len(frames)}장 프레임 - A(1장씩) 분석 시작\n")
        results_a, stats_a = run_method_a(frames)
        # A 결과 중간 저장
        with open(cache_path, "w", encoding="utf-8") as f:
            json.dump({"results_a": results_a, "stats_a": stats_a}, f, ensure_ascii=False, indent=2)
        print("[캐시] A 결과 중간 저장 완료")

    # B: 3장씩
    print(f"\n총 {len(frames)}장 프레임 - B(3장씩) 분석 시작\n")
    results_b, stats_b = run_method_b(frames)

    # 결과 저장
    save_results(shortcode, results_a, results_b, stats_a, stats_b)

    # HTML 비교 페이지 생성
    generate_html(shortcode, frames, results_a, results_b, stats_a, stats_b)

    if tmpdir_obj:
        tmpdir_obj.cleanup()

    print("\n완료!")
