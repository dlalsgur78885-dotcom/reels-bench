"""Supabase DB helpers — module-level Session으로 connection pool 재사용."""

import os
import requests
from requests.adapters import HTTPAdapter
from dotenv import load_dotenv
from pathlib import Path

ENV_PATH = Path(__file__).parent.parent.parent / ".env"
load_dotenv(ENV_PATH)

SUPABASE_URL = (os.getenv("SUPABASE_URL") or "").strip()
SUPABASE_ANON_KEY = (os.getenv("SUPABASE_ANON_KEY") or "").strip()

SUPABASE_HEADERS = {
    "apikey": SUPABASE_ANON_KEY,
    "Authorization": f"Bearer {SUPABASE_ANON_KEY}",
    "Content-Type": "application/json",
}

# 워밍 시 TLS handshake를 한 번만 — pool 크기 넉넉히
_session = requests.Session()
_adapter = HTTPAdapter(pool_connections=20, pool_maxsize=40)
_session.mount("https://", _adapter)
_session.mount("http://", _adapter)


def get_session() -> requests.Session:
    """다른 서비스 모듈에서 같은 connection pool 공유."""
    return _session


def sb_get(table, params=""):
    r = _session.get(f"{SUPABASE_URL}/rest/v1/{table}?{params}", headers=SUPABASE_HEADERS, timeout=10)
    return r.json() if r.status_code == 200 else []


def sb_post(table, data):
    h = {**SUPABASE_HEADERS, "Prefer": "resolution=merge-duplicates"}
    r = _session.post(f"{SUPABASE_URL}/rest/v1/{table}", headers=h, json=data)
    return r.status_code in [200, 201]


def sb_patch(table, query, data):
    h = {**SUPABASE_HEADERS, "Prefer": "return=minimal"}
    r = _session.patch(f"{SUPABASE_URL}/rest/v1/{table}?{query}", headers=h, json=data, timeout=10)
    return r.status_code in [200, 204]


def sb_delete(table, query):
    h = {**SUPABASE_HEADERS, "Prefer": "return=minimal"}
    # Use service key if available to bypass RLS
    sk = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    if sk:
        h["apikey"] = sk
        h["Authorization"] = f"Bearer {sk}"
    r = _session.delete(f"{SUPABASE_URL}/rest/v1/{table}?{query}", headers=h, timeout=10)
    return r.status_code in [200, 204]


def storage_list(bucket, prefix="", limit=1000):
    h = {**SUPABASE_HEADERS}
    sk = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    if sk:
        h["apikey"] = sk
        h["Authorization"] = f"Bearer {sk}"
    payload = {
        "prefix": prefix,
        "limit": limit,
        "offset": 0,
        "sortBy": {"column": "name", "order": "asc"},
    }
    r = _session.post(
        f"{SUPABASE_URL}/storage/v1/object/list/{bucket}",
        headers=h,
        json=payload,
        timeout=10,
    )
    return r.json() if r.status_code == 200 else []


def storage_upload(bucket, path, file_bytes, content_type="application/octet-stream", upsert=True):
    """파일을 Supabase Storage에 업로드. (bucket, path) 위치에. Returns (ok, error_msg)."""
    sk = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip() or SUPABASE_ANON_KEY
    h = {
        "apikey": sk,
        "Authorization": f"Bearer {sk}",
        "Content-Type": content_type,
    }
    if upsert:
        h["x-upsert"] = "true"
    r = _session.post(
        f"{SUPABASE_URL}/storage/v1/object/{bucket}/{path}",
        headers=h, data=file_bytes, timeout=60,
    )
    if r.status_code in (200, 201):
        return True, None
    return False, f"{r.status_code}: {r.text[:200]}"


def storage_create_bucket(name, public=True):
    """버킷 생성 (이미 있으면 409 → OK 처리). idempotent."""
    sk = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip() or SUPABASE_ANON_KEY
    h = {
        "apikey": sk,
        "Authorization": f"Bearer {sk}",
        "Content-Type": "application/json",
    }
    r = _session.post(
        f"{SUPABASE_URL}/storage/v1/bucket",
        headers=h,
        json={"id": name, "name": name, "public": public},
        timeout=10,
    )
    return r.status_code in (200, 201, 409, 400)  # 400 = duplicate (Supabase 메시지 다름)


def storage_public_url(bucket, path):
    return f"{SUPABASE_URL}/storage/v1/object/public/{bucket}/{path}"
