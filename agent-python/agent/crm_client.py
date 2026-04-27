"""HTTP client pra falar com o CRM Node (que orquestra Bravos / WhatsApp Cloud)."""

from __future__ import annotations

import os
from typing import Any

import httpx

CRM_URL = os.environ.get("CRM_URL", "http://crm:3000").rstrip("/")
TIMEOUT = httpx.Timeout(20.0, connect=5.0)


async def send_whatsapp(phone: str, message: str) -> dict[str, Any]:
    """POST /api/send-message no CRM. Ele decide entre Bravos e Cloud API."""
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        resp = await client.post(
            f"{CRM_URL}/api/send-message",
            json={"phone": phone, "message": message},
        )
        try:
            data = resp.json()
        except Exception:
            data = {"raw": resp.text}
        data["_status"] = resp.status_code
        return data


async def get_history(phone: str, limit: int = 30) -> dict[str, Any]:
    """GET /api/history. Bravos responde com array de mensagens."""
    digits = "".join(ch for ch in phone if ch.isdigit())
    chat_id = f"{digits}@c.us"
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        resp = await client.get(
            f"{CRM_URL}/api/history",
            params={"chatId": chat_id, "limit": limit},
        )
        try:
            data = resp.json()
        except Exception:
            data = {"raw": resp.text}
        data["_status"] = resp.status_code
        return data
