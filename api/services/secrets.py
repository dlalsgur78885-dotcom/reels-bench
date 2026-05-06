"""Supabase Vault에 저장된 시크릿을 조회·관리.

런타임 캐시 (인스턴스 단위, TTL=300s) — 매 호출마다 DB hit 방지.
환경변수가 우선 (로컬 dev / 마이그레이션 전 fallback).
"""
from __future__ import annotations

import logging
import os
import time
from typing import Optional

import requests

logger = logging.getLogger(__name__)

# 인스턴스 메모리 캐시: name → (value, fetched_at)
_cache: dict[str, tuple[str, float]] = {}
_TTL_SEC = 300  # 5분


def _supa_url() -> str:
    return (os.getenv("SUPABASE_URL") or "").strip()


def _service_key() -> str:
    return (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip()


def _rpc(fn: str, payload: dict | None = None, timeout: int = 5):
    """service_role 권한으로 PostgREST RPC 호출."""
    url = f"{_supa_url()}/rest/v1/rpc/{fn}"
    sk = _service_key()
    if not _supa_url() or not sk:
        raise RuntimeError("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 누락")
    return requests.post(
        url,
        headers={
            "apikey": sk,
            "Authorization": f"Bearer {sk}",
            "Content-Type": "application/json",
        },
        json=payload or {},
        timeout=timeout,
    )


def get_secret(name: str, default: str = "") -> str:
    """캐시 우선 → Vault → 환경변수.

    Vault가 우선이라 admin이 UI에서 갱신한 값이 즉시 효과적.
    Vault에 없으면 env로 fallback (로컬 dev / 첫 마이그레이션 전).
    둘 다 없으면 default.
    """
    # 1. cache hit
    now = time.time()
    cached = _cache.get(name)
    if cached and now - cached[1] < _TTL_SEC:
        return cached[0]

    # 2. Vault (관리자가 UI로 갱신한 값이 우선)
    try:
        r = _rpc("get_secret", {"secret_name": name})
        if r.status_code == 200:
            val = r.json()  # 단일 텍스트 반환
            if isinstance(val, str) and val:
                _cache[name] = (val, now)
                return val
    except Exception as e:
        logger.warning("vault fetch failed for %s: %s", name, e)

    # 3. env var (Vault 미등록 시 fallback)
    env_val = (os.getenv(name) or "").strip()
    if env_val:
        _cache[name] = (env_val, now)
        return env_val

    # 4. miss → default (캐시 안 함)
    return default


def invalidate(name: Optional[str] = None) -> None:
    """관리자 갱신 시 호출. 인자가 None이면 전체 비움."""
    if name:
        _cache.pop(name, None)
    else:
        _cache.clear()


def list_secrets() -> list[dict]:
    """admin 전용 — 메타데이터만 반환 (값 X)."""
    r = _rpc("list_secret_names", {})
    if r.status_code != 200:
        raise RuntimeError(f"list_secret_names failed: {r.status_code} {r.text[:200]}")
    return r.json() or []


def upsert_secret(name: str, value: str, description: str = "") -> str:
    """admin 전용 — 시크릿 생성·갱신. 캐시 즉시 무효화."""
    r = _rpc("upsert_secret", {
        "secret_name": name,
        "secret_value": value,
        "secret_description": description,
    })
    if r.status_code != 200:
        raise RuntimeError(f"upsert_secret failed: {r.status_code} {r.text[:200]}")
    invalidate(name)
    return r.json()  # uuid


def delete_secret(name: str) -> bool:
    """admin 전용 — 삭제 + 캐시 무효화."""
    r = _rpc("delete_secret", {"secret_name": name})
    if r.status_code != 200:
        raise RuntimeError(f"delete_secret failed: {r.status_code} {r.text[:200]}")
    invalidate(name)
    return bool(r.json())
