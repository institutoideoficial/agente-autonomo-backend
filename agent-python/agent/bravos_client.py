"""HTTP client direto pro Bravos dedicado do agente (bravos-agent).

A diferenca pro crm_client e que aqui o agent fala DIRETO com seu proprio
Bravos (numero do agente — separado do Bravos da Vanessa). O CRM nao
precisa estar no caminho de ida nem de volta.
"""

from __future__ import annotations

import os
from typing import Any

import httpx

BRAVOS_URL = os.environ.get("BRAVOS_URL", "http://bravos-agent:3001").rstrip("/")
BRAVOS_TOKEN = os.environ.get("BRAVOS_TOKEN", "")
TIMEOUT = httpx.Timeout(20.0, connect=5.0)


def _auth_headers() -> dict[str, str]:
    h = {"Content-Type": "application/json"}
    if BRAVOS_TOKEN:
        h["Authorization"] = f"Bearer {BRAVOS_TOKEN}"
    return h


def _to_chat_id(phone_or_chat: str) -> str:
    s = str(phone_or_chat or "").strip()
    if "@c.us" in s or "@lid" in s or "@g.us" in s:
        return s
    digits = "".join(ch for ch in s if ch.isdigit())
    return f"{digits}@c.us" if digits else s


async def send_message(phone: str, message: str) -> dict[str, Any]:
    chat_id = _to_chat_id(phone)
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        resp = await client.post(
            f"{BRAVOS_URL}/send-message",
            headers=_auth_headers(),
            json={"chatId": chat_id, "message": message},
        )
        try:
            data = resp.json()
        except Exception:
            data = {"raw": resp.text}
        data["_status"] = resp.status_code
        return data


async def get_history(phone: str, limit: int = 30) -> dict[str, Any]:
    chat_id = _to_chat_id(phone)
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        resp = await client.get(
            f"{BRAVOS_URL}/history",
            params={"chatId": chat_id, "limit": limit},
            headers={k: v for k, v in _auth_headers().items() if k != "Content-Type"},
        )
        try:
            data = resp.json()
        except Exception:
            data = {"raw": resp.text}
        data["_status"] = resp.status_code
        return data


async def status() -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        resp = await client.get(
            f"{BRAVOS_URL}/status",
            headers={k: v for k, v in _auth_headers().items() if k != "Content-Type"},
        )
        try:
            data = resp.json()
        except Exception:
            data = {"raw": resp.text}
        data["_status"] = resp.status_code
        return data
