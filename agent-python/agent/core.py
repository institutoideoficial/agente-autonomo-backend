"""Loop principal do agente autonomo. Recebe mensagem entrante e roda tool use ate end_turn.

Modos:
- treino: so responde whitelist; system prompt enfatiza aprender (preencher cerebro + Speakers).
- producao: responde todos; system prompt usa cerebro como personalidade definitiva.
"""

from __future__ import annotations

import logging
import os
from typing import Any

from anthropic import AsyncAnthropic

from . import memory
from .tools import TOOL_SCHEMAS, execute_tool

log = logging.getLogger("agent.core")

MODEL = os.environ.get("AGENT_MODEL", "claude-haiku-4-5")
MAX_TOKENS = int(os.environ.get("AGENT_MAX_TOKENS", "4096"))
MAX_LOOP_STEPS = int(os.environ.get("AGENT_MAX_LOOP_STEPS", "12"))
WHITELIST = {p.strip() for p in os.environ.get("AGENT_WHITELIST", "").split(",") if p.strip()}
DEFAULT_MODE = os.environ.get("AGENT_MODE", "treino")
LID_MAX_PHONE_DIGITS = 13  # Brasil: 5512982933600 = 13 digitos. Acima disso e @lid (privacy ID).
MIN_MESSAGE_LEN = 3
DEDUP_WINDOW_SEC = 60

_client: AsyncAnthropic | None = None


def client() -> AsyncAnthropic:
    global _client
    if _client is None:
        _client = AsyncAnthropic()
    return _client


def is_allowed(phone: str) -> bool:
    mode = memory.brain_get("config", "mode") or DEFAULT_MODE
    if mode == "producao":
        return True
    digits = "".join(ch for ch in phone if ch.isdigit())
    return digits in WHITELIST


def _agent_name() -> str:
    return memory.brain_get("identidade", "nome") or "ainda sem nome"


def _onboarding_state() -> dict[str, Any]:
    """Mede o que ja foi capturado no cerebro pra orientar o roteiro de treino."""
    nome = memory.brain_get("identidade", "nome")
    status = memory.brain_get("config", "onboarding_status") or "nao_iniciado"
    counts = {
        "identidade": len(memory.brain_list("identidade")),
        "persona": len(memory.brain_list("persona")),
        "regras": len(memory.brain_list("regras")),
        "perfil_dono": len(memory.brain_list("perfil_dono")),
        "frameworks": len(memory.brain_list("frameworks")),
        "estilo_copy": len(memory.brain_list("estilo_copy")),
        "rotina": len(memory.brain_list("rotina")),
    }

    if not nome:
        next_step = "1_nome"
    elif counts["persona"] < 2:
        next_step = "2_persona"
    elif counts["regras"] < 2:
        next_step = "3_regras"
    elif counts["perfil_dono"] < 2:
        next_step = "4_perfil_dono"
    elif counts["rotina"] < 1:
        next_step = "5_rotina_e_tarefas"
    else:
        next_step = "6_revisar_e_promover"

    return {
        "status": status,
        "next_step": next_step,
        "nome": nome,
        "counts": counts,
    }


