"""API key 발급 CLI.

사용:
  python issue_api_key.py "John Doe" --rate-limit 100
"""
import argparse
import sys
from pathlib import Path
from dotenv import load_dotenv

ROOT = Path(__file__).parent
load_dotenv(ROOT / ".env")
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "api"))

from api.services import auth  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("owner", help="키 소유자 이름/이메일")
    ap.add_argument("--rate-limit", type=int, default=60, help="분당 호출 제한")
    args = ap.parse_args()

    raw = auth.issue(args.owner, args.rate_limit)
    if not raw:
        sys.exit("발급 실패")

    print()
    print("=" * 60)
    print(f"  Owner: {args.owner}")
    print(f"  Rate limit: {args.rate_limit}/min")
    print(f"  Key (이번 한 번만 표시):")
    print(f"    {raw}")
    print("=" * 60)
    print()
    print("사용:")
    print(f'  curl -H "X-API-Key: {raw}" https://reels-bench.vercel.app/api/reels')
    print()
    print("이 키는 DB에 hash로만 저장되어 다시 조회 불가능. 잘 보관하세요.")


if __name__ == "__main__":
    main()
