// SPEAKERS CRM Backend - integrado com Bravos WhatsApp API
const express = require("express");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk");

const app = express();
const PORT = process.env.PORT || 3000;

// Config Bravos WhatsApp API
const BRAVOS_URL = process.env.BRAVOS_URL || "https://bravos-whatsapp-api-production.up.railway.app";
const BRAVOS_TOKEN = process.env.BRAVOS_TOKEN || "sp_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2";

app.use(express.json());
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "welcome.html")));
app.get("/app", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.use(express.static(path.join(__dirname, "public")));

// SSE clients
const sseClients = new Set();

function broadcastSSE(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(c => { try { c.write(msg); } catch (e) {} });
}

// Health
app.get("/health", (req, res) => res.json({ ok: true, service: "speakers-crm-backend" }));

// SSE endpoint para frontend
app.get("/events", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "Access-Control-Allow-Origin": "*"
  });
  res.write(":ok\n\n");
  sseClients.add(res);
  req.on("close", () => sseClients.delete(res));
});

// Bot IA (Anthropic)
app.post("/api/bot", async (req, res) => {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY nao configurada" });
    const client = new Anthropic({ apiKey });
    const messages = Array.isArray(req.body.messages) ? req.body.messages : [];
    const response = await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 512,
      system: "Voce e um assistente da Speakers Play, formacao de oratoria da Vanessa Labastie. Responda de forma clara, gentil e profissional em portugues.",
      messages: messages.length ? messages : [{ role: "user", content: "Ola" }]
    });
    const reply = response.content?.[0]?.text || "Desculpe, nao consegui responder.";
    res.json({ reply });
  } catch (e) {
    console.error("[bot]", e?.message);
    res.status(500).json({ error: e?.message || "erro no bot" });
  }
});

// Status da conexao WhatsApp (Bravos)
app.get("/api/status/:clientId", async (req, res) => {
  try {
    const r = await fetch(`${BRAVOS_URL}/health`);
    const data = await r.json();
    const state = data.isReady && data.isAuthenticated ? "connected" : "disconnected";
    res.json({ status: state, state, instance: { status: state, state, ...data } });
  } catch (e) {
    res.json({ state: "disconnected", error: e?.message });
  }
});

// Enviar mensagem via Bravos
app.post("/api/send-message", async (req, res) => {
  try {
    const { phone, message } = req.body;
    if (!phone || !message) return res.status(400).json({ error: "phone e message sao obrigatorios" });
    const clean = String(phone).replace(/\D/g, "");
    const chatId = clean.includes("@") ? clean : `${clean}@c.us`;
    const r = await fetch(`${BRAVOS_URL}/send-message`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${BRAVOS_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ chatId, message: String(message) })
    });
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (e) {
    res.status(500).json({ error: e?.message });
  }
});

