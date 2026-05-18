"""Figma OAuth 연동 + 디자인 import.

각 유저는 본인 Figma 계정으로 OAuth 인증 → access_token 우리 DB에 저장 →
디자인 트리·이미지를 그 토큰으로 가져온다.

저장 위치: profiles 테이블 컬럼
  - figma_access_token, figma_refresh_token, figma_token_exp
  - figma_user_id, figma_handle (표시용)

OAuth 앱 설정: Figma → Account Settings → My OAuth apps → New app
  callback URL = {BASE}/api/figma/oauth/callback
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import os
import re
import secrets as _secrets
import time
from typing import Optional
from urllib.parse import urlencode

import requests

from . import secrets as secrets_svc
from . import supabase as supa_svc

logger = logging.getLogger(__name__)


# ── OAuth 설정 ────────────────────────────────────────────────────────────

AUTHORIZE_URL = "https://www.figma.com/oauth"
TOKEN_URL     = "https://api.figma.com/v1/oauth/token"
REFRESH_URL   = "https://api.figma.com/v1/oauth/refresh"
SCOPES        = "files:read"


def _client_id() -> str:
    return secrets_svc.get_secret("FIGMA_CLIENT_ID", "")


def _client_secret() -> str:
    return secrets_svc.get_secret("FIGMA_CLIENT_SECRET", "")


def _redirect_uri() -> str:
    """OAuth callback URL. env로 override 가능 (로컬 dev용)."""
    return (secrets_svc.get_secret("FIGMA_REDIRECT_URI", "")
            or "https://reels-bench.vercel.app/api/figma/oauth/callback")


def _state_secret() -> str:
    """state HMAC 서명용. JWT secret 재사용."""
    return (secrets_svc.get_secret("OAUTH_STATE_SECRET", "")
            or os.getenv("SUPABASE_JWT_SECRET", "")
            or "fallback-not-secure-please-set")


def is_configured() -> bool:
    return bool(_client_id()) and bool(_client_secret())


# ── State 서명 (CSRF 방지 + user_id 운반) ────────────────────────────────

def sign_state(user_id: str, redirect_to: str = "/figma-mockup") -> str:
    payload = {"u": user_id, "r": redirect_to, "n": _secrets.token_urlsafe(8),
               "t": int(time.time())}
    body = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip("=")
    sig = hmac.new(_state_secret().encode(), body.encode(), hashlib.sha256).hexdigest()[:16]
    return f"{body}.{sig}"


def verify_state(state: str, max_age_sec: int = 600) -> Optional[dict]:
    try:
        body, sig = state.rsplit(".", 1)
    except ValueError:
        return None
    expect = hmac.new(_state_secret().encode(), body.encode(), hashlib.sha256).hexdigest()[:16]
    if not hmac.compare_digest(sig, expect):
        return None
    try:
        pad = "=" * (-len(body) % 4)
        payload = json.loads(base64.urlsafe_b64decode(body + pad).decode())
    except Exception:
        return None
    if time.time() - payload.get("t", 0) > max_age_sec:
        return None
    return payload


# ── OAuth flow ────────────────────────────────────────────────────────────

def authorize_url(user_id: str, redirect_to: str = "/figma-mockup") -> str:
    state = sign_state(user_id, redirect_to)
    params = {
        "client_id": _client_id(),
        "redirect_uri": _redirect_uri(),
        "scope": SCOPES,
        "state": state,
        "response_type": "code",
    }
    return f"{AUTHORIZE_URL}?{urlencode(params)}"


def exchange_code(code: str) -> dict:
    """authorization code → access_token + refresh_token 교환."""
    r = requests.post(
        TOKEN_URL,
        data={
            "client_id": _client_id(),
            "client_secret": _client_secret(),
            "redirect_uri": _redirect_uri(),
            "code": code,
            "grant_type": "authorization_code",
        },
        timeout=15,
    )
    if r.status_code != 200:
        raise RuntimeError(f"Figma token exchange {r.status_code}: {r.text[:200]}")
    return r.json()


def refresh_access_token(refresh_token: str) -> dict:
    r = requests.post(
        REFRESH_URL,
        data={
            "client_id": _client_id(),
            "client_secret": _client_secret(),
            "refresh_token": refresh_token,
        },
        timeout=15,
    )
    if r.status_code != 200:
        raise RuntimeError(f"Figma refresh {r.status_code}: {r.text[:200]}")
    return r.json()


# ── Profile DB I/O ────────────────────────────────────────────────────────

def _profile_patch(user_id: str, payload: dict) -> None:
    SUPA = (os.getenv("SUPABASE_URL") or "").strip()
    SK = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    r = requests.patch(
        f"{SUPA}/rest/v1/profiles?id=eq.{user_id}",
        headers={"apikey": SK, "Authorization": f"Bearer {SK}",
                 "Content-Type": "application/json", "Prefer": "return=minimal"},
        json=payload, timeout=10,
    )
    if r.status_code not in (200, 204):
        raise RuntimeError(f"profile patch {r.status_code}: {r.text[:200]}")


def _profile_select(user_id: str, cols: str) -> Optional[dict]:
    SUPA = (os.getenv("SUPABASE_URL") or "").strip()
    SK = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    r = requests.get(
        f"{SUPA}/rest/v1/profiles?id=eq.{user_id}&select={cols}&limit=1",
        headers={"apikey": SK, "Authorization": f"Bearer {SK}"},
        timeout=10,
    )
    if r.status_code != 200:
        return None
    rows = r.json()
    return rows[0] if rows else None


def save_tokens(user_id: str, token_data: dict) -> None:
    """Figma token 응답을 DB에 저장.

    token_data 키:
      access_token, refresh_token, expires_in (초), user_id, handle (있을 때)
    """
    exp_ts = int(time.time() + int(token_data.get("expires_in", 0)))
    from datetime import datetime, timezone
    exp_iso = datetime.fromtimestamp(exp_ts, tz=timezone.utc).isoformat()
    payload = {
        "figma_access_token": token_data.get("access_token"),
        "figma_token_exp": exp_iso,
    }
    if token_data.get("refresh_token"):
        payload["figma_refresh_token"] = token_data["refresh_token"]
    if token_data.get("user_id"):
        payload["figma_user_id"] = str(token_data["user_id"])
    if token_data.get("handle"):
        payload["figma_handle"] = token_data["handle"]
    _profile_patch(user_id, payload)


def clear_tokens(user_id: str) -> None:
    _profile_patch(user_id, {
        "figma_access_token": None,
        "figma_refresh_token": None,
        "figma_token_exp": None,
        "figma_user_id": None,
        "figma_handle": None,
    })


def get_connection(user_id: str) -> Optional[dict]:
    """현재 유저의 Figma 연결 상태 + 토큰. 만료된 경우 refresh 시도."""
    row = _profile_select(
        user_id,
        "figma_access_token,figma_refresh_token,figma_token_exp,figma_user_id,figma_handle"
    )
    if not row or not row.get("figma_access_token"):
        return None
    # 만료 체크 (5분 여유)
    exp_iso = row.get("figma_token_exp")
    if exp_iso:
        from datetime import datetime
        try:
            exp_ts = datetime.fromisoformat(exp_iso.replace("Z", "+00:00")).timestamp()
        except Exception:
            exp_ts = 0
        if exp_ts and time.time() > exp_ts - 300:
            # refresh 시도
            rt = row.get("figma_refresh_token")
            if rt:
                try:
                    fresh = refresh_access_token(rt)
                    save_tokens(user_id, fresh)
                    row["figma_access_token"] = fresh.get("access_token")
                except Exception as e:
                    logger.warning("[figma] refresh failed for user %s: %s", user_id, e)
                    return None
    return {
        "connected": True,
        "access_token": row["figma_access_token"],
        "figma_user_id": row.get("figma_user_id"),
        "figma_handle": row.get("figma_handle"),
    }


# ── Figma API 호출 ────────────────────────────────────────────────────────

_FIGMA_URL_RE = re.compile(
    r"figma\.com/(?:file|design|proto)/([a-zA-Z0-9]+)(?:/[^?]*)?(?:\?[^#]*?(?:node-id=([\d%A-Za-z\-:]+)))?"
)


def parse_figma_url(url: str) -> dict:
    """Figma URL → {file_key, node_id (있을 때)}.

    URL 예시:
      https://www.figma.com/file/ABC123/My-Design?node-id=12-34
      https://www.figma.com/design/ABC123/My-Design?node-id=1%3A2
    """
    m = _FIGMA_URL_RE.search(url or "")
    if not m:
        return {"file_key": "", "node_id": ""}
    file_key = m.group(1)
    node_id_raw = m.group(2) or ""
    # node-id는 URL에서 `12-34` (대시) 또는 `12%3A34` (콜론 인코딩) 양식. API는 `12:34` 요구.
    node_id = node_id_raw.replace("%3A", ":").replace("-", ":") if node_id_raw else ""
    return {"file_key": file_key, "node_id": node_id}


def get_file(access_token: str, file_key: str, *, node_id: str = "",
             depth: int = 0) -> dict:
    """Figma file JSON 트리. node_id 주면 그 sub-tree만."""
    params: dict = {}
    if node_id:
        params["ids"] = node_id
    if depth:
        params["depth"] = depth
    r = requests.get(
        f"https://api.figma.com/v1/files/{file_key}",
        headers={"Authorization": f"Bearer {access_token}"},
        params=params, timeout=20,
    )
    if r.status_code != 200:
        raise RuntimeError(f"Figma file {r.status_code}: {r.text[:200]}")
    return r.json()


def render_node_image(access_token: str, file_key: str, node_id: str,
                      scale: float = 2.0) -> str:
    """Figma image API — node를 PNG로 렌더 → S3 URL (24시간 유효)."""
    r = requests.get(
        f"https://api.figma.com/v1/images/{file_key}",
        headers={"Authorization": f"Bearer {access_token}"},
        params={"ids": node_id, "format": "png", "scale": scale},
        timeout=30,
    )
    if r.status_code != 200:
        raise RuntimeError(f"Figma image {r.status_code}: {r.text[:200]}")
    data = r.json()
    images = data.get("images") or {}
    url = images.get(node_id)
    if not url:
        raise RuntimeError(f"Figma image: no URL returned (keys: {list(images.keys())})")
    return url


def get_user_info(access_token: str) -> dict:
    """현재 인증된 Figma 유저 정보 (id, handle, email, img_url)."""
    r = requests.get(
        "https://api.figma.com/v1/me",
        headers={"Authorization": f"Bearer {access_token}"},
        timeout=10,
    )
    if r.status_code != 200:
        return {}
    return r.json()


# ── 텍스트 노드 추출 ──────────────────────────────────────────────────────

def extract_text_nodes(file_json: dict, root_node_id: str = "") -> tuple[dict, list[dict]]:
    """file_json 트리에서 root_node (target frame)과 그 안의 TEXT 노드들 추출.

    Returns:
      (root_node, [text_node, ...])

      root_node = {id, name, w, h, x, y}
      text_node = {id, name, text, x, y, w, h, font_family, font_size,
                   font_weight, color, align}
    """
    # 트리 구조: nodes 객체에 node_id → {document: node} 매핑
    # OR document.children 재귀
    root = None
    target_id_norm = root_node_id.replace("-", ":") if root_node_id else ""

    # /v1/files/:key?ids=node_id → response.nodes[node_id].document
    if "nodes" in file_json and target_id_norm:
        node_wrap = file_json["nodes"].get(target_id_norm)
        if node_wrap:
            root = node_wrap.get("document")

    # /v1/files/:key 전체 응답 → document.children
    if not root and "document" in file_json:
        if target_id_norm:
            root = _find_node(file_json["document"], target_id_norm)
        else:
            # 첫 페이지의 첫 프레임
            doc = file_json["document"]
            for page in (doc.get("children") or []):
                for child in (page.get("children") or []):
                    if child.get("type") in ("FRAME", "COMPONENT", "INSTANCE"):
                        root = child
                        break
                if root:
                    break

    if not root:
        return {}, []

    root_box = root.get("absoluteBoundingBox") or {}
    root_meta = {
        "id": root.get("id"),
        "name": root.get("name"),
        "x": root_box.get("x", 0),
        "y": root_box.get("y", 0),
        "w": root_box.get("width", 0),
        "h": root_box.get("height", 0),
    }

    texts: list[dict] = []
    _walk_text(root, root_meta, texts)
    return root_meta, texts


def _find_node(node: dict, target_id: str) -> Optional[dict]:
    if node.get("id") == target_id:
        return node
    for c in (node.get("children") or []):
        found = _find_node(c, target_id)
        if found:
            return found
    return None


def _walk_text(node: dict, root_meta: dict, out: list[dict]) -> None:
    if node.get("type") == "TEXT":
        bb = node.get("absoluteBoundingBox") or {}
        style = node.get("style") or {}
        fills = node.get("fills") or []
        color = "#000000"
        for f in fills:
            if f.get("type") == "SOLID" and f.get("visible", True):
                rgb = f.get("color") or {}
                color = _rgb_to_hex(rgb.get("r", 0), rgb.get("g", 0), rgb.get("b", 0))
                break
        align_map = {"LEFT": "left", "CENTER": "center", "RIGHT": "right",
                     "JUSTIFIED": "justify"}
        out.append({
            "id": node.get("id"),
            "name": node.get("name", ""),
            "text": node.get("characters", ""),
            # root frame 기준 상대 좌표
            "x": bb.get("x", 0) - root_meta["x"],
            "y": bb.get("y", 0) - root_meta["y"],
            "w": bb.get("width", 0),
            "h": bb.get("height", 0),
            "font_family": style.get("fontFamily", "Inter"),
            "font_size": style.get("fontSize", 16),
            "font_weight": style.get("fontWeight", 400),
            "line_height_px": style.get("lineHeightPx"),
            "letter_spacing": style.get("letterSpacing", 0),
            "color": color,
            "align": align_map.get(style.get("textAlignHorizontal", "LEFT"), "left"),
        })
        return
    for c in (node.get("children") or []):
        # skip invisible
        if c.get("visible", True) is False:
            continue
        _walk_text(c, root_meta, out)


def _rgb_to_hex(r: float, g: float, b: float) -> str:
    return "#{:02x}{:02x}{:02x}".format(int(r * 255), int(g * 255), int(b * 255))
