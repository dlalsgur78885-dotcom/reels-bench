"""
0.5초 간격 프레임 + 3장 묶음 호출 + Gemini가 컷 전환 판단
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


def extract_frames_05sec(video_path, output_dir):
    ffmpeg = get_ffmpeg()
    os.makedirs(output_dir, exist_ok=True)
    cmd = [
        ffmpeg, "-i", video_path,
        "-vf", "fps=2", "-q:v", "2",
        os.path.join(output_dir, "frame_%04d.jpg"), "-y"
    ]
    subprocess.run(cmd, capture_output=True, text=True)
    frames = sorted(Path(output_dir).glob("frame_*.jpg"))
    result = []
    for i, f in enumerate(frames):
        with open(f, "rb") as fp:
            b64 = base64.b64encode(fp.read()).decode()
        t = i * 0.5
        result.append({"index": i + 1, "time": t, "path": str(f), "b64": b64})
    print(f"[frame] {len(result)} frames (0.5s interval)")
    return result


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
            print(f"  rate limit - {wait}s wait")
            time.sleep(wait)
        else:
            print(f"  API error: {resp.status_code}")
            return None
    return None


BATCH3_PROMPT = """아래 이미지 {n}장은 인스타 릴스 영상에서 0.5초 간격으로 추출한 연속 프레임이야.
순서대로 {times} 시점 (전체 {total}장 중 {start}~{end}번째).

각 프레임마다 한 줄씩 분석해줘. 서두 없이 바로 시작:

형식: [{time_fmt}] 장면설명 | 화면텍스트: "있으면 적기" | 컷전환: Y/N

