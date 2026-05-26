"""카탈로그 7 endpoint → web/public/mockup-catalog/*.json 사전 생성.

Render mockup-worker cold start 1초+ × 7 호출 → 페이지 idle 4-5초 지연.
정적 JSON 으로 Vercel 직접 서빙 → 0ms.
"""
from __future__ import annotations
import json, sys
from pathlib import Path

ROOT = Path(__file__).parent
sys.path.insert(0, str(ROOT))
from api.services import mockup as svc

OUT_DIR = ROOT / "web" / "public" / "mockup-catalog"
OUT_DIR.mkdir(parents=True, exist_ok=True)


def save(name: str, data) -> None:
    out = OUT_DIR / f"{name}.json"
    out.write_text(json.dumps(data, ensure_ascii=False, indent=0), encoding="utf-8")
    print(f"  saved {name}.json ({out.stat().st_size:,}B)")


def main() -> int:
    # DEVICES — server에서는 spec 전체. 우리는 id/name만 필요한지 보고 결정.
    # mockup_web.py 의 /api/mockup/devices 응답 형태 보면 ...
    # spec.json: dict[str, dict] with body_w/body_h/screen_w/screen_h/label/etc
    devices_list = []
    for did, spec in svc.DEVICES.items():
        devices_list.append({
            "id": did,
            "name": spec.get("name") or spec.get("label") or did,
            "label": spec.get("label", did),
            "body_w": spec.get("body_w"),
            "body_h": spec.get("body_h"),
            "screen_w": spec.get("screen_w"),
            "screen_h": spec.get("screen_h"),
            "has_notch": spec.get("has_notch"),
            "notch_type": spec.get("notch_type"),
            "label_short": spec.get("label_short"),
        })
    save("devices", {"devices": devices_list})

    save("device-styles", {"styles": [
        {"id": sid, "label": spec["label"]}
        for sid, spec in svc.DEVICE_STYLES.items()
    ]})

    save("device-shadows", {"shadows": [
        {"id": sid, "label": spec["label"]}
        for sid, spec in svc.DEVICE_SHADOWS.items()
    ]})

    save("scene-shapes", {"shapes": [
        {"id": sid, "label": spec["label"]}
        for sid, spec in svc.SCENE_SHAPES.items()
    ]})

    save("backgrounds", {"backgrounds": [
        {"id": pid, "label": spec["label"]}
        for pid, spec in svc.BG_PRESETS.items()
    ]})

    save("effects", {"effects": [
        {"id": eid, "label": spec["label"]}
        for eid, spec in svc.OVERLAY_EFFECTS.items()
    ]})

    # TEMPLATES — 그 자체로 list
    save("templates", {"templates": list(svc.TEMPLATES)})

    total = len(list(OUT_DIR.glob("*.json")))
    print(f"\n총 {total} 카탈로그 JSON")
    return 0


if __name__ == "__main__":
    sys.exit(main())
