"""디바이스 8종 default frame PNG 사전 생성.

메인 preview의 첫 진입(기본 style/shadow/radius) 시 Render 호출 ~1.7s 지연.
default PNG 만 static 화해서 첫 로딩 즉시 표시.
"""
from __future__ import annotations
import sys
from pathlib import Path

ROOT = Path(__file__).parent
sys.path.insert(0, str(ROOT))
from api.services import mockup as svc

OUT_DIR = ROOT / "web" / "public" / "mockup-devices"
OUT_DIR.mkdir(parents=True, exist_ok=True)


def main() -> int:
    for did in svc.DEVICES.keys():
        png = svc.render_device_frame(did)  # default style/radius
        out = OUT_DIR / f"{did}.png"
        out.write_bytes(png)
        print(f"  saved {did}.png ({out.stat().st_size:,}B)")
    total = len(list(OUT_DIR.glob("*.png")))
    print(f"\n총 {total}개")
    return 0


if __name__ == "__main__":
    sys.exit(main())
