"""tts/tts_<sc>.json → ElevenLabs v3 합성 → tts/tts_<sc>_synth_<voice>.mp3 (CLI).
실제 합성 로직은 api/services/elevenlabs.py.

사용법:
  python _tts_synth.py <shortcode> [--name yuna|han_aim|jennie|male] [--voice <id>]
"""
import os
import sys
import json
import argparse
from pathlib import Path
from dotenv import load_dotenv

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).parent
load_dotenv(ROOT / ".env")
sys.path.insert(0, str(ROOT / "api"))

from services import elevenlabs as tts_svc  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("shortcode")
    ap.add_argument("--voice", help="ElevenLabs voice_id (직접 ID 지정, preset 무시)")
    ap.add_argument("--name", choices=list(tts_svc.PRESETS.keys()), default="yuna",
                    help=f"voice preset ({', '.join(tts_svc.PRESETS.keys())})")
    ap.add_argument("--model", default="eleven_v3")
    ap.add_argument("--out", help="출력 파일명 (기본: tts/tts_<sc>_synth_<name>.mp3)")
    args = ap.parse_args()

    sc = args.shortcode
    src = tts_svc.TTS_DIR / f"tts_{sc}.json"
    if not src.exists():
        sys.exit(f"파일 없음: {src}")
    data = json.loads(src.read_text(encoding="utf-8"))
    sentences = data.get("tts_script") or data.get("sentences") or []
    if not sentences:
        sys.exit("문장 데이터 없음")

    # 직접 voice_id 지정 시 임시 preset 등록
    voice_name = args.name
    if args.voice:
        tts_svc.PRESETS["_custom"] = {"id": args.voice, "label": "custom"}
        voice_name = "_custom"

    print(f"shortcode={sc} | sentences={len(sentences)} | voice={voice_name} | model={args.model}")

    result = tts_svc.synthesize_script(sentences, voice_name=voice_name, model_id=args.model)

    # job 폴더의 final.mp3를 사용자 친화적 이름으로 복사
    src_path = tts_svc.TTS_DIR / result["job_id"] / "final.mp3"
    if args.out:
        dst = Path(args.out)
    else:
        dst = tts_svc.TTS_DIR / f"tts_{sc}_synth_{args.name}.mp3"
    import shutil
    shutil.copy2(src_path, dst)

    print(f"\n✓ saved: {dst} ({dst.stat().st_size/1024:.1f} KB)")
    print(f"  job_id: {result['job_id']}")
    print(f"  duration: {result['total_duration']}s | chars: {result['char_count']} | segs: {result['segment_count']}")
    for s in result["sentences"]:
        print(f"  {s['direction']}  →  {s['tag']}")


if __name__ == "__main__":
    main()
