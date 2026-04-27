"""OAuth Google PROPRIO do agente.

Conta vinculada: construindonovoeu@gmail.com (NUNCA o institutoideoficial@gmail.com do CRM).
Tokens armazenados em SQLite local do agent (volume agent_data), nao no CRM.

Setup necessario (uma vez):
1. Console Google Cloud logado em construindonovoeu@gmail.com
2. Criar projeto + habilitar Calendar API + Gmail API
3. Criar OAuth Client ID (Web application)
4. Authorized redirect URI: <publico>/agent-oauth/google/callback
5. .env: AGENT_GOOGLE_CLIENT_ID, AGENT_GOOGLE_CLIENT_SECRET, AGENT_OAUTH_REDIRECT_URI
6. User acessa /oauth/google/start, autoriza, token salvo
"""

from __future__ import annotations

import os
import secrets
import time
from typing import Any
from urllib.parse import urlencode

import httpx

from . import memory

PROVIDER = "google"
CLIENT_ID = os.environ.get("AGENT_GOOGLE_CLIENT_ID", "")
CLIENT_SECRET = os.environ.get("AGENT_GOOGLE_CLIENT_SECRET", "")
REDIRECT_URI = os.environ.get(
    "AGENT_OAUTH_REDIRECT_URI",
    "https://crm.institutoideoficial.com.br/agent-oauth/google/callback",
)
SCOPES = [
    "https://www.googleapis.com/auth/calendar",
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/userinfo.email",
    "openid",
]

AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo"

# Lifecycle do state CSRF: criamos uma chave -> guardamos em memoria volatil ate o callback.
_state_cache: dict[str, float] = {}
_STATE_TTL_SEC = 600


def is_configured() -> bool:
    return bool(CLIENT_ID and CLIENT_SECRET)


def authorization_url() -> tuple[str, str]:
    """Gera URL de autorizacao + state CSRF."""
    state = secrets.token_urlsafe(24)
    _state_cache[state] = time.time() + _STATE_TTL_SEC
    _gc_states()
    params = {
        "client_id": CLIENT_ID,
        "redirect_uri": REDIRECT_URI,
        "response_type": "code",
        "scope": " ".join(SCOPES),
        "access_type": "offline",
        "prompt": "consent",
        "state": state,
    }
    return f"{AUTH_URL}?{urlencode(params)}", state


def consume_state(state: str) -> bool:
    exp = _state_cache.pop(state, None)
    if exp is None:
        return False
    return exp >= time.time()


def _gc_states() -> None:
    now = time.time()
    for k, v in list(_state_cache.items()):
        if v < now:
            _state_cache.pop(k, None)


async def exchange_code(code: str) -> dict[str, Any]:
    """Troca authorization code por access+refresh tokens. Salva no SQLite."""
    if not is_configured():
        raise RuntimeError("OAuth Google nao configurado (AGENT_GOOGLE_CLIENT_ID/SECRET ausentes)")
    async with httpx.AsyncClient(timeout=20) as c:
        r = await c.post(
            TOKEN_URL,
            data={
                "code": code,
                "client_id": CLIENT_ID,
                "client_secret": CLIENT_SECRET,
                "redirect_uri": REDIRECT_URI,
                "grant_type": "authorization_code",
            },
        )
        r.raise_for_status()
        tok = r.json()
    account = await _fetch_email(tok["access_token"])
    expires_at = int((time.time() + int(tok.get("expires_in", 3600))) * 1000)
    memory.oauth_save(
        provider=PROVIDER,
        account=account,
        access_token=tok["access_token"],
        refresh_token=tok.get("refresh_token"),
        token_type=tok.get("token_type"),
        scope=tok.get("scope"),
        expires_at_ms=expires_at,
    )
    return {"account": account, "scopes": tok.get("scope"), "has_refresh": bool(tok.get("refresh_token"))}


async def _fetch_email(access_token: str) -> str | None:
    async with httpx.AsyncClient(timeout=10) as c:
        try:
            r = await c.get(USERINFO_URL, headers={"Authorization": f"Bearer {access_token}"})
            if r.status_code == 200:
                return r.json().get("email")
        except Exception:
            return None
    return None


async def get_access_token() -> str:
    """Retorna access_token valido (refresh automatico se expirado)."""
    rec = memory.oauth_get(PROVIDER)
    if not rec:
        raise RuntimeError("Nenhum token Google salvo. Acesse /oauth/google/start pra autorizar.")
    now_ms = int(time.time() * 1000)
    # Margem de 60s pra evitar expirar no meio da request.
    if rec["expires_at"] - 60_000 > now_ms:
        return rec["access_token"]
    if not rec.get("refresh_token"):
        raise RuntimeError("Token expirado e sem refresh_token. Re-autorize em /oauth/google/start.")
    if not is_configured():
        raise RuntimeError("OAuth Google nao configurado pra fazer refresh.")
    async with httpx.AsyncClient(timeout=20) as c:
        r = await c.post(
            TOKEN_URL,
            data={
                "client_id": CLIENT_ID,
                "client_secret": CLIENT_SECRET,
                "refresh_token": rec["refresh_token"],
                "grant_type": "refresh_token",
            },
        )
        r.raise_for_status()
        tok = r.json()
    new_expires_at = int((time.time() + int(tok.get("expires_in", 3600))) * 1000)
    memory.oauth_save(
        provider=PROVIDER,
        account=rec.get("account"),
        access_token=tok["access_token"],
        refresh_token=tok.get("refresh_token") or rec.get("refresh_token"),
        token_type=tok.get("token_type") or rec.get("token_type"),
        scope=tok.get("scope") or rec.get("scope"),
        expires_at_ms=new_expires_at,
    )
    return tok["access_token"]


def status() -> dict[str, Any]:
    rec = memory.oauth_get(PROVIDER)
    return {
        "configured": is_configured(),
        "redirect_uri": REDIRECT_URI,
        "connected": bool(rec),
        "account": rec.get("account") if rec else None,
        "expires_at": rec.get("expires_at") if rec else None,
        "scope": rec.get("scope") if rec else None,
        "has_refresh": bool(rec and rec.get("refresh_token")),
    }
