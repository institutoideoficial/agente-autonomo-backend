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
// INTEGRACAO GREENN (v4.12) - webhook receiver + storage JSON + SSE
// ============================================================
const fs = require("fs");
const GREENN_FILE = process.env.GREENN_FILE || path.join(__dirname, "data", "greenn-events.json");
const GREENN_TOKEN = process.env.GREENN_WEBHOOK_TOKEN || ""; // se vazio, nao valida (modo aberto)
const GREENN_MAX_EVENTS = 200;
fs.mkdirSync(path.dirname(GREENN_FILE), { recursive: true });

function greennLoad() {
  try { return JSON.parse(fs.readFileSync(GREENN_FILE, "utf8")); } catch { return []; }
}
function greennSave(arr) {
  try { fs.writeFileSync(GREENN_FILE, JSON.stringify(arr.slice(-GREENN_MAX_EVENTS), null, 2)); } catch (e) { console.error("[greenn]", e?.message); }
}

// Normaliza payload Greenn em formato uniforme pra o frontend
// Tolera diferentes estruturas: data.customer / data.client / direct fields
function normalizeGreennPayload(raw) {
  raw = raw || {};
  const data = raw.data || raw;
  const customer = data.customer || data.client || data.buyer || {};
  const product  = data.product || data.offer || data.item || {};
  const tx       = data.transaction || data.sale || data.contract || data;
  const phone    = String(customer.phone || customer.telephone || customer.cellphone || customer.whatsapp || data.phone || "").replace(/\D/g, "");
  const name     = String(customer.name || customer.full_name || customer.nome || data.name || "").trim();
  const email    = String(customer.email || data.email || "").trim();
  const status   = String(tx.status || data.status || raw.event || "").toLowerCase();
  const productName = String(product.name || product.title || product.product_name || "").trim();
  const total    = Number(tx.total || tx.amount || tx.value || data.total || 0);
  const currency = String(tx.currency || "BRL").toUpperCase();
  return {
    event: raw.event || data.event || "unknown",
    type:  raw.type || data.type || "unknown",
    status, statusLabel: greennStatusLabel(status),
    phone, name, email,
    productName,
    total, currency,
    transactionId: tx.id || tx.transaction_id || data.transaction_id || null,
    receivedAt: Date.now(),
    raw // mantem original pra debug
  };
}
function greennStatusLabel(status) {
  const m = {
    paid: "Aprovada", approved: "Aprovada",
    pending: "Pendente", waiting_payment: "Aguardando pagamento",
    refused: "Recusada", declined: "Recusada", failed: "Falhou",
    refunded: "Reembolsada", chargedback: "Chargeback",
    cancelled: "Cancelada", expired: "Expirou",
    abandoned: "Carrinho abandonado", checkoutabandoned: "Carrinho abandonado"
  };
  return m[status] || status || "—";
}

