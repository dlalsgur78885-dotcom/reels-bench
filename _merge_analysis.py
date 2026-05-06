"""세 JSON(full reel + TTS + fine emotion)을 합쳐 단일 분석 데이터 생성."""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).parent
SHORTCODE = sys.argv[1] if len(sys.argv) > 1 else "DXf3g2VjZyT"

reel = json.loads((ROOT / f"gemini3_reel_{SHORTCODE}.json").read_text(encoding="utf-8"))
tts = json.loads((ROOT / f"tts_{SHORTCODE}.json").read_text(encoding="utf-8"))
fine = json.loads((ROOT / f"emotion_fine_{SHORTCODE}.json").read_text(encoding="utf-8"))

a = reel["analysis"]
a["emotion_timeline"] = fine["emotion_timeline"]  # fine-grained 덮어쓰기
a["audio_events"] = fine.get("audio_events", [])
a["tts_script"] = tts["tts_script"]

merged = {
    "shortcode": SHORTCODE,
    "model": reel["model"],
    "video_file": reel["video_file"],
    "elapsed_sec": reel["elapsed_sec"] + tts.get("usage", {}).get("totalTokenCount", 0) * 0,
    "usage": {
        "reel": reel["usage"],
        "tts": tts.get("usage", {}),
        "emotion_fine": fine["usage"],
    },
    "analysis": a,
}

out = ROOT / f"analysis_{SHORTCODE}.json"
out.write_text(json.dumps(merged, ensure_ascii=False, indent=2), encoding="utf-8")
print(f"saved: {out}")
print(f"  emotion segments: {len(a['emotion_timeline'])}")
print(f"  audio events: {len(a.get('audio_events', []))}")
print(f"  TTS segments: {len(a['tts_script'])}")
print(f"  cuts: {len(a['visual_cuts'])}")
print(f"  bgm: {len(a['bgm'])}")
print(f"  sfx: {len(a['sound_effects'])}")
