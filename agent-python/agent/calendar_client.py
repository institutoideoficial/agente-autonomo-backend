"""Cliente do Google Calendar usando OAuth PROPRIO do agente.

Conta vinculada: construindonovoeu@gmail.com (NUNCA institutoideoficial@gmail.com).
Tokens vem de agent/google_oauth.py. Nao passa pelo CRM Imperador.
"""

from __future__ import annotations

import secrets
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import urlencode

import httpx

from . import google_oauth

API_BASE = "https://www.googleapis.com/calendar/v3"
TIMEOUT = httpx.Timeout(30.0, connect=5.0)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _plus_days(days: int) -> str:
    return (datetime.now(timezone.utc) + timedelta(days=days)).isoformat()


async def _auth_headers() -> dict[str, str]:
    token = await google_oauth.get_access_token()
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


def _normalize_event(e: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": e.get("id"),
        "summary": e.get("summary"),
        "description": e.get("description"),
        "start": (e.get("start") or {}).get("dateTime") or (e.get("start") or {}).get("date"),
        "end": (e.get("end") or {}).get("dateTime") or (e.get("end") or {}).get("date"),
        "htmlLink": e.get("htmlLink"),
        "meetLink": next(
            (
                ep.get("uri")
                for ep in (e.get("conferenceData") or {}).get("entryPoints") or []
                if ep.get("entryPointType") == "video"
            ),
            e.get("hangoutLink"),
        ),
        "attendees": [
            {"email": a.get("email"), "name": a.get("displayName"), "status": a.get("responseStatus")}
            for a in (e.get("attendees") or [])
        ],
        "status": e.get("status"),
    }


async def list_events(from_iso: str | None = None, to_iso: str | None = None, limit: int = 20) -> dict[str, Any]:
    params = {
        "timeMin": from_iso or _now(),
        "timeMax": to_iso or _plus_days(30),
        "maxResults": min(int(limit), 100),
        "singleEvents": "true",
        "orderBy": "startTime",
    }
    headers = await _auth_headers()
    async with httpx.AsyncClient(timeout=TIMEOUT) as c:
        r = await c.get(
            f"{API_BASE}/calendars/primary/events?{urlencode(params)}",
            headers={k: v for k, v in headers.items() if k != "Content-Type"},
        )
        try:
            data = r.json()
        except Exception:
            return {"_status": r.status_code, "raw": r.text}
    if r.status_code >= 400:
        return {"_status": r.status_code, "error": (data.get("error") or {}).get("message") or data}
    items = [_normalize_event(e) for e in data.get("items") or []]
    return {"_status": 200, "ok": True, "count": len(items), "items": items}


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
    start_dt = datetime.fromisoformat(start.replace("Z", "+00:00"))
    if end:
        end_dt = datetime.fromisoformat(end.replace("Z", "+00:00"))
    else:
        end_dt = start_dt + timedelta(minutes=int(duration_min))

    body: dict[str, Any] = {
        "summary": summary,
        "start": {"dateTime": start_dt.isoformat(), "timeZone": "America/Sao_Paulo"},
        "end": {"dateTime": end_dt.isoformat(), "timeZone": "America/Sao_Paulo"},
    }
    if description:
        body["description"] = description
    if attendee_emails:
        body["attendees"] = [{"email": e} for e in attendee_emails if e]
    if phone:
        body["extendedProperties"] = {"private": {"agentPhone": str(phone)}}
    qs = ""
    if with_meet:
        body["conferenceData"] = {
            "createRequest": {
                "requestId": "sofia-" + secrets.token_hex(6),
                "conferenceSolutionKey": {"type": "hangoutsMeet"},
            }
        }
        qs = "?conferenceDataVersion=1&sendUpdates=all"
    else:
        qs = "?sendUpdates=all"

    headers = await _auth_headers()
    async with httpx.AsyncClient(timeout=TIMEOUT) as c:
        r = await c.post(f"{API_BASE}/calendars/primary/events{qs}", headers=headers, json=body)
        try:
            data = r.json()
        except Exception:
            return {"_status": r.status_code, "raw": r.text}
    if r.status_code >= 400:
        return {"_status": r.status_code, "error": (data.get("error") or {}).get("message") or data}
    return {"_status": 200, "ok": True, "event": _normalize_event(data)}


async def delete_event(event_id: str) -> dict[str, Any]:
    headers = await _auth_headers()
    async with httpx.AsyncClient(timeout=TIMEOUT) as c:
        r = await c.delete(
            f"{API_BASE}/calendars/primary/events/{event_id}?sendUpdates=all",
            headers={k: v for k, v in headers.items() if k != "Content-Type"},
        )
    if r.status_code in (200, 204):
        return {"_status": r.status_code, "ok": True}
    try:
        data = r.json()
    except Exception:
        data = {"raw": r.text}
    return {"_status": r.status_code, "error": (data.get("error") or {}).get("message") or data}