// v4.14: regras de auto-follow-up por status (storage JSON)
const GREENN_RULES_FILE = process.env.GREENN_RULES_FILE || path.join(__dirname, "data", "greenn-rules.json");
const GREENN_RULES_DEFAULTS = [
  { status: "paid",        delayMin: 1,   enabled: true, message: "{nome}, que felicidade ter voce com a gente! 🌟\n\nSua matricula em {produto} foi aprovada! ({valor})\n\nEm instantes voce recebe o acesso. Qualquer duvida me chama por aqui.\n\nBora transformar sua oratoria? ✨" },
  { status: "approved",    delayMin: 1,   enabled: true, message: "{nome}, compra do {produto} aprovada ({valor})! 🎉 Em instantes chega o acesso. Qualquer duvida, estou aqui!" },
  { status: "abandoned",   delayMin: 15,  enabled: true, message: "Oi {nome}! Vi que voce comecou a compra do {produto} e parou no meio do caminho. Deu algum problema? Posso te ajudar em alguma etapa?\n\nSe for financeiro, conseguimos te ajudar com parcelamento ou Pix." },
  { status: "refused",     delayMin: 5,   enabled: true, message: "{nome}, sua compra do {produto} nao foi aprovada. Podemos tentar outra forma de pagamento? Tenho Pix, cartao parcelado ou boleto.\n\nSe preferir te passo um link novo." },
  { status: "declined",    delayMin: 5,   enabled: true, message: "{nome}, o cartao recusou a compra do {produto}. Vamos tentar outro metodo? Posso te enviar um Pix ou boleto agora mesmo." },
  { status: "refunded",    delayMin: 1,   enabled: false,message: "{nome}, confirmei o reembolso do {produto} ({valor}). Chega na sua conta em ate 7 dias uteis.\n\nSe mudar de ideia, eh so me avisar!" }
];
function greennRulesLoad() {
  try { return JSON.parse(fs.readFileSync(GREENN_RULES_FILE, "utf8")); }
  catch { fs.writeFileSync(GREENN_RULES_FILE, JSON.stringify(GREENN_RULES_DEFAULTS, null, 2)); return GREENN_RULES_DEFAULTS.slice(); }
}
function greennRulesSave(arr) {
  try { fs.writeFileSync(GREENN_RULES_FILE, JSON.stringify(arr || [], null, 2)); } catch (e) { console.error("[greenn rules]", e?.message); }
}
function expandGreennTemplate(tpl, ev) {
  const first = String(ev.name || '').split(' ')[0] || '';
  const valor = (typeof ev.total === 'number' && ev.total > 0) ? ('R$ ' + ev.total.toFixed(2).replace('.', ',')) : '';
  return String(tpl || '')
    .replace(/\{nome\}/g, first)
    .replace(/\{produto\}/g, ev.productName || '')
    .replace(/\{valor\}/g, valor)
    .replace(/\{statusLabel\}/g, ev.statusLabel || '')
    .replace(/\{telefone\}/g, ev.phone || '');
}

app.post("/api/webhook/greenn", (req, res) => {
  try {
    // Auth opcional
    if (GREENN_TOKEN) {
      const sent = req.headers["x-webhook-token"] || req.headers["authorization"]?.replace(/^Bearer\s+/i, "") || req.query.token;
      if (sent !== GREENN_TOKEN) {
        return res.status(401).json({ ok: false, error: "token invalido" });
      }
    }
    const norm = normalizeGreennPayload(req.body);
    const arr = greennLoad();
    arr.push(norm);
    greennSave(arr);

    // v4.14: aplica regra de auto-follow-up se houver
    let autoScheduledId = null;
    try {
      if (norm.phone) {
        const rules = greennRulesLoad();
        const rule = rules.find(r => r.enabled && r.status === norm.status);
        if (rule && rule.message) {
          const expanded = expandGreennTemplate(rule.message, norm);
          const sendAt = Date.now() + (Number(rule.delayMin) || 0) * 60 * 1000;
          const schedArr = schedLoad();
          const item = {
            id: schedNewId(),
            phone: norm.phone,
            message: expanded,
            note: `[auto Greenn: ${norm.statusLabel}]`,
            sendAt,
            status: "pending",
            createdAt: Date.now(),
            sentAt: null,
            error: null,
            source: "greenn-auto",
            sourceStatus: norm.status,
            sourceProduct: norm.productName,
            sourceTransaction: norm.transactionId
          };
          schedArr.push(item);
          schedSave(schedArr);
          autoScheduledId = item.id;
          console.log(`[greenn-auto] agendou ${item.id} pra ${new Date(sendAt).toISOString()} (${norm.status})`);
        }
      }
    } catch (e) {
      console.error("[greenn-auto]", e?.message);
    }

    // Broadcast SSE pro frontend reagir
    broadcastSSE({
      type: "greenn_event",
      data: {
        event: norm.event,
        status: norm.status,
        statusLabel: norm.statusLabel,
        name: norm.name,
        phone: norm.phone,
        email: norm.email,
        productName: norm.productName,
        total: norm.total,
        currency: norm.currency,
        transactionId: norm.transactionId,
        receivedAt: norm.receivedAt,
        autoScheduledId
      }
    });
    res.json({ ok: true, normalized: { phone: norm.phone, name: norm.name, status: norm.status }, autoScheduledId });
  } catch (e) {
    console.error("[greenn webhook]", e?.message);
    res.status(500).json({ ok: false, error: e?.message });
  }
});

