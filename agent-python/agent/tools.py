"""Tools que o agente pode invocar via tool_use da Messages API.

Cada tool tem (1) o schema declarado em TOOL_SCHEMAS pra a API e (2) um
handler async. execute_tool() faz o roteamento e devolve um resultado
JSON-safe que vira o `content` do tool_result.
"""

from __future__ import annotations

import json
from typing import Any

from . import bravos_client, calendar_client, memory

TOOL_SCHEMAS: list[dict[str, Any]] = [
    {
        "name": "send_whatsapp_message",
        "description": (
            "Envia uma mensagem de WhatsApp pelo numero informado. "
            "Use SEMPRE esta tool para responder o usuario — texto livre no end_turn nao chega a ninguem. "
            "phone deve conter so digitos com codigo do pais (ex: 5512982933600)."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "phone": {"type": "string", "description": "Numero destino, so digitos."},
                "message": {"type": "string", "description": "Texto da mensagem."},
            },
            "required": ["phone", "message"],
        },
    },
    {
        "name": "get_conversation_history",
        "description": (
            "Busca historico de conversa de WhatsApp com um contato (vindo do Bravos)."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "phone": {"type": "string"},
                "limit": {"type": "integer", "default": 30, "minimum": 1, "maximum": 200},
            },
            "required": ["phone"],
        },
    },
    {
        "name": "remember",
        "description": (
            "Salva ou atualiza uma informacao no cerebro persistente. Use sempre que o "
            "usuario revelar algo sobre identidade, persona, regras, frameworks favoritos, "
            "copies que funcionaram, perfil pessoal, decisoes operacionais, etc. "
            "category agrupa (ex: persona, regras, frameworks, identidade, perfil_vanessa, "
            "estilo_copy, palestrante_X). key identifica de forma unica dentro da categoria."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "category": {"type": "string"},
                "key": {"type": "string"},
                "value": {"type": "string"},
                "metadata": {"type": "object", "additionalProperties": True},
            },
            "required": ["category", "key", "value"],
        },
    },
    {
        "name": "recall",
        "description": (
            "Busca por substring no cerebro (categoria, chave ou valor). "
            "Use antes de responder se precisar lembrar de algo."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {"type": "string"},
                "limit": {"type": "integer", "default": 20},
            },
            "required": ["query"],
        },
    },
    {
        "name": "list_brain",
        "description": "Lista entradas do cerebro. Filtra por categoria se informada.",
        "input_schema": {
            "type": "object",
            "properties": {"category": {"type": "string"}},
        },
    },
    {
        "name": "forget",
        "description": "Remove uma entrada do cerebro.",
        "input_schema": {
            "type": "object",
            "properties": {
                "category": {"type": "string"},
                "key": {"type": "string"},
            },
            "required": ["category", "key"],
        },
    },
    {
        "name": "calendar_list_events",
        "description": (
            "Lista eventos do Google Calendar da Vanessa entre datas. Use SEMPRE antes de "
            "marcar mentoria pra checar se ja tem algo no horario. Datas em ISO 8601 "
            "(ex: '2026-04-28T14:00:00-03:00'). Sem from/to, retorna proximos 30 dias."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "from_iso": {"type": "string", "description": "Inicio em ISO 8601. Default: agora."},
                "to_iso": {"type": "string", "description": "Fim em ISO 8601. Default: 30 dias a frente."},
                "limit": {"type": "integer", "default": 20, "minimum": 1, "maximum": 100},
            },
        },
    },
    {
        "name": "calendar_create_event",
        "description": (
            "Cria evento na agenda da Vanessa. Antes de criar mentoria SEMPRE chame calendar_list_events "
            "no horario pra evitar conflito. Mentoria 1:1 padrao: duration_min=60, with_meet=true. "
            "Passe phone (so digitos) pra vincular o evento ao contato."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "summary": {"type": "string", "description": "Titulo do evento."},
                "start": {"type": "string", "description": "Inicio em ISO 8601 com timezone (-03:00)."},
                "end": {"type": "string", "description": "Fim em ISO 8601 (opcional)."},
                "duration_min": {"type": "integer", "default": 60},
                "description": {"type": "string"},
                "with_meet": {"type": "boolean", "default": False, "description": "Gera link Google Meet."},
                "attendee_emails": {"type": "array", "items": {"type": "string"}},
                "phone": {"type": "string", "description": "Telefone do contato (so digitos)."},
            },
            "required": ["summary", "start"],
        },
    },
    {
        "name": "calendar_delete_event",
        "description": "Deleta evento da agenda. Use o id retornado por calendar_list_events.",
        "input_schema": {
            "type": "object",
            "properties": {"event_id": {"type": "string"}},
            "required": ["event_id"],
        },
    },
    {
        "name": "set_mode",
        "description": (
            "Troca entre 'treino' (so whitelist) e 'producao' (todos os contatos). "
            "Use APENAS quando a treinadora confirmar explicitamente que voce esta pronto "
            "pra atender contatos externos. Em duvida, pergunte antes."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "mode": {"type": "string", "enum": ["treino", "producao"]},
            },
            "required": ["mode"],
        },
    },
    {
        "name": "mark_onboarding",
        "description": (
            "Marca o status do onboarding. Status: 'em_andamento', 'concluido'. "
            "Use 'concluido' quando voce tiver capturado: nome (identidade), persona/tom, "
            "regras operacionais, perfil da Vanessa, e pelo menos 1 palestrante cadastrado."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "status": {"type": "string", "enum": ["em_andamento", "concluido"]},
                "resumo": {"type": "string", "description": "Resumo curto do que foi capturado."},
            },
            "required": ["status"],
        },
    },
]