// Historico de conversa
app.get("/api/history", async (req, res) => {
  try {
    const { chatId, limit = 50 } = req.query;
    if (!chatId) return res.status(400).json({ error: "chatId obrigatorio" });
    const r = await fetch(`${BRAVOS_URL}/history?chatId=${encodeURIComponent(chatId)}&limit=${limit}`, {
      headers: { "Authorization": `Bearer ${BRAVOS_TOKEN}` }
    });
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (e) {
    res.status(500).json({ error: e?.message });
  }
});

// Pairing code - mantido por compatibilidade (ja nao precisa com Bravos, mas nao quebra)
app.post("/api/pairing-code", async (req, res) => {
  try {
    const phone = req.body && req.body.phone ? String(req.body.phone).replace(/\D/g, "") : "";
    if (!phone) return res.status(400).json({ error: "phone obrigatorio" });
    res.json({ ok: true, info: "Use a URL do Bravos para escanear QR: " + BRAVOS_URL, phone });
  } catch (e) {
    res.status(500).json({ error: e?.message });
  }
});

// Webhook para receber mensagens do Bravos
// Bravos envia: { type: "message_in"|"message_out"|"ready"|"disconnected", data: {...}, clientId, timestamp }
app.post("/api/webhook/bravos", async (req, res) => {
  try {
    const msg = req.body || {};
    const innerType = msg.type;
    const inner = msg.data;
    if (innerType === "message_in" || innerType === "message_out") {
      broadcastSSE({
        type: innerType,
        data: inner,
        clientId: msg.clientId,
        timestamp: msg.timestamp
      });
    } else if (innerType === "ready") {
      broadcastSSE({ type: "whatsapp_ready", timestamp: msg.timestamp });
    } else if (innerType === "disconnected") {
      broadcastSSE({ type: "whatsapp_disconnected", data: inner, timestamp: msg.timestamp });
    } else {
      // fallback - mantem compat com payloads desconhecidos
      broadcastSSE({ type: "new_message", data: msg });
    }
    res.json({ ok: true });
  } catch (e) {
    console.error("[webhook]", e?.message);
    res.status(500).json({ error: e?.message });
  }
});

// ============================================================
// MENSAGENS AGENDADAS (v4.8) - storage JSON + worker interno
// ============================================================
const fs = require("fs");
const SCHED_FILE = process.env.SCHEDULED_FILE || path.join(__dirname, "data", "scheduled.json");
fs.mkdirSync(path.dirname(SCHED_FILE), { recursive: true });
function schedLoad() {
  try { return JSON.parse(fs.readFileSync(SCHED_FILE, "utf8")); } catch { return []; }
}
function schedSave(arr) {
  try { fs.writeFileSync(SCHED_FILE, JSON.stringify(arr, null, 2)); } catch (e) { console.error("[sched]", e?.message); }
}
function schedNewId() { return "sch_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8); }

// Lista agendamentos (com filtros opcionais)
app.get("/api/scheduled", (req, res) => {
  const arr = schedLoad();
  const status = req.query.status; // pending | sent | failed | cancelled
  const filtered = status ? arr.filter(x => x.status === status) : arr;
  res.json({ ok: true, count: filtered.length, items: filtered });
});

// Cria agendamento
app.post("/api/scheduled", (req, res) => {
  const { phone, message, sendAt, note } = req.body || {};
  if (!phone || !message || !sendAt) {
    return res.status(400).json({ ok: false, error: "phone, message, sendAt sao obrigatorios" });
  }
  const ts = Number(sendAt);
  if (!ts || isNaN(ts)) return res.status(400).json({ ok: false, error: "sendAt deve ser unix ms" });
  if (ts < Date.now() - 30000) return res.status(400).json({ ok: false, error: "sendAt no passado" });
  const arr = schedLoad();
  const item = {
    id: schedNewId(),
    phone: String(phone).replace(/\D/g, ""),
    message: String(message),
    note: note ? String(note) : "",
    sendAt: ts,
    status: "pending",
    createdAt: Date.now(),
    sentAt: null,
    error: null
  };
  arr.push(item);
  schedSave(arr);
  res.json({ ok: true, item });
});

// Cancela agendamento (so se ainda pending)
app.delete("/api/scheduled/:id", (req, res) => {
  const arr = schedLoad();
  const idx = arr.findIndex(x => x.id === req.params.id);
  if (idx === -1) return res.status(404).json({ ok: false, error: "nao encontrado" });
  if (arr[idx].status !== "pending") return res.status(409).json({ ok: false, error: "nao eh mais pending: " + arr[idx].status });
  arr[idx].status = "cancelled";
  arr[idx].cancelledAt = Date.now();
  schedSave(arr);
  res.json({ ok: true, item: arr[idx] });
});

// Worker interno: a cada 30s checa pendentes que venceram e dispara
async function schedTick() {
  const arr = schedLoad();
  const now = Date.now();
  const due = arr.filter(x => x.status === "pending" && x.sendAt <= now);
  if (due.length === 0) return;
  for (const item of due) {
    try {
      const r = await fetch(`${BRAVOS_URL}/send-message`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${BRAVOS_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ chatId: `${item.phone}@c.us`, message: item.message })
      });
      const data = await r.json();
      if (r.ok && (data.ok !== false)) {
        item.status = "sent";
        item.sentAt = Date.now();
        item.messageId = data.messageId || null;
      } else {
        item.status = "failed";
        item.error = data.error || `HTTP ${r.status}`;
      }
    } catch (e) {
      item.status = "failed";
      item.error = e?.message || String(e);
    }
  }
  schedSave(arr);
  console.log(`[sched] processou ${due.length} agendamento(s)`);
}
setInterval(schedTick, 30 * 1000); // 30s
// Roda 1 vez ao subir (catch-up)
setTimeout(schedTick, 5 * 1000);

app.listen(PORT, () => {
  console.log(`[speakers-crm] rodando na porta ${PORT}`);
  console.log(`[speakers-crm] Bravos URL: ${BRAVOS_URL}`);
  console.log(`[speakers-crm] Scheduled storage: ${SCHED_FILE}`);
});
