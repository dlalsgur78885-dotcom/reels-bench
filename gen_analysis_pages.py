"""
기존 대시보드 '분석하기' 결과와 동일한 형태의 분석 페이지를 A/B 각각 생성.
A: 1장씩 개별 호출
B: 3장씩 묶음 호출

결과: result_a.html / result_b.html
"""

import os
import sys
import json
import base64
import time
import tempfile
import subprocess
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
# 프레임 추출
# ============================================
def extract_frames(video_path, output_dir):
    ffmpeg = get_ffmpeg()
    os.makedirs(output_dir, exist_ok=True)
    cmd = [
        ffmpeg, "-i", video_path,
        "-vf", "fps=1", "-q:v", "2",
        os.path.join(output_dir, "frame_%04d.jpg"), "-y"
    ]
    subprocess.run(cmd, capture_output=True, text=True)
    frames = sorted(Path(output_dir).glob("frame_*.jpg"))
    result = []
    for i, f in enumerate(frames):
        with open(f, "rb") as fp:
            b64 = base64.b64encode(fp.read()).decode()
        result.append({"index": i + 1, "time": i, "path": str(f), "b64": b64})
    print(f"[frame] {len(result)} frames extracted")
    return result


def detect_cuts_ffmpeg(video_path, threshold=0.3):
    """ffmpeg scene detection으로 컷 전환 초 목록 반환"""
    import re as _re
    ffmpeg = get_ffmpeg()
    cmd = [
        ffmpeg, "-i", video_path,
        "-vf", f"select='gt(scene,{threshold})',showinfo",
        "-vsync", "vfr", "-f", "null", "-"
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    cut_seconds = set()
    for line in result.stderr.split("\n"):
        if "showinfo" in line and "pts_time:" in line:
            m = _re.search(r"pts_time:\s*([\d.]+)", line)
            if m:
                cut_seconds.add(int(float(m.group(1))))
    print(f"[cuts] ffmpeg detected {len(cut_seconds)} cuts: {sorted(cut_seconds)}")
    return cut_seconds


def call_gemini(parts, timeout=300):
    for attempt in range(3):
        resp = requests.post(
            GEMINI_URL,
            json={"contents": [{"parts": parts}], "generationConfig": {"maxOutputTokens": 16384}},
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
            print(f"  rate limit - waiting {wait}s")
            time.sleep(wait)
        else:
            print(f"  API error: {resp.status_code}")
            return None
    return None


# ============================================
# 기존 대시보드와 동일한 프롬프트
# ============================================
DASHBOARD_PROMPT = """이 이미지들은 인스타 릴스 영상의 1초 간격 프레임 {total}장이야.
각 프레임을 순서대로 분석해줘. 프레임마다 한 줄씩:

형식: [N초] 장면설명 | 화면텍스트: "있으면 적기" | 컷전환: Y/N

중요 규칙:
- 이전 프레임과의 맥락을 유지해서 분석해. 같은 장면이 이어지면 "이어서~" 형태로 연결감을 줘.
- 장면이 바뀌었을 때만 새로운 설명을 작성하고, 동일 장면이면 행동/변화 위주로 간결하게.
- 화면에 보이는 자막/텍스트 오버레이는 정확하게 옮겨 적어.

마지막에 요약:
- 총 컷 전환 횟수: N회
- 후킹 텍스트(처음 3초 내 화면 텍스트): "있으면 적기"
- 텍스트 오버레이 전환 횟수: N회
"""

SINGLE_PROMPT = """이 이미지는 인스타 릴스 영상의 {idx}번째 프레임이야 ({time}초 시점, 전체 {total}장).

반드시 아래 형식 한 줄로만 답변해줘 (다른 말 붙이지 마):
[{time}초] 장면설명 | 화면텍스트: "있으면 적기"

규칙:
- 화면에 보이는 자막/텍스트 오버레이는 정확하게 옮겨 적어.
- 장면설명은 인물, 배경, 구도, 행동 포함.
"""

BATCH3_PROMPT = """아래 이미지 {n}장은 인스타 릴스 영상에서 1초 간격으로 추출한 연속 프레임이야.
순서대로 {times} 시점 (전체 {total}장 중 {start}~{end}번째).

각 프레임마다 한 줄씩 분석해줘. 서두/인사 없이 바로 시작:

형식: [N초] 장면설명 | 화면텍스트: "있으면 적기" | 컷전환: Y/N

규칙:
- 이전 프레임과의 맥락을 유지. 같은 장면이면 "이어서~" 형태.
- 장면이 바뀌었을 때만 새로운 설명, 동일하면 행동/변화 위주.
- 화면 자막/텍스트 오버레이는 정확하게 옮겨 적기.
- 서두("분석입니다" 등) 없이 [N초]로 바로 시작할 것.
"""


# ============================================
# A: 1장씩 개별 호출
# ============================================
def run_method_a(frames):
    total = len(frames)
    print(f"\n[A] 1장씩 개별 호출 - {total}장")

    lines = []
    total_input = total_output = total_thinking = 0
    start = time.time()

    for frame in frames:
        prompt = SINGLE_PROMPT.format(idx=frame["index"], time=frame["time"], total=total)
        parts = [
            {"text": prompt},
            {"inline_data": {"mime_type": "image/jpeg", "data": frame["b64"]}}
        ]
        resp = call_gemini(parts, timeout=120)
        if resp:
            total_input += resp["input_tokens"]
            total_output += resp["output_tokens"]
            total_thinking += resp["thinking_tokens"]
            # 응답에서 [N초] 라인 추출
            raw = resp["content"].strip()
            # 여러 줄이면 첫 줄만
            line = raw.split('\n')[0].strip()
            lines.append(line)
            print(f"  [{frame['index']:2d}/{total}] ok")
        else:
            lines.append(f"[{frame['time']}초] (분석 실패)")
            print(f"  [{frame['index']:2d}/{total}] fail")

    elapsed = time.time() - start
    cost_usd = (total_input * 0.15 + total_output * 0.60 + total_thinking * 0.60) / 1_000_000
    cost_krw = cost_usd * 1380

    analysis_text = "\n".join(lines)
    stats = {
        "api_calls": total, "elapsed": elapsed,
        "input_tokens": total_input, "output_tokens": total_output, "thinking_tokens": total_thinking,
        "cost_usd": cost_usd, "cost_krw": cost_krw,
    }
    print(f"  {elapsed:.0f}s | ${cost_usd:.4f} ({cost_krw:.1f}won)")
    return analysis_text, stats


# ============================================
# B: 3장씩 묶어서 호출
# ============================================
def run_method_b(frames):
    total = len(frames)
    print(f"\n[B] 3장씩 묶음 호출 - {total}장")

    lines = []
    total_input = total_output = total_thinking = 0
    start = time.time()
    call_count = 0

    for i in range(0, total, 3):
        chunk = frames[i:i+3]
        n = len(chunk)
        times = ", ".join([f"{c['time']}초" for c in chunk])

        prompt = BATCH3_PROMPT.format(
            n=n, times=times, total=total,
            start=chunk[0]["index"], end=chunk[-1]["index"],
        )
        parts = [{"text": prompt}]
        for c in chunk:
            parts.append({"inline_data": {"mime_type": "image/jpeg", "data": c["b64"]}})

        resp = call_gemini(parts, timeout=300)
        call_count += 1

        if resp:
            total_input += resp["input_tokens"]
            total_output += resp["output_tokens"]
            total_thinking += resp["thinking_tokens"]
            # 응답 라인 추가 ([N초] 패턴만)
            import re as _re
            for line in resp["content"].strip().split('\n'):
                line = line.strip()
                # 불릿 마커 제거
                if line.startswith(('*', '-')):
                    line = line.lstrip('*- ').strip()
                if _re.match(r'\[?\d+\s*초?\]?', line):
                    lines.append(line)
            print(f"  [{chunk[0]['index']}~{chunk[-1]['index']}] ok")
        else:
            for c in chunk:
                lines.append(f"[{c['time']}초] (분석 실패)")
            print(f"  [{chunk[0]['index']}~{chunk[-1]['index']}] fail")

        if i + 3 < total:
            time.sleep(2)

    elapsed = time.time() - start
    cost_usd = (total_input * 0.15 + total_output * 0.60 + total_thinking * 0.60) / 1_000_000
    cost_krw = cost_usd * 1380

    analysis_text = "\n".join(lines)
    stats = {
        "api_calls": call_count, "elapsed": elapsed,
        "input_tokens": total_input, "output_tokens": total_output, "thinking_tokens": total_thinking,
        "cost_usd": cost_usd, "cost_krw": cost_krw,
    }
    print(f"  {elapsed:.0f}s | {call_count} calls | ${cost_usd:.4f} ({cost_krw:.1f}won)")
    return analysis_text, stats


# ============================================
# HTML 페이지 생성 (대시보드 분석 결과와 동일한 UI)
# ============================================
def generate_page(title, badge, accent, analysis_text, stats, frame_b64, shortcode, output_path, cut_seconds=None):
    import re

    # [N초] 라인 파싱
    frame_lines = {}
    summary_lines = []
    for line in analysis_text.split('\n'):
        stripped = line.strip()
        m = re.match(r'\[?(\d+)\s*초?\]?\s*(.*)', stripped)
        if m:
            frame_lines[int(m.group(1))] = m.group(2)
        elif stripped.startswith(('-', '*')) and len(stripped) > 3:
            summary_lines.append(stripped)

    sorted_secs = sorted(frame_lines.keys())
    total_secs = len(sorted_secs)

    # 컷 전환: ffmpeg scene detection 결과 사용 (A/B 동일 기준)
    _cut_set = cut_seconds or set()
    cut_markers = []
    for sec in sorted_secs:
        cut_markers.append(1 if sec in _cut_set else 0)

    cumulative_cuts = []
    t = 0
    for c in cut_markers:
        t += c
        cumulative_cuts.append(t)
    max_cut = max(cumulative_cuts) if cumulative_cuts else 1

    # JS 데이터
    js_frames = {}
    for sec in sorted_secs:
        js_frames[sec] = {
            "img": frame_b64.get(sec + 1, ""),  # frame index is 1-based, sec is 0-based
            "desc": frame_lines.get(sec, ""),
            "cut": cut_markers[sorted_secs.index(sec)],
        }
    js_data = json.dumps(js_frames, ensure_ascii=False)
    js_secs = json.dumps(sorted_secs)
    js_cuts = json.dumps(cumulative_cuts)

    # 요약 텍스트
    summary_html = ""
    for line in summary_lines:
        summary_html += f'<div style="color:#474B56;font-size:13px;line-height:1.7;margin:2px 0;">{line}</div>'

    # 전체 프레임 목록
    frame_list_html = ""
    for sec in sorted_secs:
        frame_list_html += f'<div style="padding:6px 0;border-bottom:1px solid #F0F1F5;font-size:13px;color:#474B56;line-height:1.6;"><strong>[{sec}초]</strong> {frame_lines[sec]}</div>'

    total_tokens = stats["input_tokens"] + stats["output_tokens"] + stats["thinking_tokens"]

    html = f"""<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{title} | {shortcode}</title>
<style>
  @import url('https://cdn.jsdelivr.net/gh/orioncactus/pretendard/dist/web/variable/pretendardvariable.css');
  * {{ margin: 0; padding: 0; box-sizing: border-box; }}
  body {{ font-family: 'Pretendard Variable', -apple-system, sans-serif; background: #FFFFFF; color: #474B56; padding: 24px; max-width: 960px; margin: 0 auto; }}

  .header {{ margin-bottom: 24px; padding-bottom: 16px; border-bottom: 1px solid #E5E7EB; }}
  .header .badge {{ display: inline-block; font-size: 11px; font-weight: 700; padding: 3px 12px; border-radius: 20px; background: {accent}18; color: {accent}; border: 1px solid {accent}33; margin-bottom: 8px; letter-spacing: .5px; }}
  .header h1 {{ font-size: 20px; color: #121721; margin-bottom: 4px; }}
  .header .sub {{ color: #8B94A9; font-size: 12px; }}

  .kpi-row {{ display: grid; grid-template-columns: repeat(5, 1fr); gap: 10px; margin-bottom: 20px; }}
  .kpi {{ background: #FAFBFC; border: 1px solid #E5E7EB; border-radius: 8px; padding: 12px; text-align: center; }}
  .kpi .label {{ font-size: 10px; color: #8B94A9; text-transform: uppercase; letter-spacing: .5px; margin-bottom: 4px; }}
  .kpi .val {{ font-size: 18px; font-weight: 700; color: {accent}; }}
  .kpi .unit {{ font-size: 11px; color: #8B94A9; font-weight: 400; }}

  .section-title {{ font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: .08em; color: #8B94A9; margin: 20px 0 8px; }}

  /* 타임라인 차트 */
  .chart-wrap {{ background: #FAFBFC; border: 1px solid #E5E7EB; border-radius: 10px; padding: 20px; margin-bottom: 20px; }}
  .chart-area {{ position: relative; width: 100%; height: 120px; cursor: crosshair; user-select: none; }}
  .chart-area canvas {{ width: 100%; height: 100%; }}
  #vline {{ position: absolute; top: 0; width: 2px; height: 100%; background: {accent}; pointer-events: none; z-index: 10; }}
  #vline::after {{ content: attr(data-label); position: absolute; top: -18px; left: 50%; transform: translateX(-50%); background: {accent}; color: #fff; font-size: 11px; font-weight: 700; padding: 1px 6px; border-radius: 3px; white-space: nowrap; }}

  .legend {{ display: flex; gap: 14px; margin-bottom: 8px; font-size: 11px; color: #8B94A9; }}
  .legend span {{ display: flex; align-items: center; gap: 4px; }}
  .ldot {{ width: 8px; height: 8px; border-radius: 50%; }}

  /* 프레임 뷰어 */
  #viewer {{ display: flex; gap: 16px; margin-top: 16px; min-height: 320px; }}
  #frame-img {{ width: 180px; min-height: 320px; border-radius: 10px; object-fit: cover; background: #F2F3F7; flex-shrink: 0; }}
  #frame-desc {{ flex: 1; }}
  #frame-sec {{ color: {accent}; font-size: 18px; font-weight: 700; margin-bottom: 8px; }}
  .desc-line {{ color: #474B56; font-size: 13px; line-height: 1.7; margin-bottom: 4px; }}

  /* 전체 프레임 목록 */
  .frame-list {{ background: #FAFBFC; border: 1px solid #E5E7EB; border-radius: 10px; padding: 16px 20px; margin-top: 16px; }}
  .frame-list-toggle {{ cursor: pointer; color: {accent}; font-size: 13px; font-weight: 600; margin-bottom: 8px; }}
  .frame-list-body {{ max-height: 400px; overflow-y: auto; }}

  /* 요약 */
  .summary {{ background: #FAFBFC; border: 1px solid #E5E7EB; border-radius: 10px; padding: 16px 20px; margin-top: 16px; }}
</style>
</head>
<body>

<div class="header">
  <div class="badge">{badge}</div>
  <h1>{title}</h1>
  <div class="sub">reel: {shortcode} | {total_secs}프레임 | Gemini 2.5 Flash</div>
</div>

<div class="kpi-row">
  <div class="kpi"><div class="label">API 호출</div><div class="val">{stats['api_calls']}<span class="unit">회</span></div></div>
  <div class="kpi"><div class="label">소요 시간</div><div class="val">{stats['elapsed']:.0f}<span class="unit">s</span></div></div>
  <div class="kpi"><div class="label">총 토큰</div><div class="val">{total_tokens:,}</div></div>
  <div class="kpi"><div class="label">비용</div><div class="val">{stats['cost_krw']:.1f}<span class="unit">원</span></div></div>
  <div class="kpi"><div class="label">컷 전환</div><div class="val">{sum(cut_markers)}<span class="unit">회</span></div></div>
</div>

<div class="chart-wrap">
  <p class="section-title">프레임 타임라인</p>
  <div class="legend">
    <span><span class="ldot" style="background:#8B5CF6;"></span> 누적 컷</span>
    <span><span class="ldot" style="background:{accent};border-radius:0;height:2px;width:12px;"></span> 현재 위치</span>
  </div>
  <div class="chart-area" id="timeline">
    <canvas id="chart"></canvas>
    <div id="vline" data-label="0:00"></div>
  </div>

  <div id="viewer">
    <img id="frame-img" src="" alt="" />
    <div id="frame-desc">
      <div id="frame-sec">[0초]</div>
      <div id="frame-text"></div>
    </div>
  </div>
</div>

{f'<div class="summary">{summary_html}</div>' if summary_html else ''}

<div class="frame-list">
  <div class="frame-list-toggle" onclick="this.nextElementSibling.style.display=this.nextElementSibling.style.display==='none'?'block':'none'">
    전체 프레임 보기 ▾
  </div>
  <div class="frame-list-body" style="display:none;">
    {frame_list_html}
  </div>
</div>

<script>
const DATA = {js_data};
const SECS = {js_secs};
const CUTS = {js_cuts};
const MAX_CUT = {max_cut} || 1;
const ACCENT = '{accent}';

const canvas = document.getElementById('chart');
const ctx2d = canvas.getContext('2d');
const timeline = document.getElementById('timeline');
const vline = document.getElementById('vline');
const frameImg = document.getElementById('frame-img');
const frameSec = document.getElementById('frame-sec');
const frameText = document.getElementById('frame-text');

function resize() {{
  canvas.width = timeline.clientWidth;
  canvas.height = timeline.clientHeight;
  draw();
}}

function draw() {{
  const w = canvas.width, h = canvas.height;
  const pad = {{l:30, r:10, t:8, b:22}};
  const cw = w - pad.l - pad.r;
  const ch = h - pad.t - pad.b;
  ctx2d.clearRect(0, 0, w, h);

  // grid
  ctx2d.strokeStyle = '#E5E7EB'; ctx2d.lineWidth = 1;
  for (let i = 0; i <= 3; i++) {{
    const y = pad.t + ch * (1 - i/3);
    ctx2d.beginPath(); ctx2d.moveTo(pad.l, y); ctx2d.lineTo(w-pad.r, y); ctx2d.stroke();
  }}

  // x labels
  ctx2d.fillStyle = '#8B94A9'; ctx2d.font = '10px Pretendard Variable,sans-serif'; ctx2d.textAlign = 'center';
  const step = Math.max(1, Math.floor(SECS.length / 8));
  for (let i = 0; i < SECS.length; i += step) {{
    const x = pad.l + (i / (SECS.length-1)) * cw;
    ctx2d.fillText('0:' + String(SECS[i]).padStart(2,'0'), x, h - 4);
  }}

  // 컷 전환 라인
  ctx2d.strokeStyle = '#8B5CF6'; ctx2d.lineWidth = 2;
  ctx2d.beginPath();
  for (let i = 0; i < SECS.length; i++) {{
    const x = pad.l + (i / (SECS.length-1)) * cw;
    const y = pad.t + ch * (1 - CUTS[i] / MAX_CUT);
    i === 0 ? ctx2d.moveTo(x, y) : ctx2d.lineTo(x, y);
  }}
  ctx2d.stroke();

  // 컷 전환 점
  for (let i = 0; i < SECS.length; i++) {{
    const d = DATA[SECS[i]] || {{}};
    if (d.cut) {{
      const x = pad.l + (i / (SECS.length-1)) * cw;
      const y = pad.t + ch * (1 - CUTS[i] / MAX_CUT);
      ctx2d.beginPath(); ctx2d.arc(x, y, 4, 0, Math.PI*2);
      ctx2d.fillStyle = ACCENT; ctx2d.fill();
    }}
  }}
}}

function getSecFromX(clientX) {{
  const rect = timeline.getBoundingClientRect();
  const pad = {{l:30, r:10}};
  const cw = rect.width - pad.l - pad.r;
  let ratio = (clientX - rect.left - pad.l) / cw;
  ratio = Math.max(0, Math.min(1, ratio));
  return SECS[Math.round(ratio * (SECS.length - 1))];
}}

function update(sec) {{
  const rect = timeline.getBoundingClientRect();
  const pad = {{l:30, r:10}};
  const cw = rect.width - pad.l - pad.r;
  const idx = SECS.indexOf(sec);
  const x = pad.l + (idx / (SECS.length-1)) * cw;
  vline.style.left = x + 'px';
  vline.setAttribute('data-label', '0:' + String(sec).padStart(2,'0'));

  const d = DATA[sec] || {{}};
  frameSec.textContent = '[' + sec + '초]';

  if (d.img) {{
    frameImg.src = 'data:image/jpeg;base64,' + d.img;
    frameImg.style.display = 'block';
  }} else {{ frameImg.style.display = 'none'; }}

  if (d.desc) {{
    const parts = d.desc.split('|').map(p => p.trim()).filter(Boolean);
    frameText.innerHTML = parts.map(p => '<div class="desc-line">' + p + '</div>').join('');
  }} else {{
    frameText.innerHTML = '<div class="desc-line" style="color:#8B94A9;">데이터 없음</div>';
  }}
}}

let dragging = false;
timeline.addEventListener('mousedown', e => {{ dragging = true; update(getSecFromX(e.clientX)); }});
window.addEventListener('mousemove', e => {{ if (dragging) update(getSecFromX(e.clientX)); }});
window.addEventListener('mouseup', () => {{ dragging = false; }});
timeline.addEventListener('touchstart', e => {{ dragging = true; update(getSecFromX(e.touches[0].clientX)); }}, {{passive:true}});
window.addEventListener('touchmove', e => {{ if (dragging) update(getSecFromX(e.touches[0].clientX)); }}, {{passive:true}});
window.addEventListener('touchend', () => {{ dragging = false; }});

window.addEventListener('resize', resize);
resize();
if (SECS.length) update(SECS[0]);
</script>
</body>
</html>"""

    with open(output_path, "w", encoding="utf-8") as f:
        f.write(html)
    print(f"[HTML] {output_path}")


# ============================================
# main
# ============================================
if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--shortcode", default="DON6F5vk6Ek")
    parser.add_argument("--video", help="local video")
    parser.add_argument("--only-b", action="store_true", help="skip A, use cache")
    args = parser.parse_args()

    shortcode = args.shortcode
    cache_path = os.path.join(os.path.dirname(__file__), "analysis_ab_cache.json")

    # 비디오 다운로드 + 프레임 추출
    tmpdir_obj = None
    if args.video:
        video_path = args.video
    else:
        video_url = get_video_url(shortcode)
        if not video_url:
            print("[ERROR] cannot get video URL")
            sys.exit(1)
        tmpdir_obj = tempfile.TemporaryDirectory()
        video_path = os.path.join(tmpdir_obj.name, "reel.mp4")
        download_video(video_url, video_path)

    frames_dir = os.path.join(os.path.dirname(video_path), "frames_ab")
    frames = extract_frames(video_path, frames_dir)
    frame_b64 = {f["index"]: f["b64"] for f in frames}

    if not frames:
        print("[ERROR] no frames")
        sys.exit(1)

    # ffmpeg scene detection (A/B 공통)
    cut_seconds = detect_cuts_ffmpeg(video_path, threshold=0.5)

    # A
    if args.only_b and os.path.exists(cache_path):
        print("[cache] loading A from cache")
        with open(cache_path, "r", encoding="utf-8") as f:
            cached = json.load(f)
        analysis_a = cached["analysis_a"]
        stats_a = cached["stats_a"]
    else:
        print(f"\n{len(frames)} frames - running A...")
        analysis_a, stats_a = run_method_a(frames)
        with open(cache_path, "w", encoding="utf-8") as f:
            json.dump({"analysis_a": analysis_a, "stats_a": stats_a}, f, ensure_ascii=False, indent=2)
        print("[cache] A saved")

    # B
    print(f"\n{len(frames)} frames - running B...")
    analysis_b, stats_b = run_method_b(frames)

    # 캐시 업데이트 (A+B)
    with open(cache_path, "w", encoding="utf-8") as f:
        json.dump({
            "analysis_a": analysis_a, "stats_a": stats_a,
            "analysis_b": analysis_b, "stats_b": stats_b,
        }, f, ensure_ascii=False, indent=2)

    base = os.path.dirname(__file__)

    generate_page(
        title="1장씩 개별 분석",
        badge="METHOD A - 1장씩",
        accent="#EF4444",
        analysis_text=analysis_a,
        stats=stats_a,
        frame_b64=frame_b64,
        shortcode=shortcode,
        output_path=os.path.join(base, "result_a.html"),
        cut_seconds=cut_seconds,
    )

    generate_page(
        title="3장씩 묶음 분석",
        badge="METHOD B - 3장씩",
        accent="#307df0",
        analysis_text=analysis_b,
        stats=stats_b,
        frame_b64=frame_b64,
        shortcode=shortcode,
        output_path=os.path.join(base, "result_b.html"),
        cut_seconds=cut_seconds,
    )

    if tmpdir_obj:
        tmpdir_obj.cleanup()

    print("\nDone!")
