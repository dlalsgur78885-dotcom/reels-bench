"""STYLE/SHADOW/BORDER 카드용 17개 PNG 미리보기를 로컬 PIL 로 생성.

Render API 호출 제거 — 결과 PNG 를 web/public/mockup-cards/ 에 저장.
Vercel 이 static 으로 서빙 → 카드 첫 진입부터 0ms 응답.
"""
from __future__ import annotations
import sys
from pathlib import Path

# api.services 패키지 직접 import
ROOT = Path(__file__).parent
sys.path.insert(0, str(ROOT))

from api.services import mockup as svc

OUT_DIR = ROOT / "web" / "public" / "mockup-cards"
OUT_DIR.mkdir(parents=True, exist_ok=True)

DEVICE = "iphone-16-pro"


def save(name: str, data: bytes):
    p = OUT_DIR / f"{name}.png"
    p.write_bytes(data)
    print(f"  saved {name}.png ({len(data):,}B)")


def main() -> int:
    # STYLE 9
    print("=== STYLE ===")
    for sid in svc.DEVICE_STYLES.keys():
        png = svc.render_frame_preview(
            DEVICE, style=sid, dummy_bg_id="none", crop_mode="corner"
        )
        save(f"style-{sid}", png)

    # SHADOW 5
    print("=== SHADOW ===")
    for sid in svc.DEVICE_SHADOWS.keys():
        if sid == "none":
            png = svc.render_frame_preview(
                DEVICE, dummy_bg_id="none", crop_mode="corner"
            )
        else:
            png = svc.render_frame_preview(
                DEVICE, shadow=sid, shadow_opacity=1.0,
                dummy_bg_id="none", crop_mode="corner"
            )
        save(f"shadow-{sid}", png)

    # BORDER 3
    print("=== BORDER ===")
    for r, label in [(0, "sharp"), (120, "curved"), (240, "round")]:
        png = svc.render_frame_preview(
            DEVICE, radius_override=r, dummy_bg_id="none", crop_mode="corner"
        )
        save(f"border-{label}", png)

    total = len(list(OUT_DIR.glob("*.png")))
    print(f"\n총 {total} 개 PNG → {OUT_DIR}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