// v4.14: CRUD de regras
app.get("/api/integrations/greenn/rules", (req, res) => {
  res.json({ ok: true, rules: greennRulesLoad() });
});
app.put("/api/integrations/greenn/rules", (req, res) => {
  const arr = Array.isArray(req.body) ? req.body : req.body?.rules;
  if (!Array.isArray(arr)) return res.status(400).json({ ok: false, error: "body deve ser array de regras" });
  // sanitiza
  const clean = arr.map(r => ({
    status: String(r.status || '').toLowerCase(),
    delayMin: Math.max(0, Math.min(60 * 24, Number(r.delayMin) || 0)),
    enabled: !!r.enabled,
    message: String(r.message || '')
  })).filter(r => r.status && r.message);
  greennRulesSave(clean);
  res.json({ ok: true, rules: clean });
});

// v4.15: agrega metricas dos eventos Greenn (vendas, receita, conversao)
function greennMetrics() {
  const all = greennLoad();
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x.getTime(); };
  const today = startOfDay(now);
  const week = now - 7 * day;
  const month = now - 30 * day;

  const bucket = (filterFn) => {
    const arr = all.filter(filterFn);
    const paid = arr.filter(x => x.status === "paid" || x.status === "approved");
    const abandoned = arr.filter(x => x.status === "abandoned" || x.status === "checkoutabandoned");
    const refused = arr.filter(x => x.status === "refused" || x.status === "declined" || x.status === "failed");
    const refunded = arr.filter(x => x.status === "refunded" || x.status === "chargedback");
    const revenue = paid.reduce((s, x) => s + (Number(x.total) || 0), 0);
    return {
      total: arr.length,
      paid: paid.length,
      abandoned: abandoned.length,
      refused: refused.length,
      refunded: refunded.length,
      revenue: Math.round(revenue * 100) / 100,
      conversionPct: arr.length ? Math.round((paid.length / arr.length) * 1000) / 10 : 0,
      avgTicket: paid.length ? Math.round((revenue / paid.length) * 100) / 100 : 0
    };
  };

  // Top produtos (aprovados)
  const paidAll = all.filter(x => (x.status === "paid" || x.status === "approved") && x.productName);
  const byProduct = {};
  paidAll.forEach(x => {
    if (!byProduct[x.productName]) byProduct[x.productName] = { count: 0, revenue: 0 };
    byProduct[x.productName].count++;
    byProduct[x.productName].revenue += Number(x.total) || 0;
  });
  const topProducts = Object.keys(byProduct)
    .map(name => ({ name, count: byProduct[name].count, revenue: Math.round(byProduct[name].revenue * 100) / 100 }))
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 5);

  // Serie temporal ultimos 7 dias (pra mini grafico)
  const days7 = [];
  for (let i = 6; i >= 0; i--) {
    const dStart = startOfDay(now - i * day);
    const dEnd = dStart + day;
    const dayPaid = all.filter(x => x.receivedAt >= dStart && x.receivedAt < dEnd && (x.status === "paid" || x.status === "approved"));
    days7.push({
      date: new Date(dStart).toISOString().slice(0, 10),
      vendas: dayPaid.length,
      receita: Math.round(dayPaid.reduce((s, x) => s + (Number(x.total) || 0), 0) * 100) / 100
    });
  }

  return {
    totalEventos: all.length,
    hoje:      bucket(x => x.receivedAt >= today),
    ultimos7:  bucket(x => x.receivedAt >= week),
    ultimos30: bucket(x => x.receivedAt >= month),
    topProducts,
    days7
  };
}
app.get("/api/integrations/greenn/metrics", (req, res) => {
  res.json({ ok: true, metrics: greennMetrics() });
});

