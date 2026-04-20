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

// Webhook para receber mensagens do Bravos (configurar no Bravos depois)
app.post("/api/webhook/bravos", async (req, res) => {
  try {
    const msg = req.body;
    broadcastSSE({ type: "new_message", data: msg });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e?.message });
  }
});

app.listen(PORT, () => {
  console.log(`[speakers-crm] rodando na porta ${PORT}`);
  console.log(`[speakers-crm] Bravos URL: ${BRAVOS_URL}`);
});
