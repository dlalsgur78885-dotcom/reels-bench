"""메인 preview frame 변형 17 PNG 사전 생성.

카드 클릭 시 메인 preview frame이 Render PIL 1-2초 걸려서 사용자가
'느림' 으로 인식. STYLE/SHADOW/BORDER 변형을 사전 생성 (iPhone 16 Pro).

URL 패턴 (Mockup.tsx line 1551):
  /api/mockup/frame/iphone-16-pro.png?style=X
  /api/mockup/frame/iphone-16-pro.png?shadow=X&shadow_opacity=1.00&shadow_angle=135
  /api/mockup/frame/iphone-16-pro.png?radius=X
"""
from __future__ import annotations
import sys
from pathlib import Path

ROOT = Path(__file__).parent
sys.path.insert(0, str(ROOT))
from api.services import mockup as svc

OUT_DIR = ROOT / "web" / "public" / "mockup-frames"
OUT_DIR.mkdir(parents=True, exist_ok=True)

DEVICE = "iphone-16-pro"


def save(name: str, data: bytes) -> None:
    out = OUT_DIR / f"{name}.png"
    out.write_bytes(data)
    print(f"  saved {name}.png ({len(data):,}B)")


def main() -> int:
    # STYLE 변형 9
    print("=== STYLE ===")
    for sid in svc.DEVICE_STYLES.keys():
        png = svc.render_device_frame(DEVICE, style=sid)
        save(f"{DEVICE}-style-{sid}", png)

    # SHADOW 변형 (shadow_opacity=1, shadow_angle=135 default)
    print("=== SHADOW ===")
    for sid in svc.DEVICE_SHADOWS.keys():
        if sid == "none":
            continue
        # render_device_frame + add_device_shadow
        frame = svc.render_device_frame(DEVICE)
        png = svc.add_device_shadow(frame, sid, opacity=1.0, angle_deg=180)
        save(f"{DEVICE}-shadow-{sid}", png)

    # RADIUS 변형
    print("=== RADIUS ===")
    for r in (0, 120, 240):
        png = svc.render_device_frame(DEVICE, radius_override=r)
        save(f"{DEVICE}-radius-{r}", png)

    total = len(list(OUT_DIR.glob("*.png")))
    print(f"\n총 {total}개")
    return 0


if __name__ == "__main__":
    sys.exit(main())
