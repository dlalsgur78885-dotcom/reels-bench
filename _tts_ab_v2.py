"""A/B v2: 같은 4 voice (Yuna/Jennie/Jisoo/Hanna) + 감정 10% 부스트 → tts/20260506-1/.
- voice_settings.style: 0.0 → 0.1 (expressiveness +10%)
- voice_settings.stability: 0.5 → 0.45 (variation +10%)
- 그 외 흐름은 _tts_synth.py와 동일 (Gemini Flash로 tag 매핑 + atempo strict).
"""
import os
import sys
import json
import time
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed
import requests
from dotenv import load_dotenv

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).parent
load_dotenv(ROOT / ".env")
sys.path.insert(0, str(ROOT / "api"))
from services import elevenlabs as tts  # noqa: E402

SHORTCODE = "DXf3g2VjZyT"
OUT_DIR = ROOT / "tts" / "20260506-3"
OUT_DIR.mkdir(parents=True, exist_ok=True)

# v3와 동일한 voice_settings (변수 통제 — 태그 강도만 비교)
VOICE_SETTINGS_V2 = {
    "stability": 0.35,
    "similarity_boost": 0.75,
    "style": 0.3,
    "use_speaker_boost": True,
}

VOICES = [
    ("Yuna",   "xi3rF0t7dg7uN2M0WUhr"),
    ("Jennie", "z6Kj0hecH20CdetSElRT"),
    ("Jisoo",  "iWLjl1zCuqXRkW6494ve"),
    ("Hanna",  "zgDzx5jLLCqEp6Fl7Kl7"),
]


def map_directions_strong(directions):
    """v4: 더 강한 감정 단어 위주로 v3 audio tag 매핑."""
    import json as _json, requests as _r
    if not directions or not any(directions):
        return [""] * len(directions)
    prompt = (
        "아래 한국어 발화 지시(direction)들을 ElevenLabs v3 audio tag로 변환해.\n"
        "**중요**: 약한 단어 대신 강도 높은 단어를 우선 선택. 2~3개 조합으로 인텐시티 누적.\n\n"
        "강도 높은 tag 예시:\n"
        "- 감정 강 ▶ [ecstatic][overjoyed][devastated][furious][shouting][weeping][cackling][gasping]\n"
        "- 감정 중 ▶ [excited][happy][sad][angry][whispers][surprised]\n"
        "- 톤 강 ▶ [commanding][passionate][intense][thunderous][trembling]\n"
        "- 톤 중 ▶ [emphatic][confident][serious][calm][curious]\n"
        "- 강조어 prefix ▶ [strongly][intensely][barely]\n"
        "- 액션 ▶ [exhales sharply][pants][groans][clears throat]\n\n"
        "각 direction에 강한 단어 위주로 2~3개 tag 조합. JSON 배열만 (입력과 동일 길이).\n\n"
        f"입력: {_json.dumps(directions, ensure_ascii=False)}\n\n"
        '예: ["[commanding][emphatic]", "[ecstatic][shouting][passionate]", "[trembling][whispers]"]'
    )
    r = _r.post(
        f"https://generativelanguage.googleapis.com/v1beta/models/{tts.GEMINI_MODEL}:generateContent?key={os.getenv('GEMINI_API_KEY')}",
        json={
            "contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": {"responseMimeType": "application/json", "maxOutputTokens": 4096},
        },
        timeout=120,
    )
    if r.status_code != 200:
        raise RuntimeError(f"Gemini error {r.status_code}: {r.text[:400]}")
    text = r.json()["candidates"][0]["content"]["parts"][0]["text"]
    tags = _json.loads(text)
    if len(tags) < len(directions):
        tags = list(tags) + [""] * (len(directions) - len(tags))
    elif len(tags) > len(directions):
        tags = list(tags)[:len(directions)]
    return tags


def synth_segment_v2(text, tag, voice_id, out_path):
    tagged = f"{tag} {text}".strip()
    r = requests.post(
        f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}",
        headers={"xi-api-key": os.getenv("ELEVENLABS_API_KEY"), "Content-Type": "application/json"},
        json={"text": tagged, "model_id": "eleven_v3", "voice_settings": VOICE_SETTINGS_V2},
        timeout=180,
    )
    if r.status_code != 200:
        raise RuntimeError(f"ElevenLabs error {r.status_code}: {r.text[:300]}")
    out_path.write_bytes(r.content)


def synth_one_voice(name, voice_id, sentences, tags):
    tmpdir = OUT_DIR / f"_tmp_{name}"
    tmpdir.mkdir(exist_ok=True)
    segments = []
    for i, s in enumerate(sentences):
        out = tmpdir / f"{i:03d}.mp3"
        synth_segment_v2(s["text"], tags[i], voice_id, out)
        segments.append({"path": out, "start": float(s["start"]), "end": float(s["end"])})
    final = OUT_DIR / f"{name}.mp3"
    total, tempos = tts.merge_segments(segments, final)
    # cleanup tmp
    for p in tmpdir.glob("*"):
        try: p.unlink()
        except OSError: pass
    try: tmpdir.rmdir()
    except OSError: pass
    return name, total, tempos


def main():
    src = ROOT / "tts" / f"tts_{SHORTCODE}.json"
    data = json.loads(src.read_text(encoding="utf-8"))
    sentences = data["tts_script"]
    print(f"shortcode={SHORTCODE} | sentences={len(sentences)} | voices={len(VOICES)}")
    print(f"voice_settings: style={VOICE_SETTINGS_V2['style']}, stability={VOICE_SETTINGS_V2['stability']}\n")

    print("[1/2] direction → audio tags (Gemini Flash, v4: 강한 단어 우선)")
    directions = [s.get("direction", "") for s in sentences]
    tags = map_directions_strong(directions)
    for d, t in zip(directions, tags):
        print(f"  {d}  →  {t}")

    print(f"\n[2/2] 합성 (4 voice 병렬)")
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=4) as ex:
        futures = {ex.submit(synth_one_voice, n, v, sentences, tags): n for n, v in VOICES}
        for f in as_completed(futures):
            try:
                name, dur, tempos = f.result()
                print(f"  ✓ {name}.mp3 — {dur:.2f}s, tempos={[round(t,2) for t in tempos]}")
            except Exception as e:
                print(f"  ✗ {futures[f]} — {e}")
    elapsed = time.time() - t0
    total_chars = sum(len(f"{tags[i]} {s['text']}".strip()) for i, s in enumerate(sentences)) * len(VOICES)
    print(f"\n✓ 완료 ({elapsed:.1f}s) → {OUT_DIR}")
    print(f"  ElevenLabs chars used: ~{total_chars}")


if __name__ == "__main__":
    main()