_ONBOARDING_PLAYBOOK = """## Roteiro de onboarding (so em modo treino)

Conduza UMA etapa por turno. Pergunta UMA coisa de cada vez. Nao despeje 5 perguntas juntas.

**Etapa 1 — Nome.** Voce ainda nao tem nome. Apresente-se como "agente autonomo em treinamento", explique de forma curta que vai ajudar a operar a rotina (IG, WhatsApp, copies, agenda, tarefas) e peca pra escolherem um nome pra voce. Quando vierem com o nome, salve com `remember(category='identidade', key='nome', value=NOME)` e confirme.

**Etapa 2 — Persona / tom de voz.** Pergunte como voce deve falar (formal/informal, curto/longo, gírias, emojis, etc). Capture pelo menos 2 entradas em `persona` (tom, vocabulario, formato, etc).

**Etapa 3 — Regras operacionais.** Pergunte o que voce PODE e NAO PODE fazer sozinho. Capture limites em `regras` (ex: "nunca prometer desconto", "nao mandar audio", "confirmar antes de agendar reuniao", "nao postar no IG sem aprovacao", etc). Minimo 2 entradas.

**Etapa 4 — Perfil do dono.** Pergunte sobre o dono do agente: nome, area de atuacao, publico, produtos/projetos, valores, frases tipicas. Salve em `perfil_dono`.

**Etapa 5 — Rotina e tarefas recorrentes.** Pergunte que tipo de tarefa voce vai operar no dia a dia (responder DM no IG? agendar reunioes? lembrar de follow-ups? gerar copies?). Salve padroes em `rotina`.

**Etapa 6 — Revisar e promover.** Resuma o cerebro com `list_brain`, mostre o que aprendeu, e pergunte se ja pode trocar pra modo producao. Se SIM: chame `set_mode("producao")` e depois `mark_onboarding("concluido", resumo=...)`.

Durante o treino, USE `remember` agressivamente. Cada coisa relevante que aparecer — salve em alguma categoria (persona, regras, perfil_dono, frameworks, estilo_copy, rotina, contatos_chave, etc — categoria livre, voce decide).
"""


def build_system_prompt(contact_phone: str, contact_name: str | None) -> str:
    mode = memory.brain_get("config", "mode") or DEFAULT_MODE
    state = _onboarding_state()
    nome = _agent_name()

    persona = memory.brain_list("persona")
    regras = memory.brain_list("regras")
    identidade = memory.brain_list("identidade")
    perfil_dono = memory.brain_list("perfil_dono")
    cerebro_total = sum(1 for _ in memory.brain_list())

    lines: list[str] = []
    lines.append(f"Voce e {nome}, um agente autonomo operando via WhatsApp em portugues brasileiro.")
    lines.append(
        "Voce decide e age sozinho. Nao pede confirmacao para acoes do dia a dia "
        "(responder mensagens, salvar info no cerebro, cadastrar palestrantes, etc)."
    )
    lines.append(
        "Para responder o contato, use SEMPRE a tool `send_whatsapp_message`. "
        "Texto livre fora de tool_use e apenas raciocinio interno e nao chega a ninguem."
    )
    lines.append(
        "Mande no MAXIMO 1 mensagem WhatsApp por turno. Se quiser perguntar varias coisas, "
        "junte numa unica mensagem curta. Nunca mande 2-3 mensagens em sequencia no mesmo turno."
    )

    lines.append("")
    lines.append(f"Modo atual: **{mode}** | Status onboarding: **{state['status']}** | Proxima etapa: **{state['next_step']}**")

    if mode == "treino":
        lines.append("")
        lines.append(_ONBOARDING_PLAYBOOK)
        lines.append("")
        lines.append(
            f"Estado do cerebro: identidade={state['counts']['identidade']}, persona={state['counts']['persona']}, "
            f"regras={state['counts']['regras']}, perfil_dono={state['counts']['perfil_dono']}, "
            f"rotina={state['counts']['rotina']}."
        )
        lines.append("Foque na etapa atual: " + state["next_step"])
    else:
        lines.append(
            "Em producao, atenda qualquer contato com base no cerebro. "
            "Continue salvando aprendizados novos com `remember`."
        )

    if identidade:
        lines.append("")
        lines.append("## Identidade")
        for e in identidade:
            lines.append(f"- {e['key']}: {e['value']}")

    if persona:
        lines.append("")
        lines.append("## Persona / tom de voz")
        for e in persona:
            lines.append(f"- {e['key']}: {e['value']}")

    if regras:
        lines.append("")
        lines.append("## Regras operacionais")
        for e in regras:
            lines.append(f"- {e['key']}: {e['value']}")

    if perfil_dono:
        lines.append("")
        lines.append("## Perfil do dono")
        for e in perfil_dono:
            lines.append(f"- {e['key']}: {e['value']}")

    lines.append("")
    lines.append(f"Total de entradas no cerebro: {cerebro_total}. Use `recall` ou `list_brain` quando precisar de algo nao listado acima.")

    lines.append("")
    lines.append("## Contato atual")
    lines.append(f"- Telefone: {contact_phone}")
    if contact_name:
        lines.append(f"- Nome: {contact_name}")

    return "\n".join(lines)


