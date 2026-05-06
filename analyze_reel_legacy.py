"""릴스 1개 통합 분석 파이프라인.

usage: python analyze_reel.py <shortcode> [--no-db] [--no-html]

단계:
  1. _tts_oneshot.py       — Hiker 다운로드 + Whisper + Gemini3 Pro TTS direction
  2. _full_analysis_oneshot.py — Gemini3 Pro 비디오 (BGM/SFX/cuts/hook/sync/viral)
  3. _emotion_finegrained.py   — Gemini3 Pro 오디오 (TTS 세그먼트별 감정)
  4. _merge_analysis.py        — 3개 JSON 병합 → analysis_<sc>.json
  5. _db_save_analysis.py      — reels_pro_audio.pro_audio JSONB upsert
  6. _gen_analysis_page.py     — analysis_<sc>.html 생성
"""
import os
import sys
import time
import subprocess
from pathlib import Path

ROOT = Path(__file__).parent
PY = sys.executable

if len(sys.argv) < 2:
    sys.exit("usage: python analyze_reel.py <shortcode> [--no-db] [--no-html]")

SHORTCODE = sys.argv[1]
NO_DB = "--no-db" in sys.argv
NO_HTML = "--no-html" in sys.argv

STEPS = [
    ("TTS direction (Whisper + Gemini3 Pro audio)", "_tts_oneshot.py"),
    ("Full video analysis (Gemini3 Pro video)",     "_full_analysis_oneshot.py"),
    ("Fine-grained emotion (Gemini3 Pro audio)",    "_emotion_finegrained.py"),
    ("Merge JSONs",                                 "_merge_analysis.py"),
]
if not NO_DB:
    STEPS.append(("DB upsert (reels_pro_audio)", "_db_save_analysis.py"))
if not NO_HTML:
    STEPS.append(("Generate HTML page", "_gen_analysis_page.py"))


def run(script, label):
    print(f"\n{'='*60}\n[{label}]  python {script} {SHORTCODE}\n{'='*60}")
    env = os.environ.copy()
    env["PYTHONIOENCODING"] = "utf-8"
    t0 = time.time()
    r = subprocess.run([PY, script, SHORTCODE], cwd=str(ROOT), env=env)
    dt = time.time() - t0
    if r.returncode != 0:
        # _emotion_finegrained.py는 끝에 print에서 cp949 에러 나도 파일은 저장됨 → 무시
        if script == "_emotion_finegrained.py" and (ROOT / f"emotion_fine_{SHORTCODE}.json").exists():
            print(f"  (print failed but JSON saved — continuing)  [{dt:.1f}s]")
            return
        sys.exit(f"[FAIL] {script} exit={r.returncode}")
    print(f"  [{dt:.1f}s]")


def main():
    t_total = time.time()
    print(f"\n>>> analyze_reel.py {SHORTCODE}  (db={'OFF' if NO_DB else 'ON'}, html={'OFF' if NO_HTML else 'ON'})")
    for label, script in STEPS:
        run(script, label)
    print(f"\n>>> DONE  total {time.time()-t_total:.1f}s")
    print(f"  data: analysis_{SHORTCODE}.json")
    if not NO_HTML:
        print(f"  page: analysis_{SHORTCODE}.html")
    if not NO_DB:
        print(f"  db:   reels_pro_audio[{SHORTCODE}].pro_audio")


if __name__ == "__main__":
    main()
