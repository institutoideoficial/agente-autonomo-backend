"""FastAPI app — recebe webhook do Bravos dedicado e dispara loop do agente.

- /inbox        : usado pelo CRM Imperador (compat) — phone+message ja extraidos
- /inbox-bravos : usado pelo bravos-agent (instancia dedicada) — payload cru do Bravos
"""

from __future__ import annotations

import logging
import os
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel, Field

from agent import core, memory

logging.basicConfig(
    level=os.environ.get("AGENT_LOG_LEVEL", "INFO"),
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
log = logging.getLogger("agent.main")

app = FastAPI(title="Imperador Agent", version="0.1.0")


@app.on_event("startup")
def _startup() -> None:
    memory.init_db()
    log.info("agent up — model=%s mode=%s whitelist=%d",
             core.MODEL, memory.brain_get("config", "mode") or core.DEFAULT_MODE, len(core.WHITELIST))


@app.get("/healthz")
def healthz() -> dict[str, Any]:
    return {
        "ok": True,
        "model": core.MODEL,
        "mode": memory.brain_get("config", "mode") or core.DEFAULT_MODE,
        "whitelist_count": len(core.WHITELIST),
        "brain_entries": len(memory.brain_list()),
    }


class InboxPayload(BaseModel):
    phone: str = Field(..., description="numero do contato (so digitos ou com @c.us)")
    message: str
    name: str | None = None
    chatId: str | None = None


@app.post("/inbox")
async def inbox(payload: InboxPayload) -> dict[str, Any]:
    phone = payload.phone or payload.chatId or ""
    digits = "".join(ch for ch in phone if ch.isdigit())
    if not digits:
        raise HTTPException(status_code=400, detail="phone invalido")
    log.info("inbox de %s (%s): %s", digits, payload.name, payload.message[:80])
    result = await core.handle_inbound(digits, payload.message, payload.name)
    return result


@app.post("/inbox-bravos")
async def inbox_bravos(req: Request) -> dict[str, Any]:
    """Webhook cru do Bravos.

    Payload tipico:
      {"type": "message_in", "data": {"chat_id": "...@c.us", "from_id": "5512...",
       "body": "oi", "fromMe": false, "pushname": "Fulano"},
       "clientId": "agent-bot", "timestamp": 169...}
    """
    try:
        payload = await req.json()
    except Exception:
        raise HTTPException(400, "json invalido")

    typ = payload.get("type")
    data = payload.get("data") or {}

    if typ != "message_in":
        # ready / disconnected / message_out — apenas registra no audit
        memory.audit("bravos_event", None, {"type": typ}, {"data_keys": list(data.keys())}, True)
        return {"ok": True, "ignored": True, "reason": f"type={typ}"}

    if data.get("fromMe"):
        return {"ok": True, "ignored": True, "reason": "fromMe"}

    raw = data.get("from_id") or (data.get("chat_id") or "").split("@")[0]
    digits = "".join(ch for ch in str(raw) if ch.isdigit())
    body = str(data.get("body") or "").strip()
    name = data.get("pushname")

    if not digits or not body:
        return {"ok": True, "ignored": True, "reason": "empty_phone_or_body"}

    log.info("inbox-bravos de %s (%s): %s", digits, name, body[:80])
    return await core.handle_inbound(digits, body, name)


# ---------------------------------------------------------------------------
# Endpoints de inspecao / controle (uso interno)
# ---------------------------------------------------------------------------

@app.get("/brain")
def brain(category: str | None = None) -> dict[str, Any]:
    return {"entries": memory.brain_list(category)}


class BrainSet(BaseModel):
    category: str
    key: str
    value: str
    metadata: dict[str, Any] | None = None


@app.post("/brain")
def brain_set(body: BrainSet) -> dict[str, Any]:
    memory.brain_set(body.category, body.key, body.value, body.metadata)
    return {"ok": True}


@app.delete("/brain")
def brain_delete(category: str, key: str) -> dict[str, Any]:
    deleted = memory.brain_delete(category, key)
    return {"deleted": deleted}


@app.get("/audit")
def audit(limit: int = 50) -> dict[str, Any]:
    return {"entries": memory.audit_recent(limit)}


class ModeBody(BaseModel):
    mode: str  # 'treino' | 'producao'


@app.post("/mode")
def set_mode(body: ModeBody) -> dict[str, Any]:
    if body.mode not in {"treino", "producao"}:
        raise HTTPException(400, "mode deve ser treino ou producao")
    memory.brain_set("config", "mode", body.mode)
    return {"ok": True, "mode": body.mode}
