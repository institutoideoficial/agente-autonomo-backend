"""SQLite-backed cerebro persistente do agente.

Tabelas:
- brain: pares (categoria, chave) -> valor. Onde mora persona, regras, frameworks, perfis,
  contatos importantes, exemplos de copies, frases tipicas, etc.
- conversations: 1 por contato/telefone.
- messages: historico bruto pra alimentar Anthropic Messages API (JSON content blocks).
- audit_log: tudo que o agente fez de forma autonoma (acoes externas).
"""

from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
from contextlib import contextmanager
from typing import Any, Iterator

DB_PATH = os.environ.get("AGENT_DB_PATH", "data/agent.db")

_lock = threading.Lock()
_initialized = False


def _connect() -> sqlite3.Connection:
    os.makedirs(os.path.dirname(DB_PATH) or ".", exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=30, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


@contextmanager
def db() -> Iterator[sqlite3.Connection]:
    conn = _connect()
    try:
        yield conn
    finally:
        conn.close()


SCHEMA = """
CREATE TABLE IF NOT EXISTS brain (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    metadata_json TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(category, key)
);
CREATE INDEX IF NOT EXISTS idx_brain_category ON brain(category);

CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contact_phone TEXT NOT NULL UNIQUE,
    contact_name TEXT,
    mode TEXT NOT NULL DEFAULT 'treino',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    content_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, id);

CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT NOT NULL,
    contact_phone TEXT,
    payload_json TEXT,
    result_json TEXT,
    ok INTEGER NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action, created_at);
"""


def init_db() -> None:
    global _initialized
    with _lock:
        if _initialized:
            return
        with db() as conn:
            conn.executescript(SCHEMA)
        _initialized = True


def now_ms() -> int:
    return int(time.time() * 1000)


# ---------------------------------------------------------------------------
# BRAIN (cerebro generalista)
# ---------------------------------------------------------------------------

def brain_set(category: str, key: str, value: str, metadata: dict | None = None) -> None:
    init_db()
    ts = now_ms()
    md_json = json.dumps(metadata or {}, ensure_ascii=False)
    with db() as conn:
        conn.execute(
            """
            INSERT INTO brain(category, key, value, metadata_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(category, key) DO UPDATE SET
                value = excluded.value,
                metadata_json = excluded.metadata_json,
                updated_at = excluded.updated_at
            """,
            (category, key, value, md_json, ts, ts),
        )


def brain_get(category: str, key: str) -> str | None:
    init_db()
    with db() as conn:
        row = conn.execute(
            "SELECT value FROM brain WHERE category=? AND key=?", (category, key)
        ).fetchone()
        return row["value"] if row else None


def brain_list(category: str | None = None) -> list[dict[str, Any]]:
    init_db()
    with db() as conn:
        if category:
            rows = conn.execute(
                "SELECT category, key, value, metadata_json, updated_at FROM brain WHERE category=? ORDER BY key",
                (category,),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT category, key, value, metadata_json, updated_at FROM brain ORDER BY category, key"
            ).fetchall()
        return [
            {
                "category": r["category"],
                "key": r["key"],
                "value": r["value"],
                "metadata": json.loads(r["metadata_json"] or "{}"),
                "updated_at": r["updated_at"],
            }
            for r in rows
        ]


def brain_search(query: str, limit: int = 20) -> list[dict[str, Any]]:
    init_db()
    pattern = f"%{query}%"
    with db() as conn:
        rows = conn.execute(
            """
            SELECT category, key, value, metadata_json, updated_at FROM brain
            WHERE key LIKE ? OR value LIKE ? OR category LIKE ?
            ORDER BY updated_at DESC
            LIMIT ?
            """,
            (pattern, pattern, pattern, limit),
        ).fetchall()
        return [
            {
                "category": r["category"],
                "key": r["key"],
                "value": r["value"],
                "metadata": json.loads(r["metadata_json"] or "{}"),
            }
            for r in rows
        ]


def brain_delete(category: str, key: str) -> bool:
    init_db()
    with db() as conn:
        cur = conn.execute("DELETE FROM brain WHERE category=? AND key=?", (category, key))
        return cur.rowcount > 0


# ---------------------------------------------------------------------------
# CONVERSATIONS / MESSAGES
# ---------------------------------------------------------------------------

def get_or_create_conversation(phone: str, name: str | None = None) -> int:
    init_db()
    ts = now_ms()
    with db() as conn:
        row = conn.execute(
            "SELECT id FROM conversations WHERE contact_phone=?", (phone,)
        ).fetchone()
        if row:
            if name:
                conn.execute(
                    "UPDATE conversations SET contact_name=?, updated_at=? WHERE id=?",
                    (name, ts, row["id"]),
                )
            return row["id"]
        cur = conn.execute(
            """
            INSERT INTO conversations(contact_phone, contact_name, mode, created_at, updated_at)
            VALUES (?, ?, 'treino', ?, ?)
            """,
            (phone, name, ts, ts),
        )
        return cur.lastrowid


def append_message(conversation_id: int, role: str, content: Any) -> None:
    """Append a message. content is the raw Anthropic content (str or list of blocks)."""
    init_db()
    if isinstance(content, str):
        content_json = json.dumps([{"type": "text", "text": content}], ensure_ascii=False)
    else:
        content_json = json.dumps(content, ensure_ascii=False, default=_json_default)
    with db() as conn:
        conn.execute(
            "INSERT INTO messages(conversation_id, role, content_json, created_at) VALUES (?, ?, ?, ?)",
            (conversation_id, role, content_json, now_ms()),
        )


def load_history(conversation_id: int, limit: int = 60) -> list[dict[str, Any]]:
    """Carrega historico em formato Anthropic (role + content list)."""
    init_db()
    with db() as conn:
        rows = conn.execute(
            """
            SELECT role, content_json FROM messages
            WHERE conversation_id=?
            ORDER BY id DESC
            LIMIT ?
            """,
            (conversation_id, limit),
        ).fetchall()
        msgs = [
            {"role": r["role"], "content": json.loads(r["content_json"])}
            for r in reversed(rows)
        ]
        return msgs


def _json_default(obj: Any) -> Any:
    # Anthropic SDK objects expose model_dump
    if hasattr(obj, "model_dump"):
        return obj.model_dump()
    if hasattr(obj, "__dict__"):
        return obj.__dict__
    return str(obj)


# ---------------------------------------------------------------------------
# AUDIT LOG
# ---------------------------------------------------------------------------

def audit(action: str, contact_phone: str | None, payload: Any, result: Any, ok: bool) -> None:
    init_db()
    with db() as conn:
        conn.execute(
            """
            INSERT INTO audit_log(action, contact_phone, payload_json, result_json, ok, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                action,
                contact_phone,
                json.dumps(payload, ensure_ascii=False, default=_json_default),
                json.dumps(result, ensure_ascii=False, default=_json_default),
                1 if ok else 0,
                now_ms(),
            ),
        )


def audit_recent(limit: int = 50) -> list[dict[str, Any]]:
    init_db()
    with db() as conn:
        rows = conn.execute(
            "SELECT * FROM audit_log ORDER BY id DESC LIMIT ?", (limit,)
        ).fetchall()
        return [
            {
                "id": r["id"],
                "action": r["action"],
                "contact_phone": r["contact_phone"],
                "payload": json.loads(r["payload_json"] or "null"),
                "result": json.loads(r["result_json"] or "null"),
                "ok": bool(r["ok"]),
                "created_at": r["created_at"],
            }
            for r in rows
        ]
