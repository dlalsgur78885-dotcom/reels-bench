"""Gemini 2.5 Flash frame analysis (3-frame batch, 4 parallel)"""

import os
import re
import base64
import time
import requests
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from dotenv import load_dotenv

ENV_PATH = Path(__file__).parent.parent.parent / ".env"
load_dotenv(ENV_PATH)

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
GEMINI_URL = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={GEMINI_API_KEY}"


def _analyze_chunk(chunk_info):
    """Single 3-frame batch analysis"""
    idx, chunk, total = chunk_info
    n = len(chunk)
    times = ", ".join([f"{idx+j}초" for j in range(n)])

    prompt = f"""아래 이미지 {n}장은 인스타 릴스 영상에서 1초 간격으로 추출한 연속 프레임이야.
순서대로 {times} 시점 (전체 {total}장 중 {idx+1}~{idx+n}번째).

각 프레임마다 한 줄씩:
형식: [N초] 장면설명 | 화면텍스트: "있으면 적기" | 컷전환: Y/N

규칙:
- 같은 장면이면 "이어서~". 바뀌었을 때만 새 설명.
- 자막/텍스트 오버레이 정확히 옮겨 적기.
- [N초]로 바로 시작."""

    parts = [{"text": prompt}]
    for fp in chunk:
        with open(fp, "rb") as f:
            parts.append({"inline_data": {"mime_type": "image/jpeg", "data": base64.b64encode(f.read()).decode()}})

    for attempt in range(3):
        try:
            resp = requests.post(
                GEMINI_URL,
                json={"contents": [{"parts": parts}], "generationConfig": {"maxOutputTokens": 8192}},
                timeout=300,
            )
            if resp.status_code == 200:
                content = resp.json()["candidates"][0]["content"]["parts"][0]["text"]
                lines = []
                for line in content.strip().split('\n'):
                    line = line.strip().lstrip('*- ').strip()
                    if re.match(r'\[?\d+\s*초?\]?', line):
                        lines.append(line)
                return (idx, lines)
            elif resp.status_code == 429:
                time.sleep(10 * (attempt + 1))
        except Exception:
            break
    return (idx, [])


def analyze_batch(frame_paths, max_workers=4):
    """Analyze all frames: 3 per batch, parallel workers"""
    if not frame_paths or not GEMINI_API_KEY:
        return ""

    total = len(frame_paths)
    chunks = [(i, frame_paths[i:i+3], total) for i in range(0, total, 3)]

    with ThreadPoolExecutor(max_workers=max_workers) as ex:
        results = list(ex.map(_analyze_chunk, chunks))

    results.sort(key=lambda x: x[0])
    return "\n".join(line for _, lines in results for line in lines)
