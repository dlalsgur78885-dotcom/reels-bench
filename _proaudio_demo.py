"""분석된 reel 하나에 Pro 오디오 분석을 추가 적용 → emotion_timeline 결과 확인."""
import sys
import json
from pathlib import Path
from dotenv import load_dotenv

ROOT = Path(__file__).parent
load_dotenv(ROOT / ".env")
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "api"))

from api.services import pipeline  # noqa: E402

TARGET = "DWdUBBvki6W"

print(f"Pro audio 분석 시작: {TARGET}")
pipeline.run(TARGET, skip_pro_audio=False)
status = pipeline.analysis_status.get(TARGET, {})
print(f"\nstatus: {status.get('status')}")
print(f"step: {status.get('step')}")

# extra_cache 결과 확인
extra = pipeline.extra_cache.get(TARGET) or {}
pro_audio = extra.get("pro_audio") or {}
audio_emotions = extra.get("audio_emotions") or {}

print(f"\n=== pro_audio 결과 ===")
print(f"sound_effects: {len(pro_audio.get('sound_effects', []))}")
print(f"bgm_segments: {len(pro_audio.get('bgm_segments', []))}")
print(f"emotion_timeline: {len(pro_audio.get('emotion_timeline', []))}")

print(f"\n=== emotion_timeline ===")
for e in pro_audio.get("emotion_timeline", []):
    print(f"  {e.get('start')} ~ {e.get('end')}  [{e.get('emotion'):10}] "
          f"intensity={e.get('intensity')} src={e.get('source')}")
    print(f"    근거: {e.get('reason')}")

print(f"\n=== legacy audio_emotions (초 단위, frontend 사용) ===")
for sec in sorted(audio_emotions.keys())[:10]:
    e = audio_emotions[sec]
    print(f"  {sec}s: {e.get('emotion')} ({e.get('label')}) conf={e.get('confidence')}")
print(f"  ... 총 {len(audio_emotions)}초")
