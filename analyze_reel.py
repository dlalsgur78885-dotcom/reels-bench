"""릴스 1개 통합+병렬 분석 파이프라인 (표준).

usage: python analyze_reel.py <shortcode> [--no-db] [--no-html] [--no-intent]

구조:
  - _audio_oneshot.py (Whisper + Gemini Pro: TTS direction + emotion + audio_events 통합 단일 호출)
    ∥ _full_analysis_oneshot.py (Gemini Pro 비디오: BGM/SFX/cuts/hook/sync/viral)
  - merge → DB upsert → HTML 생성
  - _script_intent_analysis.py (Gemini Pro: script_structure + 문장 섹션 + USP layout + section chunks)
    → reels_script_structure / reels_transcripts 갱신 (`--no-intent`로 끄기)

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
NO_INTENT = "--no-intent" in sys.argv


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


def ensure_video_file():
    """`_<sc>.mp4` 파일 보장 — 없으면 reels_metadata.video_url로 download,
    그것도 fail이면 pipeline._get_video_url로 fresh URL 재발급 후 retry.

    `_full_analysis_oneshot.py`가 video 파일을 사전 가정으로 두기 때문에 이
    단계가 없으면 인스타 URL 만료 시 무조건 "video missing"으로 fail함
    (pipeline.run 진입점에만 있던 retry 흐름을 analyze_reel.py에도 옮김).
    """
    video_path = ROOT / f"_{SHORTCODE}.mp4"
    if video_path.exists() and video_path.stat().st_size > 1024:
        print(f"[video] reuse {video_path.name} ({video_path.stat().st_size // 1024} KB)")
        return
    sys.path.insert(0, str(ROOT))
    from api.services import pipeline, supabase as _sb
    print(f"[video] download {SHORTCODE} → {video_path.name}")
    meta = _sb.sb_get("reels_metadata", f"shortcode=eq.{SHORTCODE}&limit=1")
    video_url = (meta[0] or {}).get("video_url") if meta else None
    last_err = None
    for attempt in range(2):
        # 1차: DB의 video_url로 시도. fail 시 2차에서 fresh URL.
        if attempt == 1 or not video_url:
            fresh = pipeline._get_video_url(SHORTCODE)
            if not fresh:
                last_err = "no fresh URL"
                break
            video_url = fresh
            # DB도 갱신해서 다음 호출 시 첫 시도가 통과.
            try:
                _sb.sb_post("reels_metadata", {"shortcode": SHORTCODE, "video_url": video_url})
            except Exception as e:
                print(f"[video] DB update warn: {e}")
        try:
            pipeline._download_video(video_url, str(video_path))
            if video_path.exists() and video_path.stat().st_size > 1024:
                print(f"[video] saved {video_path.stat().st_size // 1024} KB on attempt {attempt + 1}")
                return
            last_err = f"empty file on attempt {attempt + 1}"
        except Exception as e:
            last_err = str(e)
            print(f"[video] attempt {attempt + 1} fail: {e}")
    sys.exit(f"[FAIL] video download — {last_err}")


def main():
    t_total = time.time()
    print(f"\n>>> analyze_reel_fast.py {SHORTCODE}  (db={'OFF' if NO_DB else 'ON'}, html={'OFF' if NO_HTML else 'ON'})")

    # Stage 0 — video file 보장. 인스타 URL 만료 시 fresh URL 재발급.
    ensure_video_file()

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

    # Stage 3: script_structure + USP layout + section chunks
    # (DB save 필수 — reels_transcripts/reels_script_structure를 갱신)
    if not NO_DB and not NO_INTENT:
        print("\n=== Stage 3: Script structure / USP layout / Section chunks ===")
        run("_script_intent_analysis.py", "Script intent")

    print(f"\n>>> DONE  total {time.time()-t_total:.1f}s")
    print(f"  data: analysis_{SHORTCODE}.json")
    if not NO_HTML:
        print(f"  page: analysis_{SHORTCODE}.html")


if __name__ == "__main__":
    main()
