"""YT 쇼츠 추가 분석: 프레임 + 스크립트 구조 + 카테고리.
이미 _<vid>.mp4 + tts_<vid>.json 있다고 가정.

usage: python analyze_yt_extras.py <video_id>
"""
import os
import sys
import json
import subprocess
import tempfile
from pathlib import Path
from datetime import datetime, timezone
import requests
from dotenv import load_dotenv
import imageio_ffmpeg

ROOT = Path(__file__).parent
load_dotenv(ROOT / ".env")
sys.path.insert(0, str(ROOT))

from api.services import gemini, frame_storage  # noqa: E402

SUPA = os.getenv("SUPABASE_URL")
KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
H = {
    "apikey": KEY,
    "Authorization": f"Bearer {KEY}",
    "Content-Type": "application/json",
    "Prefer": "resolution=merge-duplicates,return=minimal",
}
FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()

if len(sys.argv) < 2:
    sys.exit("usage: python analyze_yt_extras.py <video_id>")
VID = sys.argv[1]
VIDEO = ROOT / f"_{VID}.mp4"
if not VIDEO.exists():
    sys.exit(f"video file missing: {VIDEO}")


def upsert(table: str, payload: dict):
    r = requests.post(
        f"{SUPA}/rest/v1/{table}?on_conflict=shortcode",
        headers=H, json=payload, timeout=15,
    )
    if r.status_code not in (200, 201, 204):
        print(f"[{table}] {r.status_code} {r.text[:200]}")
    else:
        print(f"[{table}] OK")


def extract_frames(video_path: Path, out_dir: Path) -> list[Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [FFMPEG, "-i", str(video_path), "-vf", "fps=1", "-q:v", "2",
         str(out_dir / "frame_%04d.jpg"), "-y"],
        capture_output=True,
    )
    return sorted(out_dir.glob("frame_*.jpg"))


def main():
    print(f"=== analyze YT extras: {VID} ===")

    # 1. transcript: 로컬 tts file → analysis json → DB pro_audio.tts_script 순으로 시도
    transcript = ""
    tts_path = ROOT / f"tts_{VID}.json"
    if tts_path.exists():
        td = json.loads(tts_path.read_text(encoding="utf-8"))
        segs = td.get("whisper_segments") or td.get("tts_script") or []
        transcript = " ".join((s.get("text") or "").strip() for s in segs).strip()
    if not transcript:
        analysis_path = ROOT / f"analysis_{VID}.json"
        if analysis_path.exists():
            ad = json.loads(analysis_path.read_text(encoding="utf-8"))
            segs = (ad.get("analysis") or {}).get("tts_script") or []
            transcript = " ".join((s.get("text") or "").strip() for s in segs).strip()
    if not transcript:
        rr = requests.get(
            f"{SUPA}/rest/v1/youtube_shorts_pro_audio?shortcode=eq.{VID}&select=pro_audio",
            headers={"apikey": KEY, "Authorization": f"Bearer {KEY}"},
            timeout=10,
        )
        rows = rr.json() if rr.status_code == 200 else []
        if rows:
            segs = ((rows[0].get("pro_audio") or {}).get("tts_script")) or []
            transcript = " ".join((s.get("text") or "").strip() for s in segs).strip()
    print(f"[transcript] {len(transcript)} chars")
    if not transcript:
        print("[skip] transcript empty - script_structure skipped")

    # 2. 프레임 추출 + Storage 업로드
    print("\n[frames] extracting...")
    with tempfile.TemporaryDirectory() as tmp:
        frames_dir = Path(tmp) / "frames"
        frames = extract_frames(VIDEO, frames_dir)
        print(f"[frames] {len(frames)} frames extracted")

        # IG와 동일한 네이밍: 1.jpg, 2.jpg, ... (frame_storage.upload_dir 가 stem.isdigit() 요구)
        renamed_dir = Path(tmp) / "renamed"
        renamed_dir.mkdir()
        for idx, fp in enumerate(sorted(frames), start=1):
            (renamed_dir / f"{idx}.jpg").write_bytes(fp.read_bytes())

        ok = frame_storage.upload_dir(VID, renamed_dir)
        print(f"[frames] uploaded to Storage: {ok}/{len(frames)}")

        # 3. Gemini 프레임 분석 + OCR 병렬
        from concurrent.futures import ThreadPoolExecutor
        frame_str = [str(f) for f in frames]
        with ThreadPoolExecutor(max_workers=3) as ex:
            f_frames = ex.submit(gemini.analyze_frames, frame_str)
            f_ocr = ex.submit(gemini.ocr_subtitles, frame_str)
            f_ss = ex.submit(gemini.analyze_script_structure, transcript, "") if transcript else None
            f_cat = ex.submit(gemini.categorize, transcript, "", "")

            frame_analysis = f_frames.result()
            ocr = f_ocr.result()
            script_structure = f_ss.result() if f_ss else None
            category = f_cat.result()

    print(f"[frames] frame_analysis len={len(frame_analysis or '')}")
    print(f"[ocr] {len(ocr)} segments")
    print(f"[script] structure={'OK' if script_structure else 'NONE'}")
    print(f"[cat] {category}")

    # 4. DB 저장
    if script_structure:
        upsert("youtube_shorts_script_structure", {
            "shortcode": VID,
            "hook": script_structure.get("hook"),
            "intro": script_structure.get("intro"),
            "body": script_structure.get("body"),
            "cta": script_structure.get("cta"),
            "overall": script_structure.get("overall"),
        })
    if category:
        upsert("youtube_shorts_category", {
            "shortcode": VID,
            "topic": category.get("topic") or category.get("content_type_detail"),
            "topic_detail": category.get("topic_detail") or category.get("industry_detail"),
            "style": category.get("style"),
            "tags": category.get("tags") or [],
        })

    # 5. frame_analysis + ocr는 pro_audio JSONB에 추가 저장 (별도 테이블 안 만듦)
    # 기존 pro_audio 가져와서 병합
    rr = requests.get(
        f"{SUPA}/rest/v1/youtube_shorts_pro_audio?shortcode=eq.{VID}&select=pro_audio",
        headers={"apikey": KEY, "Authorization": f"Bearer {KEY}"},
        timeout=10,
    )
    existing = rr.json()
    base = (existing[0]["pro_audio"] if existing else None) or {}
    base["frame_analysis"] = frame_analysis
    base["frame_ocr"] = ocr
    upsert("youtube_shorts_pro_audio", {
        "shortcode": VID,
        "pro_audio": base,
    })

    print("\nDONE.")


if __name__ == "__main__":
    main()
