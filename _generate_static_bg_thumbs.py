"""BG preset 11 thumbnail PNG → web/public/mockup-bg-thumbs/ 사전 생성.

Color expanded panel의 Gradient·Mesh 6 카드 중 일부가 Render API
cold start로 빈 회색 표시됨. static 화 → 0ms.
"""
from __future__ import annotations
import sys
from pathlib import Path

ROOT = Path(__file__).parent
sys.path.insert(0, str(ROOT))
from api.services import mockup as svc

OUT_DIR = ROOT / "web" / "public" / "mockup-bg-thumbs"
OUT_DIR.mkdir(parents=True, exist_ok=True)


def main() -> int:
    for pid in svc.BG_PRESETS.keys():
        png = svc.render_bg_preset_thumbnail(pid)
        out = OUT_DIR / f"{pid}.png"
        out.write_bytes(png)
        print(f"  saved {pid}.png ({out.stat().st_size:,}B)")
    print(f"\n총 {len(list(OUT_DIR.glob('*.png')))}개")
    return 0


if __name__ == "__main__":
    sys.exit(main())