규칙:
- 이전 프레임과 비교해서 장면이 확실히 바뀌었을 때만 컷전환: Y. 같은 장면 내 움직임은 N.
- 이전 프레임과 맥락 유지. 같은 장면이면 "이어서~" 형태.
- 장면이 바뀌었을 때만 새로운 설명, 동일하면 행동/변화 위주.
- 화면 자막/텍스트 오버레이는 정확하게 옮겨 적기.
- [{time_fmt}] 형식으로 바로 시작할 것.
"""


def run_batch3(frames):
    import re as _re
    total = len(frames)
    print(f"\n[B] 3장씩 묶음 호출 - {total}장 (0.5s interval)")

    lines = []
    total_input = total_output = total_thinking = 0
    start = time.time()
    call_count = 0

    for i in range(0, total, 3):
        chunk = frames[i:i+3]
        n = len(chunk)
        times = ", ".join([f"{c['time']:.1f}초" for c in chunk])
        time_fmt = "N.N초"

        prompt = BATCH3_PROMPT.format(
            n=n, times=times, total=total,
            start=chunk[0]["index"], end=chunk[-1]["index"],
            time_fmt=time_fmt,
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
            for line in resp["content"].strip().split('\n'):
                line = line.strip()
                if line.startswith(('*', '-')):
                    line = line.lstrip('*- ').strip()
                if _re.match(r'\[?\d+\.?\d*\s*초?\]?', line):
                    lines.append(line)
            print(f"  [{chunk[0]['index']}~{chunk[-1]['index']}] ok")
        else:
            for c in chunk:
                lines.append(f"[{c['time']:.1f}초] (fail)")
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


def generate_page(title, badge, accent, analysis_text, stats, frame_b64, shortcode, output_path):
    import re

    frame_lines = {}
    summary_lines = []
    for line in analysis_text.split('\n'):
        stripped = line.strip()
        m = re.match(r'\[?(\d+\.?\d*)\s*초?\]?\s*(.*)', stripped)
        if m:
            frame_lines[float(m.group(1))] = m.group(2)
        elif stripped.startswith(('-', '*')) and len(stripped) > 3:
            summary_lines.append(stripped)

    sorted_secs = sorted(frame_lines.keys())
    total_secs = len(sorted_secs)

    # Gemini 응답에서 컷 전환 파싱
    cut_markers = []
    for sec in sorted_secs:
        info = frame_lines[sec]
        is_cut = False
        parts = info.split('|')
        for p in parts:
            if '컷전환' in p and 'Y' in p:
                is_cut = True
        cut_markers.append(1 if is_cut else 0)

    cumulative_cuts = []
    t = 0
    for c in cut_markers:
        t += c
        cumulative_cuts.append(t)
    max_cut = max(cumulative_cuts) if cumulative_cuts else 1

    js_frames = {}
    for sec in sorted_secs:
        # frame index: sec / 0.5 + 1
        fidx = int(sec / 0.5) + 1
        js_frames[str(sec)] = {
            "img": frame_b64.get(fidx, ""),
            "desc": frame_lines.get(sec, ""),
            "cut": cut_markers[sorted_secs.index(sec)],
        }
    js_data = json.dumps(js_frames, ensure_ascii=False)
    js_secs = json.dumps(sorted_secs)
    js_cuts = json.dumps(cumulative_cuts)

    summary_html = ""
    for line in summary_lines:
        summary_html += f'<div style="color:#474B56;font-size:13px;line-height:1.7;margin:2px 0;">{line}</div>'

    frame_list_html = ""
    for sec in sorted_secs:
        frame_list_html += f'<div style="padding:6px 0;border-bottom:1px solid #F0F1F5;font-size:13px;color:#474B56;line-height:1.6;"><strong>[{sec:.1f}초]</strong> {frame_lines[sec]}</div>'

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

  .chart-wrap {{ background: #FAFBFC; border: 1px solid #E5E7EB; border-radius: 10px; padding: 20px; margin-bottom: 20px; }}
  .chart-area {{ position: relative; width: 100%; height: 120px; cursor: crosshair; user-select: none; }}
  .chart-area canvas {{ width: 100%; height: 100%; }}
  #vline {{ position: absolute; top: 0; width: 2px; height: 100%; background: {accent}; pointer-events: none; z-index: 10; }}
  #vline::after {{ content: attr(data-label); position: absolute; top: -18px; left: 50%; transform: translateX(-50%); background: {accent}; color: #fff; font-size: 11px; font-weight: 700; padding: 1px 6px; border-radius: 3px; white-space: nowrap; }}

  .legend {{ display: flex; gap: 14px; margin-bottom: 8px; font-size: 11px; color: #8B94A9; }}
  .legend span {{ display: flex; align-items: center; gap: 4px; }}
  .ldot {{ width: 8px; height: 8px; border-radius: 50%; }}

  #viewer {{ display: flex; gap: 16px; margin-top: 16px; min-height: 320px; }}
  #frame-img {{ width: 180px; min-height: 320px; border-radius: 10px; object-fit: cover; background: #F2F3F7; flex-shrink: 0; }}
  #frame-desc {{ flex: 1; }}
  #frame-sec {{ color: {accent}; font-size: 18px; font-weight: 700; margin-bottom: 8px; }}
  .desc-line {{ color: #474B56; font-size: 13px; line-height: 1.7; margin-bottom: 4px; }}
  .cut-badge {{ display: inline-block; background: #FEE2E2; color: #DC2626; font-size: 10px; font-weight: 700; padding: 1px 6px; border-radius: 4px; margin-left: 6px; }}

  .frame-list {{ background: #FAFBFC; border: 1px solid #E5E7EB; border-radius: 10px; padding: 16px 20px; margin-top: 16px; }}
  .frame-list-toggle {{ cursor: pointer; color: {accent}; font-size: 13px; font-weight: 600; margin-bottom: 8px; }}
  .frame-list-body {{ max-height: 400px; overflow-y: auto; }}
  .summary {{ background: #FAFBFC; border: 1px solid #E5E7EB; border-radius: 10px; padding: 16px 20px; margin-top: 16px; }}
</style>
</head>
<body>

<div class="header">
  <div class="badge">{badge}</div>
  <h1>{title}</h1>
  <div class="sub">reel: {shortcode} | {total_secs}프레임 (0.5s) | Gemini 2.5 Flash</div>
</div>

<div class="kpi-row">
  <div class="kpi"><div class="label">API 호출</div><div class="val">{stats['api_calls']}<span class="unit">회</span></div></div>
  <div class="kpi"><div class="label">소요 시간</div><div class="val">{stats['elapsed']:.0f}<span class="unit">s</span></div></div>
  <div class="kpi"><div class="label">총 토큰</div><div class="val">{total_tokens:,}</div></div>
  <div class="kpi"><div class="label">비용</div><div class="val">{stats['cost_krw']:.1f}<span class="unit">원</span></div></div>
  <div class="kpi"><div class="label">컷 전환</div><div class="val">{sum(cut_markers)}<span class="unit">회</span></div></div>
</div>

<div class="chart-wrap">
  <p class="section-title">프레임 타임라인 (Gemini 컷 판단)</p>
  <div class="legend">
    <span><span class="ldot" style="background:#8B5CF6;"></span> 누적 컷</span>
    <span><span class="ldot" style="background:{accent};border-radius:0;height:2px;width:12px;"></span> 현재 위치</span>
    <span><span class="ldot" style="background:#DC2626;"></span> 컷 전환 지점</span>
  </div>
  <div class="chart-area" id="timeline">
    <canvas id="chart"></canvas>
    <div id="vline" data-label="0:00.0"></div>
  </div>

  <div id="viewer">
    <img id="frame-img" src="" alt="" />
    <div id="frame-desc">
      <div id="frame-sec">[0.0초]</div>
      <div id="frame-text"></div>
    </div>
  </div>
</div>

{f'<div class="summary">{summary_html}</div>' if summary_html else ''}

<div class="frame-list">
  <div class="frame-list-toggle" onclick="this.nextElementSibling.style.display=this.nextElementSibling.style.display==='none'?'block':'none'">
    전체 프레임 보기 ({total_secs}장) &#9662;
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

  ctx2d.strokeStyle = '#E5E7EB'; ctx2d.lineWidth = 1;
  for (let i = 0; i <= 3; i++) {{
    const y = pad.t + ch * (1 - i/3);
    ctx2d.beginPath(); ctx2d.moveTo(pad.l, y); ctx2d.lineTo(w-pad.r, y); ctx2d.stroke();
  }}

  ctx2d.fillStyle = '#8B94A9'; ctx2d.font = '10px Pretendard Variable,sans-serif'; ctx2d.textAlign = 'center';
  const step = Math.max(1, Math.floor(SECS.length / 10));
  for (let i = 0; i < SECS.length; i += step) {{
    const x = pad.l + (i / (SECS.length-1)) * cw;
    const s = SECS[i];
    const mm = Math.floor(s/60);
    const ss = (s % 60).toFixed(0);
    ctx2d.fillText(mm + ':' + ss.padStart(2,'0'), x, h - 4);
  }}

  // 컷 전환 수직 마커
  for (let i = 0; i < SECS.length; i++) {{
    const d = DATA[String(SECS[i])] || {{}};
    if (d.cut) {{
      const x = pad.l + (i / (SECS.length-1)) * cw;
      ctx2d.strokeStyle = '#DC262640'; ctx2d.lineWidth = 1;
      ctx2d.beginPath(); ctx2d.moveTo(x, pad.t); ctx2d.lineTo(x, pad.t+ch); ctx2d.stroke();
    }}
  }}

  // 누적 컷 라인
  ctx2d.strokeStyle = '#8B5CF6'; ctx2d.lineWidth = 2;
  ctx2d.beginPath();
  for (let i = 0; i < SECS.length; i++) {{
    const x = pad.l + (i / (SECS.length-1)) * cw;
    const y = pad.t + ch * (1 - CUTS[i] / MAX_CUT);
    i === 0 ? ctx2d.moveTo(x, y) : ctx2d.lineTo(x, y);
  }}
  ctx2d.stroke();

  // 컷 점
  for (let i = 0; i < SECS.length; i++) {{
    const d = DATA[String(SECS[i])] || {{}};
    if (d.cut) {{
      const x = pad.l + (i / (SECS.length-1)) * cw;
      const y = pad.t + ch * (1 - CUTS[i] / MAX_CUT);
      ctx2d.beginPath(); ctx2d.arc(x, y, 4, 0, Math.PI*2);
      ctx2d.fillStyle = '#DC2626'; ctx2d.fill();
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
  vline.setAttribute('data-label', sec.toFixed(1) + 's');

  const d = DATA[String(sec)] || {{}};
  let secHtml = '[' + sec.toFixed(1) + '초]';
  if (d.cut) secHtml += ' <span style="display:inline-block;background:#FEE2E2;color:#DC2626;font-size:10px;font-weight:700;padding:1px 6px;border-radius:4px;margin-left:6px;">CUT</span>';
  frameSec.innerHTML = secHtml;

  if (d.img) {{
    frameImg.src = 'data:image/jpeg;base64,' + d.img;
    frameImg.style.display = 'block';
  }} else {{ frameImg.style.display = 'none'; }}

  if (d.desc) {{
    const parts = d.desc.split('|').map(p => p.trim()).filter(Boolean);
    frameText.innerHTML = parts.map(p => '<div class="desc-line">' + p + '</div>').join('');
  }} else {{
    frameText.innerHTML = '<div class="desc-line" style="color:#8B94A9;">-</div>';
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


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--shortcode", default="DON6F5vk6Ek")
    parser.add_argument("--video", help="local video")
    args = parser.parse_args()

    shortcode = args.shortcode
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

    frames = extract_frames_05sec(video_path, os.path.join(os.path.dirname(video_path), "frames_05"))
    frame_b64 = {f["index"]: f["b64"] for f in frames}

    if not frames:
        print("[ERROR] no frames")
        sys.exit(1)

    analysis_text, stats = run_batch3(frames)

    # 캐시 저장
    cache_path = os.path.join(os.path.dirname(__file__), "analysis_05sec_cache.json")
    with open(cache_path, "w", encoding="utf-8") as f:
        json.dump({"analysis": analysis_text, "stats": stats}, f, ensure_ascii=False, indent=2)

    generate_page(
        title="0.5초 프레임 + 3장 묶음 (Gemini 컷 판단)",
        badge="0.5s INTERVAL + BATCH 3",
        accent="#8B5CF6",
        analysis_text=analysis_text,
        stats=stats,
        frame_b64=frame_b64,
        shortcode=shortcode,
        output_path=os.path.join(os.path.dirname(__file__), "result_05sec.html"),
    )

    if tmpdir_obj:
        tmpdir_obj.cleanup()

    print("\nDone!")
