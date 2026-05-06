"""릴스 1개 통합+병렬 분석 파이프라인 (표준).

usage: python analyze_reel.py <shortcode> [--no-db] [--no-html]

구조:
  - _audio_oneshot.py (Whisper + Gemini Pro: TTS direction + emotion + audio_events 통합 단일 호출)
    ∥ _full_analysis_oneshot.py (Gemini Pro 비디오: BGM/SFX/cuts/hook/sync/viral)
  - merge → DB upsert → HTML 생성

성능 (DXbvfmpiY2k 43.6s 릴스 실측):
  - 약 52s / 릴스 1개 (이전 직렬 125s 대비 -58%)
  - 약 $0.12 / 릴스 1개 (이전 $0.16 대비 -26%)

이전 직렬 버전은 analyze_reel_legacy.py로 보존.
"""
import os
import sys
import time
import subprocess
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed

ROOT = Path(__file__).parent
PY = sys.executable

if len(sys.argv) < 2:
    sys.exit("usage: python analyze_reel_fast.py <shortcode> [--no-db] [--no-html]")

SHORTCODE = sys.argv[1]
NO_DB = "--no-db" in sys.argv
NO_HTML = "--no-html" in sys.argv


def run(script, label):
    env = os.environ.copy()
    env["PYTHONIOENCODING"] = "utf-8"
    print(f"\n[{label}]  python {script} {SHORTCODE}  (start)")
    t0 = time.time()
    r = subprocess.run([PY, script, SHORTCODE], cwd=str(ROOT), env=env,
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    dt = time.time() - t0
    if r.returncode != 0:
        # emotion print에서 cp949 에러 나도 파일은 저장될 수 있음 → 호환 처리
        emo_path = ROOT / f"emotion_fine_{SHORTCODE}.json"
        if script == "_audio_oneshot.py" and emo_path.exists():
            print(f"[{label}] {dt:.1f}s (print failed, JSON saved)")
            print(r.stdout[-2000:])
            return
        print(r.stdout[-2000:])
        print("STDERR:", r.stderr[-2000:])
        sys.exit(f"[FAIL] {script} exit={r.returncode}")
    print(f"[{label}] {dt:.1f}s")
    print(r.stdout[-2000:])


def main():
    t_total = time.time()
    print(f"\n>>> analyze_reel_fast.py {SHORTCODE}  (db={'OFF' if NO_DB else 'ON'}, html={'OFF' if NO_HTML else 'ON'})")

    # 병렬: audio (TTS+emotion+events 통합) ∥ video ∥ comments
    print("\n=== Stage 1: Audio + Video + Comments 병렬 실행 ===")
    t_par = time.time()
    with ThreadPoolExecutor(max_workers=3) as ex:
        futs = {
            ex.submit(run, "_audio_oneshot.py", "Audio (TTS+emotion+events)"): "audio",
            ex.submit(run, "_full_analysis_oneshot.py", "Video (BGM/SFX/cuts/hook)"): "video",
            ex.submit(run, "_fetch_comments.py", "Comments (Playwright)"): "comments",
        }
        for f in as_completed(futs):
            try:
                f.result()  # 예외 전파
            except SystemExit:
                # comments 실패는 치명적이지 않음 — 다른 단계는 계속
                if futs[f] != "comments":
                    raise
    print(f"\n[병렬 단계 종료]  {time.time()-t_par:.1f}s")

    # 순차: merge → db → html
    print("\n=== Stage 2: Merge / DB / HTML ===")
    run("_merge_analysis.py", "Merge JSONs")
    if not NO_DB:
        run("_db_save_analysis.py", "DB upsert")
    if not NO_HTML:
        run("_gen_analysis_page.py", "Generate HTML")

    print(f"\n>>> DONE  total {time.time()-t_total:.1f}s")
    print(f"  data: analysis_{SHORTCODE}.json")
    if not NO_HTML:
        print(f"  page: analysis_{SHORTCODE}.html")


if __name__ == "__main__":
    main()