// Lista eventos recentes com filtros (pra UI de Integrações) - v4.16
function greennFilterEvents(events, q) {
  q = q || {};
  const search = String(q.search || '').toLowerCase().trim();
  const status = String(q.status || '').toLowerCase().trim();
  const product = String(q.product || '').toLowerCase().trim();
  const fromTs = Number(q.from) || 0;
  const toTs = Number(q.to) || Date.now() + 1;
  return events.filter(ev => {
    if (status && ev.status !== status) return false;
    if (product && !String(ev.productName || '').toLowerCase().includes(product)) return false;
    if (fromTs && ev.receivedAt < fromTs) return false;
    if (toTs && ev.receivedAt > toTs) return false;
    if (search) {
      const hay = [ev.name, ev.phone, ev.email, ev.productName, ev.statusLabel, ev.transactionId, ev.status]
        .join(' ').toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });
}
app.get("/api/integrations/greenn/events", (req, res) => {
  const arr = greennLoad();
  const filtered = greennFilterEvents(arr, req.query);
  const limit = Math.min(Number(req.query.limit) || 50, 500);
  res.json({ ok: true, total: arr.length, count: filtered.length, items: filtered.slice(-limit).reverse() });
});

// v4.16: Export CSV
app.get("/api/integrations/greenn/events.csv", (req, res) => {
  const arr = greennLoad();
  const filtered = greennFilterEvents(arr, req.query).slice().reverse();
  const esc = v => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const cols = ['receivedAt', 'status', 'statusLabel', 'name', 'phone', 'email', 'productName', 'total', 'currency', 'transactionId', 'event'];
  const lines = [cols.join(',')];
  filtered.forEach(ev => {
    const iso = ev.receivedAt ? new Date(ev.receivedAt).toISOString() : '';
    lines.push([iso, esc(ev.status), esc(ev.statusLabel), esc(ev.name), esc(ev.phone), esc(ev.email), esc(ev.productName), esc(ev.total), esc(ev.currency), esc(ev.transactionId), esc(ev.event)].join(','));
  });
  const csv = lines.join('\n');
  const today = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="greenn-events-${today}.csv"`);
  res.send('\uFEFF' + csv); // BOM pra Excel abrir com utf-8
});

// v4.16: Retry manual de agendamento que falhou (dispara de novo)
app.post("/api/scheduled/:id/retry", async (req, res) => {
  const arr = schedLoad();
  const idx = arr.findIndex(x => x.id === req.params.id);
  if (idx === -1) return res.status(404).json({ ok: false, error: "nao encontrado" });
  if (!['failed', 'sent'].includes(arr[idx].status)) return res.status(409).json({ ok: false, error: "so pode retry em failed/sent" });
  const orig = arr[idx];
  const clone = {
    id: schedNewId(),
    phone: orig.phone,
    message: orig.message,
    note: orig.note + ' (retry de ' + orig.id + ')',
    sendAt: Date.now() + 5000, // dispara em 5s
    status: 'pending',
    createdAt: Date.now(),
    sentAt: null,
    error: null,
    source: orig.source || 'manual-retry',
    retryOf: orig.id
  };
  arr.push(clone);
  schedSave(arr);
  res.json({ ok: true, item: clone });
});

// Status da config (sem revelar token)
app.get("/api/integrations/greenn/status", (req, res) => {
  res.json({
    ok: true,
    enabled: true,
    tokenConfigured: !!GREENN_TOKEN,
    webhookUrl: `${req.protocol}://${req.get("host")}/api/webhook/greenn`,
    eventsCount: greennLoad().length,
    storageFile: GREENN_FILE
  });
});

// ============================================================
// MENSAGENS AGENDADAS (v4.8) - storage JSON + worker interno
// ============================================================
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
