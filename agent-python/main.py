"""FastAPI app — recebe webhook do CRM (mensagens entrantes do Bravos) e dispara loop do agente."""

from __future__ import annotations

import logging
import os
from typing import Any

from fastapi import FastAPI, HTTPException
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