async def handle_inbound(phone: str, message: str, contact_name: str | None = None) -> dict[str, Any]:
    """Ponto de entrada quando uma mensagem chega via webhook.

    Aplica filtros pre-API (whitelist, lid, length, dedup) antes de chamar
    Anthropic — economiza rate limit e evita responder spam.
    """
    digits = "".join(ch for ch in phone if ch.isdigit())
    if not digits:
        return {"ok": False, "reason": "phone_invalid"}

    # Filtro 1: privacy IDs (@lid) sao geralmente grupos / contatos com privacidade.
    # Phones BR tem ate 13 digitos; @lid tem 14-15. Em modo treino + whitelist nao
    # bate aqui, mas em producao isso protege contra ruido.
    if len(digits) > LID_MAX_PHONE_DIGITS:
        memory.audit("inbound_lid_filtered", digits, {"message": (message or "")[:120]}, {"reason": "lid_too_long"}, True)
        return {"ok": True, "ignored": True, "reason": "lid_filtered"}

    body = (message or "").strip()
    if len(body) < MIN_MESSAGE_LEN:
        memory.audit("inbound_short_filtered", digits, {"message": body}, {"reason": "too_short"}, True)
        return {"ok": True, "ignored": True, "reason": "too_short"}

    if memory.is_recent_duplicate(digits, body, window_sec=DEDUP_WINDOW_SEC):
        memory.audit("inbound_duplicate_filtered", digits, {"message": body[:120]}, {"reason": f"dup_{DEDUP_WINDOW_SEC}s"}, True)
        return {"ok": True, "ignored": True, "reason": "duplicate"}

    if not is_allowed(digits):
        log.info("ignorando %s — fora da whitelist (modo treino)", digits)
        memory.audit("inbound_ignored", digits, {"message": body}, {"reason": "whitelist"}, True)
        return {"ok": True, "ignored": True, "reason": "whitelist"}

    conv_id = memory.get_or_create_conversation(digits, contact_name)
    history = memory.load_history(conv_id, limit=80)

    user_block = {"role": "user", "content": [{"type": "text", "text": body}]}
    history.append(user_block)
    memory.append_message(conv_id, "user", [{"type": "text", "text": body}])

    system_text = build_system_prompt(digits, contact_name)
    # Prompt caching: system prompt vai pra cache (TTL 5min), economiza ~90% dos tokens em chamadas seguidas
    system_blocks = [{"type": "text", "text": system_text, "cache_control": {"type": "ephemeral"}}]

    steps = 0
    final_text_parts: list[str] = []
    last_response: Any = None

    while steps < MAX_LOOP_STEPS:
        steps += 1
        log.info("[loop %d] phone=%s history=%d", steps, digits, len(history))

        resp = await client().messages.create(
            model=MODEL,
            max_tokens=MAX_TOKENS,
            system=system_blocks,
            tools=TOOL_SCHEMAS,
            messages=history,
        )
        last_response = resp

        content_blocks = [b.model_dump() for b in resp.content]
        history.append({"role": "assistant", "content": content_blocks})
        memory.append_message(conv_id, "assistant", content_blocks)

        if resp.stop_reason != "tool_use":
            for b in resp.content:
                if getattr(b, "type", None) == "text":
                    final_text_parts.append(b.text)
            break

        tool_results = []
        for block in resp.content:
            if getattr(block, "type", None) != "tool_use":
                continue
            result_str = await execute_tool(block.name, block.input or {}, contact_phone=digits)
            tool_results.append({
                "type": "tool_result",
                "tool_use_id": block.id,
                "content": result_str,
            })
        history.append({"role": "user", "content": tool_results})
        memory.append_message(conv_id, "user", tool_results)

    return {
        "ok": True,
        "steps": steps,
        "stop_reason": getattr(last_response, "stop_reason", None),
        "trailing_text": "\n".join(final_text_parts),
        "conversation_id": conv_id,
    }
