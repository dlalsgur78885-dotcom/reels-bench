"""API Key 인증 — X-API-Key 헤더 검증."""
import hashlib
import secrets
import os
import time
import requests
from fastapi import Request, HTTPException, Depends
from . import supabase

# supabase 서비스의 session 재사용 (connection pool 공유)
_S = supabase.get_session()
_USER_PROFILE_CACHE_TTL = 60
_user_profile_cache: dict[str, tuple[float, dict]] = {}


def _hash_key(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


def generate_key() -> tuple[str, str, str]:
    """새 키 발급 — (raw, prefix, hash). raw는 한 번만 노출."""
    raw = "rb_" + secrets.token_urlsafe(32)
    return raw, raw[:11], _hash_key(raw)


def issue(owner: str, rate_limit: int = 60) -> str | None:
    """API key 발급. raw 반환 (DB엔 hash만)."""
    raw, prefix, h = generate_key()
    row = {
        "key_hash": h,
        "key_prefix": prefix,
        "owner": owner,
        "rate_limit_per_min": rate_limit,
    }
    SUPA = os.getenv("SUPABASE_URL")
    KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_ANON_KEY")
    r = _S.post(
        f"{SUPA}/rest/v1/api_keys",
        headers={
            "apikey": KEY, "Authorization": f"Bearer {KEY}",
            "Content-Type": "application/json",
            "Prefer": "return=minimal",
        },
        json=row, timeout=15,
    )
    if r.status_code in (200, 201):
        return raw
    return None


def verify_key(api_key: str | None) -> dict | None:
    """key 검증 + usage 카운트 증가. 유효하면 row 반환, 아니면 None.
    service_role 키로 직접 query (anon은 RLS 막힘)."""
    if not api_key:
        return None
    h = _hash_key(api_key)
    SUPA = (os.getenv("SUPABASE_URL") or "").strip()
    SK = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_ANON_KEY") or "").strip()
    if not SUPA or not SK:
        return None
    try:
        r = _S.get(
            f"{SUPA}/rest/v1/api_keys?key_hash=eq.{h}"
            f"&select=id,owner,rate_limit_per_min,enabled,usage_count&limit=1",
            headers={"apikey": SK, "Authorization": f"Bearer {SK}"},
            timeout=10,
        )
        rows = r.json() if r.status_code == 200 else []
    except Exception:
        rows = []
    if not rows:
        return None
    row = rows[0]
    if not row.get("enabled"):
        return None
    # 비동기로 usage 업데이트 (실패해도 인증은 통과)
    try:
        from datetime import datetime, timezone
        SUPA = os.getenv("SUPABASE_URL")
        KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_ANON_KEY")
        _S.patch(
            f"{SUPA}/rest/v1/api_keys?id=eq.{row['id']}",
            headers={
                "apikey": KEY, "Authorization": f"Bearer {KEY}",
                "Content-Type": "application/json",
                "Prefer": "return=minimal",
            },
            json={
                "last_used_at": datetime.now(timezone.utc).isoformat(),
                "usage_count": (row.get("usage_count") or 0) + 1,
            },
            timeout=3,
        )
    except Exception:
        pass
    return row


async def require_api_key(request: Request) -> dict:
    """FastAPI Dependency — endpoint에 적용 시 자동 인증."""
    api_key = request.headers.get("X-API-Key") or request.query_params.get("api_key")
    row = verify_key(api_key)
    if not row:
        raise HTTPException(
            status_code=401,
            detail="invalid or missing API key (header X-API-Key or ?api_key=)",
        )
    return row


# ── Supabase JWT 인증 ──

def verify_jwt(token: str | None) -> dict | None:
    """Supabase JWT 검증 — auth/v1/user 호출. 유효하면 {id, email, ...} 반환."""
    if not token:
        return None
    SUPA = (os.getenv("SUPABASE_URL") or "").strip()
    ANON = (os.getenv("SUPABASE_ANON_KEY") or "").strip()
    if not SUPA or not ANON:
        return None
    try:
        r = _S.get(
            f"{SUPA}/auth/v1/user",
            headers={"apikey": ANON, "Authorization": f"Bearer {token}"},
            timeout=10,
        )
        if r.status_code != 200:
            return None
        return r.json()
    except Exception:
        return None


def get_profile(user_id: str) -> dict | None:
    """profiles 테이블에서 role 등 메타 조회."""
    SUPA = (os.getenv("SUPABASE_URL") or "").strip()
    SK = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_ANON_KEY") or "").strip()
    if not SUPA or not SK or not user_id:
        return None
    try:
        r = _S.get(
            f"{SUPA}/rest/v1/profiles?id=eq.{user_id}&select=id,email,display_name,role,active,can_delete_reels,created_at,last_login_at&limit=1",
            headers={"apikey": SK, "Authorization": f"Bearer {SK}"},
            timeout=10,
        )
        rows = r.json() if r.status_code == 200 else []
        return rows[0] if rows else None
    except Exception:
        return None


def _decode_jwt_sub(token: str) -> str | None:
    """JWT payload의 sub (user_id) 만 로컬 디코드. 서명 검증은 안 함."""
    try:
        import base64, json
        parts = token.split(".")
        if len(parts) < 2:
            return None
        # base64url decode (padding 보정)
        payload_b64 = parts[1] + "=" * (-len(parts[1]) % 4)
        payload = json.loads(base64.urlsafe_b64decode(payload_b64).decode())
        return payload.get("sub")
    except Exception:
        return None


def require_user(request: Request) -> dict:
    """JWT 검증 + profile 반환을 병렬로. JWT 검증은 supabase에 위임."""
    from concurrent.futures import ThreadPoolExecutor
    auth = request.headers.get("Authorization", "")
    token = auth.split(" ", 1)[1] if auth.lower().startswith("bearer ") else None
    if not token:
        raise HTTPException(401, "missing JWT")
    user_id = _decode_jwt_sub(token)
    if not user_id:
        raise HTTPException(401, "invalid JWT format")
    cached = _user_profile_cache.get(token)
    if cached and time.time() - cached[0] < _USER_PROFILE_CACHE_TTL:
        profile = cached[1]
        if profile.get("active"):
            return profile

    with ThreadPoolExecutor(max_workers=2) as ex:
        f_verify = ex.submit(verify_jwt, token)
        f_profile = ex.submit(get_profile, user_id)
    user = f_verify.result()
    if not user:
        raise HTTPException(401, "invalid or expired JWT")
    profile = f_profile.result()
    if not profile or not profile.get("active"):
        raise HTTPException(403, "profile not found or inactive")
    _user_profile_cache[token] = (time.time(), profile)
    return profile


def require_admin(request: Request) -> dict:
    profile = require_user(request)
    if profile.get("role") != "admin":
        raise HTTPException(403, "admin only")
    return profile


def require_can_delete_reels(request: Request) -> dict:
    profile = require_user(request)
    if profile.get("role") != "admin" and not profile.get("can_delete_reels"):
        raise HTTPException(403, "릴스 삭제 권한 없음")
    return profile