async def execute_tool(name: str, args: dict[str, Any], *, contact_phone: str | None = None) -> str:
    """Executa uma tool e devolve string JSON pronta pra ir como tool_result content."""
    try:
        result = await _dispatch(name, args)
        ok = True
    except Exception as e:
        result = {"error": str(e), "type": type(e).__name__}
        ok = False
    memory.audit(action=f"tool:{name}", contact_phone=contact_phone, payload=args, result=result, ok=ok)
    return json.dumps(result, ensure_ascii=False, default=str)


async def _dispatch(name: str, args: dict[str, Any]) -> Any:
    if name == "send_whatsapp_message":
        return await bravos_client.send_message(args["phone"], args["message"])

    if name == "get_conversation_history":
        return await bravos_client.get_history(args["phone"], args.get("limit", 30))

    if name == "remember":
        memory.brain_set(
            args["category"], args["key"], args["value"], args.get("metadata"),
        )
        return {"ok": True, "category": args["category"], "key": args["key"]}

    if name == "recall":
        return {"results": memory.brain_search(args["query"], args.get("limit", 20))}

    if name == "list_brain":
        return {"entries": memory.brain_list(args.get("category"))}

    if name == "forget":
        deleted = memory.brain_delete(args["category"], args["key"])
        return {"deleted": deleted}

    if name == "calendar_list_events":
        return await calendar_client.list_events(
            args.get("from_iso"), args.get("to_iso"), args.get("limit", 20)
        )

    if name == "calendar_create_event":
        return await calendar_client.create_event(
            summary=args["summary"],
            start=args["start"],
            end=args.get("end"),
            duration_min=args.get("duration_min", 60),
            description=args.get("description"),
            with_meet=args.get("with_meet", False),
            attendee_emails=args.get("attendee_emails"),
            phone=args.get("phone"),
        )

    if name == "calendar_delete_event":
        return await calendar_client.delete_event(args["event_id"])

    if name == "set_mode":
        memory.brain_set("config", "mode", args["mode"])
        return {"ok": True, "mode": args["mode"]}

    if name == "mark_onboarding":
        memory.brain_set("config", "onboarding_status", args["status"], {"resumo": args.get("resumo", "")})
        return {"ok": True, "status": args["status"]}

    raise ValueError(f"Tool desconhecida: {name}")
