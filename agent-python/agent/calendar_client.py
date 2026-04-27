"""Cliente do Google Calendar via CRM Imperador.

O CRM ja tem OAuth do Google conectado (institutoideoficial@gmail.com).
Aqui so encapsulamos os 3 endpoints do CRM com Basic Auth.
"""

from __future__ import annotations

import base64
import os
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx

CRM_URL = os.environ.get("CRM_URL", "http://crm:3000").rstrip("/")
BASIC_USER = os.environ.get("CRM_BASIC_USER", "")
BASIC_PASS = os.environ.get("CRM_BASIC_PASS", "")
TIMEOUT = httpx.Timeout(30.0, connect=5.0)


def _headers() -> dict[str, str]:
    h = {"Content-Type": "application/json"}
    if BASIC_USER and BASIC_PASS:
        creds = base64.b64encode(f"{BASIC_USER}:{BASIC_PASS}".encode()).decode()
        h["Authorization"] = f"Basic {creds}"
    return h


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _plus_days(days: int) -> str:
    return (datetime.now(timezone.utc) + timedelta(days=days)).isoformat()


async def _request(method: str, path: str, *, params=None, json=None) -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=TIMEOUT) as c:
        r = await c.request(
            method,
            f"{CRM_URL}{path}",
            params=params,
            json=json,
            headers=_headers(),
        )
        try:
            data = r.json()
        except Exception:
            data = {"raw": r.text}
        if not isinstance(data, dict):
            data = {"data": data}
        data["_status"] = r.status_code
        return data


async def list_events(from_iso: str | None = None, to_iso: str | None = None, limit: int = 20) -> dict[str, Any]:
    params = {
        "from": from_iso or _now(),
        "to": to_iso or _plus_days(30),
        "limit": min(int(limit), 100),
    }
    return await _request("GET", "/api/integrations/google/events", params=params)


async def create_event(
    summary: str,
    start: str,
    *,
    end: str | None = None,
    duration_min: int = 60,
    description: str | None = None,
    with_meet: bool = False,
    attendee_emails: list[str] | None = None,
    phone: str | None = None,
) -> dict[str, Any]:
    body: dict[str, Any] = {"summary": summary, "start": start}
    if end:
        body["end"] = end
    else:
        body["durationMin"] = int(duration_min)
    if description:
        body["description"] = description
    if with_meet:
        body["withMeet"] = True
    if attendee_emails:
        body["attendees"] = [{"email": e} for e in attendee_emails if e]
    if phone:
        body["phone"] = phone
    return await _request("POST", "/api/integrations/google/events", json=body)


async def delete_event(event_id: str) -> dict[str, Any]:
    return await _request("DELETE", f"/api/integrations/google/events/{event_id}")
