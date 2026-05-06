"""
compare_quality_data.json에서 A/B 각각의 분석 결과 HTML 페이지 생성.
프레임 이미지 + 분석 결과를 보기 좋게 렌더링.
"""

import os
import sys
import json
import base64
import tempfile
import subprocess
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from test_qwen_vision import get_video_url, download_video, get_ffmpeg

DATA_PATH = os.path.join(os.path.dirname(__file__), "compare_quality_data.json")


def extract_frames_b64(video_path, output_dir):
    ffmpeg = get_ffmpeg()
    os.makedirs(output_dir, exist_ok=True)
    cmd = [
        ffmpeg, "-i", video_path,
        "-vf", "fps=1", "-q:v", "2",
        os.path.join(output_dir, "frame_%04d.jpg"), "-y"
    ]
    subprocess.run(cmd, capture_output=True, text=True)
    frames = sorted(Path(output_dir).glob("frame_*.jpg"))
    result = {}
    for i, f in enumerate(frames):
        with open(f, "rb") as fp:
            result[i + 1] = base64.b64encode(fp.read()).decode()
    return result


def generate_page(title, badge, color, results, stats, frame_b64, shortcode, output_path):
    cards = ""
    for r in results:
        idx = r["frame"]
        t = r["time"]
        img = frame_b64.get(idx, "")
        texts = ", ".join(r.get("texts", [])) or "없음"
        scene = r.get("scene", "") or "-"
        style = r.get("style", "") or "-"

        cards += f"""
    <div class="card">
      <div class="card-img">
        <img src="data:image/jpeg;base64,{img}" alt="frame {idx}" loading="lazy">
        <span class="time-badge">#{idx} ({t})</span>
      </div>
      <div class="card-body">
        <div class="field">
          <div class="field-label">텍스트</div>
          <div class="field-value">{texts}</div>
        </div>
        <div class="field">
          <div class="field-label">장면</div>
          <div class="field-value">{scene}</div>
        </div>
        <div class="field">
          <div class="field-label">스타일</div>
          <div class="field-value">{style}</div>
        </div>
      </div>
    </div>"""

    total_tokens = stats["input_tokens"] + stats["output_tokens"] + stats["thinking_tokens"]

    html = f"""<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{title} | {shortcode}</title>
<style>
  * {{ margin: 0; padding: 0; box-sizing: border-box; }}
  body {{ font-family: 'Pretendard', -apple-system, sans-serif; background: #0a0a0a; color: #e0e0e0; padding: 20px; max-width: 800px; margin: 0 auto; }}

  .header {{ text-align: center; margin-bottom: 24px; padding-bottom: 20px; border-bottom: 1px solid #222; }}
  .header h1 {{ font-size: 20px; color: #fff; margin-bottom: 8px; }}
  .header .badge {{ display: inline-block; font-size: 12px; font-weight: 700; padding: 4px 14px; border-radius: 20px; background: {color}22; color: {color}; border: 1px solid {color}44; margin-bottom: 12px; }}
  .header .sub {{ color: #888; font-size: 13px; }}

  .stats {{ display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 24px; }}
  .stat {{ background: #141414; border: 1px solid #222; border-radius: 8px; padding: 12px; text-align: center; }}
  .stat .label {{ font-size: 10px; color: #666; text-transform: uppercase; letter-spacing: .5px; margin-bottom: 4px; }}
  .stat .val {{ font-size: 18px; font-weight: 700; color: {color}; }}
  .stat .unit {{ font-size: 11px; color: #888; }}

  .card {{ display: flex; gap: 16px; background: #131313; border: 1px solid #1e1e1e; border-radius: 10px; margin-bottom: 8px; overflow: hidden; transition: border-color .15s; }}
  .card:hover {{ border-color: #333; }}

  .card-img {{ flex-shrink: 0; width: 160px; position: relative; background: #0e0e0e; display: flex; align-items: center; justify-content: center; }}
  .card-img img {{ width: 100%; height: auto; display: block; }}
  .time-badge {{ position: absolute; bottom: 6px; left: 6px; background: #000a; padding: 2px 8px; border-radius: 4px; font-size: 11px; color: #ccc; }}

  .card-body {{ flex: 1; padding: 14px 16px; }}

  .field {{ margin-bottom: 10px; }}
  .field:last-child {{ margin-bottom: 0; }}
  .field-label {{ font-size: 10px; font-weight: 700; color: #555; text-transform: uppercase; letter-spacing: .5px; margin-bottom: 3px; }}
  .field-value {{ font-size: 13px; line-height: 1.7; color: #ccc; }}
</style>
</head>
<body>

<div class="header">
  <div class="badge">{badge}</div>
  <h1>{title}</h1>
  <div class="sub">reel: {shortcode} | {stats['frames']}프레임 | Gemini 2.5 Flash</div>
</div>

<div class="stats">
  <div class="stat">
    <div class="label">API 호출</div>
    <div class="val">{stats['api_calls']}<span class="unit">회</span></div>
  </div>
  <div class="stat">
    <div class="label">소요 시간</div>
    <div class="val">{stats['elapsed']:.0f}<span class="unit">s</span></div>
  </div>
  <div class="stat">
    <div class="label">총 토큰</div>
    <div class="val">{total_tokens:,}</div>
  </div>
  <div class="stat">
    <div class="label">비용</div>
    <div class="val">{stats['cost_krw']:.1f}<span class="unit">원</span></div>
  </div>
</div>

{cards}

</body>
</html>"""

    with open(output_path, "w", encoding="utf-8") as f:
        f.write(html)
    print(f"[HTML] {output_path}")


if __name__ == "__main__":
    # 데이터 로드
    with open(DATA_PATH, "r", encoding="utf-8") as f:
        data = json.load(f)

    shortcode = data.get("shortcode", "DON6F5vk6Ek")

    # 프레임 이미지 추출
    print("[프레임] 비디오 다운로드 + 프레임 추출 중...")
    video_url = get_video_url(shortcode)
    if not video_url:
        print("[ERROR] 비디오 URL을 가져올 수 없습니다.")
        sys.exit(1)

    import tempfile as _tmp
    tmpdir = _tmp.mkdtemp()
    video_path = os.path.join(tmpdir, "reel.mp4")
    download_video(video_url, video_path)
    frame_b64 = extract_frames_b64(video_path, os.path.join(tmpdir, "frames"))
    print(f"[프레임] {len(frame_b64)}장 로드 완료")

    base = os.path.dirname(__file__)

    # A 페이지
    generate_page(
        title="1장씩 개별 분석",
        badge="METHOD A",
        color="#f87171",
        results=data["results_a"],
        stats=data["stats_a"],
        frame_b64=frame_b64,
        shortcode=shortcode,
        output_path=os.path.join(base, "result_a.html"),
    )

    # B 페이지
    generate_page(
        title="3장씩 묶음 분석",
        badge="METHOD B",
        color="#60a5fa",
        results=data["results_b"],
        stats=data["stats_b"],
        frame_b64=frame_b64,
        shortcode=shortcode,
        output_path=os.path.join(base, "result_b.html"),
    )

    # 임시 파일 정리
    import shutil
    shutil.rmtree(tmpdir, ignore_errors=True)

    print("\n완료! result_a.html / result_b.html 열어서 비교하세요.")
