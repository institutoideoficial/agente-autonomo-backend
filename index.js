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
// INTEGRACAO KIWIFY (v4.20) - webhook + token + SSE
// ============================================================
const KIWIFY_FILE = process.env.KIWIFY_FILE || path.join(__dirname, "data", "kiwify-events.json");
const KIWIFY_TOKEN = process.env.KIWIFY_TOKEN || ""; // token configurado ao criar webhook na Kiwify
const KIWIFY_MAX_EVENTS = 200;
const KIWIFY_RULES_FILE = process.env.KIWIFY_RULES_FILE || path.join(__dirname, "data", "kiwify-rules.json");

function kiwifyLoad() { try { return JSON.parse(require("fs").readFileSync(KIWIFY_FILE, "utf8")); } catch { return []; } }
function kiwifySave(arr) { try { require("fs").writeFileSync(KIWIFY_FILE, JSON.stringify(arr.slice(-KIWIFY_MAX_EVENTS), null, 2)); } catch (e) { console.error("[kiwify]", e?.message); } }

function kiwifyMapStatus(event, orderStatus) {
  const e = String(event || "").toLowerCase();
  const s = String(orderStatus || "").toLowerCase();
  if (e.includes("compra_aprovada") || e === "order_approved" || s === "paid" || s === "approved") return "paid";
  if (e.includes("compra_recusada") || e === "order_refused" || s === "refused") return "refused";
  if (e.includes("compra_reembolsada") || e === "order_refunded" || s === "refunded") return "refunded";
  if (e === "chargeback" || s === "chargedback") return "chargedback";
  if (e.includes("boleto_gerado") || e === "billet_generated" || e.includes("pix_gerado") || e === "pix_generated" || s === "waiting_payment") return "pending";
  if (e.includes("carrinho_abandonado") || e === "cart_abandoned") return "abandoned";
  if (e === "subscription_canceled" || s === "canceled") return "cancelled";
  if (e === "subscription_late") return "expired";
  if (e === "subscription_renewed") return "paid";
  return "unknown";
}

function normalizeKiwifyPayload(raw) {
  raw = raw || {};
  const event = raw.webhook_event_type || raw.event || raw.event_type || "";
  const orderStatus = raw.order_status || raw.status || "";
  const Customer = raw.Customer || raw.customer || {};
  const Product = raw.Product || raw.product || {};
  const Commissions = raw.Commissions || raw.commissions || {};
  const Subscription = raw.Subscription || raw.subscription || {};

  const name = Customer.full_name || Customer.name || `${Customer.first_name || ""} ${Customer.last_name || ""}`.trim();
  const email = Customer.email || "";
  const phone = String(Customer.mobile || Customer.phone || Customer.cellphone || "").replace(/\D/g, "");

  const productName = Product.product_name || Product.name || "";
  const productId = Product.product_id || Product.id || "";

  // Kiwify envia valores em centavos
  const totalCents = Number(Commissions.charge_amount || Commissions.product_base_price || raw.total_value_cents || 0);
  const total = totalCents > 0 ? Math.round(totalCents) / 100 : Number(raw.total || 0);
  const currency = Commissions.currency_code || raw.currency || "BRL";

  const transactionId = raw.order_id || raw.order_ref || "";
  const paymentMethod = raw.payment_method || "";
  const installments = raw.installments || null;
  const boletoUrl = raw.boleto_URL || null;
  const pixCode = raw.pix_code || null;

  const status = kiwifyMapStatus(event, orderStatus);
  return {
    event: event || "unknown",
    type: "kiwify",
    status,
    statusLabel: greennStatusLabel(status),
    name, email, phone,
    productName, productId,
    total, currency,
    transactionId,
    paymentType: paymentMethod,
    installments,
    hasSubscription: !!Subscription.id,
    subscriptionStatus: Subscription.status || null,
    boletoUrl, pixCode,
    receivedAt: Date.now(),
    raw
  };
}

function kiwifyVerifyAuth(req) {
  if (!KIWIFY_TOKEN) return true; // sem token = modo aberto
  // Kiwify envia token em query ?signature= ou como campo no body, ou header
  const sent = req.query.signature || req.query.token ||
               (req.body && (req.body.token || req.body.signature)) ||
               req.headers["x-kiwify-signature"] || req.headers["x-kiwify-token"];
  return sent && sent === KIWIFY_TOKEN;
}

const KIWIFY_RULES_DEFAULTS = [
  { status: "paid",       delayMin: 1,  enabled: true,  message: "{nome}, pagamento aprovado na Kiwify! 🎉\n\nSeu acesso ao {produto} ({valor}) foi liberado. Link do curso chega no email em instantes.\n\nQualquer duvida, estou aqui." },
  { status: "pending",    delayMin: 30, enabled: true,  message: "Oi {nome}! Seu boleto/pix do {produto} foi gerado ({valor}). Quando pagar, libera na hora. Pix eh o mais rapido ✨" },
  { status: "abandoned",  delayMin: 15, enabled: true,  message: "{nome}, vi que voce comecou a compra do {produto} na Kiwify e parou. Posso te ajudar a finalizar? Ficou duvida no pagamento ou produto?" },
  { status: "refused",    delayMin: 5,  enabled: true,  message: "{nome}, o pagamento do {produto} nao foi aprovado. Vamos tentar outro metodo? Pix, outro cartao ou boleto." },
  { status: "expired",    delayMin: 5,  enabled: true,  message: "{nome}, seu boleto/pix do {produto} expirou. Quer que eu gere um novo? Pix cai em segundos." },
  { status: "refunded",   delayMin: 1,  enabled: false, message: "{nome}, reembolso confirmado ({valor}). Chega na sua conta em ate 7 dias.\n\nSe mudar de ideia, me avisa!" }
];
function kiwifyRulesLoad() {
  try { return JSON.parse(require("fs").readFileSync(KIWIFY_RULES_FILE, "utf8")); }
  catch { require("fs").writeFileSync(KIWIFY_RULES_FILE, JSON.stringify(KIWIFY_RULES_DEFAULTS, null, 2)); return KIWIFY_RULES_DEFAULTS.slice(); }
}
function kiwifyRulesSave(arr) { try { require("fs").writeFileSync(KIWIFY_RULES_FILE, JSON.stringify(arr || [], null, 2)); } catch (e) { console.error("[kiwify rules]", e?.message); } }

app.post("/api/webhook/kiwify", (req, res) => {
  try {
    if (!kiwifyVerifyAuth(req)) {
      return res.status(401).json({ ok: false, error: "token invalido" });
    }
    const norm = normalizeKiwifyPayload(req.body);
    const arr = kiwifyLoad();
    arr.push(norm);
    kiwifySave(arr);

    let autoScheduledId = null;
    try {
      if (norm.phone) {
        const rules = kiwifyRulesLoad();
        const rule = rules.find(r => r.enabled && r.status === norm.status);
        if (rule && rule.message) {
          const expanded = expandGreennTemplate(rule.message, norm);
          const sendAt = Date.now() + (Number(rule.delayMin) || 0) * 60 * 1000;
          const schedArr = schedLoad();
          const item = {
            id: schedNewId(),
            phone: norm.phone, message: expanded,
            note: `[auto Kiwify: ${norm.statusLabel}]`,
            sendAt, status: "pending", createdAt: Date.now(), sentAt: null, error: null,
            source: "kiwify-auto",
            sourceStatus: norm.status, sourceProduct: norm.productName, sourceTransaction: norm.transactionId
          };
          schedArr.push(item);
          schedSave(schedArr);
          autoScheduledId = item.id;
          console.log(`[kiwify-auto] agendou ${item.id} (${norm.status})`);
        }
      }
    } catch (e) { console.error("[kiwify-auto]", e?.message); }

    broadcastSSE({
      type: "kiwify_event",
      data: {
        event: norm.event, status: norm.status, statusLabel: norm.statusLabel,
        name: norm.name, phone: norm.phone, email: norm.email,
        productName: norm.productName, total: norm.total, currency: norm.currency,
        transactionId: norm.transactionId, paymentType: norm.paymentType,
        installments: norm.installments, boletoUrl: norm.boletoUrl, pixCode: norm.pixCode,
        receivedAt: norm.receivedAt, autoScheduledId
      }
    });
    res.json({ ok: true, normalized: { phone: norm.phone, name: norm.name, status: norm.status, event: norm.event }, autoScheduledId });
  } catch (e) {
    console.error("[kiwify webhook]", e?.message);
    res.status(500).json({ ok: false, error: e?.message });
  }
});

function kiwifyMetrics() {
  const all = kiwifyLoad();
  const now = Date.now(), day = 24 * 60 * 60 * 1000;
  const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x.getTime(); };
  const today = startOfDay(now), week = now - 7 * day, month = now - 30 * day;
  const bucket = (filterFn) => {
    const arr = all.filter(filterFn);
    const paid = arr.filter(x => x.status === "paid");
    const abandoned = arr.filter(x => x.status === "abandoned");
    const refused = arr.filter(x => x.status === "refused");
    const expired = arr.filter(x => x.status === "expired");
    const refunded = arr.filter(x => x.status === "refunded" || x.status === "chargedback");
    const revenue = paid.reduce((s, x) => s + (Number(x.total) || 0), 0);
    return {
      total: arr.length, paid: paid.length, abandoned: abandoned.length,
      refused: refused.length, expired: expired.length, refunded: refunded.length,
      revenue: Math.round(revenue * 100) / 100,
      conversionPct: arr.length ? Math.round((paid.length / arr.length) * 1000) / 10 : 0,
      avgTicket: paid.length ? Math.round((revenue / paid.length) * 100) / 100 : 0
    };
  };
  const paidAll = all.filter(x => x.status === "paid" && x.productName);
  const byProduct = {};
  paidAll.forEach(x => {
    if (!byProduct[x.productName]) byProduct[x.productName] = { count: 0, revenue: 0 };
    byProduct[x.productName].count++;
    byProduct[x.productName].revenue += Number(x.total) || 0;
  });
  const topProducts = Object.keys(byProduct)
    .map(name => ({ name, count: byProduct[name].count, revenue: Math.round(byProduct[name].revenue * 100) / 100 }))
    .sort((a, b) => b.revenue - a.revenue).slice(0, 5);
  const days7 = [];
  for (let i = 6; i >= 0; i--) {
    const dStart = startOfDay(now - i * day), dEnd = dStart + day;
    const dayPaid = all.filter(x => x.receivedAt >= dStart && x.receivedAt < dEnd && x.status === "paid");
    days7.push({ date: new Date(dStart).toISOString().slice(0, 10), vendas: dayPaid.length, receita: Math.round(dayPaid.reduce((s, x) => s + (Number(x.total) || 0), 0) * 100) / 100 });
  }
  return { totalEventos: all.length, hoje: bucket(x => x.receivedAt >= today), ultimos7: bucket(x => x.receivedAt >= week), ultimos30: bucket(x => x.receivedAt >= month), topProducts, days7 };
}

function kiwifyFilterEvents(events, q) {
  q = q || {};
  const search = String(q.search || '').toLowerCase().trim();
  const status = String(q.status || '').toLowerCase().trim();
  const product = String(q.product || '').toLowerCase().trim();
  return events.filter(ev => {
    if (status && ev.status !== status) return false;
    if (product && !String(ev.productName || '').toLowerCase().includes(product)) return false;
    if (search) {
      const hay = [ev.name, ev.phone, ev.email, ev.productName, ev.statusLabel, ev.transactionId, ev.status, ev.event].join(' ').toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });
}

app.get("/api/integrations/kiwify/events", (req, res) => {
  const arr = kiwifyLoad();
  const filtered = kiwifyFilterEvents(arr, req.query);
  const limit = Math.min(Number(req.query.limit) || 50, 500);
  res.json({ ok: true, total: arr.length, count: filtered.length, items: filtered.slice(-limit).reverse() });
});
app.get("/api/integrations/kiwify/events.csv", (req, res) => {
  const arr = kiwifyLoad();
  const filtered = kiwifyFilterEvents(arr, req.query).slice().reverse();
  const esc = v => { if (v === null || v === undefined) return ''; const s = String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const cols = ['receivedAt', 'event', 'status', 'statusLabel', 'name', 'phone', 'email', 'productName', 'total', 'currency', 'transactionId', 'paymentType', 'installments'];
  const lines = [cols.join(',')];
  filtered.forEach(ev => {
    const iso = ev.receivedAt ? new Date(ev.receivedAt).toISOString() : '';
    lines.push([iso, esc(ev.event), esc(ev.status), esc(ev.statusLabel), esc(ev.name), esc(ev.phone), esc(ev.email), esc(ev.productName), esc(ev.total), esc(ev.currency), esc(ev.transactionId), esc(ev.paymentType), esc(ev.installments)].join(','));
  });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="kiwify-events-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send('\uFEFF' + lines.join('\n'));
});
app.get("/api/integrations/kiwify/status", (req, res) => {
  res.json({
    ok: true, enabled: true,
    tokenConfigured: !!KIWIFY_TOKEN,
    webhookUrl: `${req.protocol}://${req.get("host")}/api/webhook/kiwify`,
    eventsCount: kiwifyLoad().length, storageFile: KIWIFY_FILE
  });
});
app.get("/api/integrations/kiwify/metrics", (req, res) => { res.json({ ok: true, metrics: kiwifyMetrics() }); });
app.get("/api/integrations/kiwify/rules", (req, res) => { res.json({ ok: true, rules: kiwifyRulesLoad() }); });
app.put("/api/integrations/kiwify/rules", (req, res) => {
  const arr = Array.isArray(req.body) ? req.body : req.body?.rules;
  if (!Array.isArray(arr)) return res.status(400).json({ ok: false, error: "body deve ser array" });
  const clean = arr.map(r => ({ status: String(r.status || '').toLowerCase(), delayMin: Math.max(0, Math.min(60 * 24, Number(r.delayMin) || 0)), enabled: !!r.enabled, message: String(r.message || '') })).filter(r => r.status && r.message);
  kiwifyRulesSave(clean);
  res.json({ ok: true, rules: clean });
});

// ============================================================
// INTEGRACAO HOTMART (v4.19) - webhook v2 + hottok/HMAC + SSE
// ============================================================
const HOTMART_FILE = process.env.HOTMART_FILE || path.join(__dirname, "data", "hotmart-events.json");
const HOTMART_HOTTOK = process.env.HOTMART_HOTTOK || ""; // token do produtor (payload.hottok)
const HOTMART_HMAC_SECRET = process.env.HOTMART_HMAC_SECRET || ""; // HMAC opcional
const HOTMART_MAX_EVENTS = 200;
const HOTMART_RULES_FILE = process.env.HOTMART_RULES_FILE || path.join(__dirname, "data", "hotmart-rules.json");

function hotmartLoad() { try { return JSON.parse(require("fs").readFileSync(HOTMART_FILE, "utf8")); } catch { return []; } }
function hotmartSave(arr) { try { require("fs").writeFileSync(HOTMART_FILE, JSON.stringify(arr.slice(-HOTMART_MAX_EVENTS), null, 2)); } catch (e) { console.error("[hotmart]", e?.message); } }

// Mapeia event Hotmart v2 -> status interno comum
function hotmartMapStatus(event) {
  const e = String(event || "").toUpperCase();
  if (e === "PURCHASE_APPROVED" || e === "PURCHASE_COMPLETE") return "paid";
  if (e === "PURCHASE_DELAYED" || e === "PURCHASE_BILLET_PRINTED") return "pending";
  if (e === "PURCHASE_REFUNDED") return "refunded";
  if (e === "PURCHASE_CHARGEBACK" || e === "PURCHASE_PROTEST") return "chargedback";
  if (e === "PURCHASE_CANCELED") return "cancelled";
  if (e === "PURCHASE_EXPIRED") return "expired";
  if (e === "PURCHASE_OUT_OF_SHOPPING_CART") return "abandoned";
  if (e === "SUBSCRIPTION_CANCELLATION") return "cancelled";
  if (e === "SWITCH_PLAN") return "pending"; // mudou plano, aguardando
  return "unknown";
}

function normalizeHotmartPayload(raw) {
  raw = raw || {};
  const event = raw.event || raw.event_name || "";
  const d = raw.data || raw;
  const buyer = d.buyer || {};
  const product = d.product || {};
  const purchase = d.purchase || d.transaction || {};
  const subscription = d.subscription || {};

  const name = buyer.name || buyer.full_name || "";
  const email = buyer.email || "";
  // Telefone: tenta checkout_phone direto OU monta a partir de buyer.phone
  let phone = String(buyer.checkout_phone || "").replace(/\D/g, "");
  if (!phone && buyer.phone) {
    const p = buyer.phone;
    phone = [p.country_code, p.area_code, p.number].map(x => String(x || "").replace(/\D/g, "")).join("");
  }
  if (!phone && buyer.document_phone) phone = String(buyer.document_phone).replace(/\D/g, "");

  const productName = product.name || product.title || "";
  const productId = product.id || product.ucode || "";
  const priceVal = Number(purchase.price?.value || purchase.value || 0);
  const priceCur = purchase.price?.currency_value || purchase.currency || "BRL";
  const transId = purchase.transaction || purchase.id || "";
  const paymentType = purchase.payment?.type || "";
  const installments = purchase.payment?.installments_number || null;

  const status = hotmartMapStatus(event);
  return {
    event: event || "unknown",
    type: "hotmart",
    status,
    statusLabel: greennStatusLabel(status),
    name, email, phone,
    productName, productId,
    total: priceVal,
    currency: priceCur,
    transactionId: transId,
    paymentType, installments,
    hasSubscription: !!subscription.status,
    subscriptionStatus: subscription.status || null,
    receivedAt: Date.now(),
    raw
  };
}

function hotmartVerifyAuth(req) {
  // 1. Se HOTMART_HOTTOK setado, verifica no body.hottok OU query ?hottok=
  if (HOTMART_HOTTOK) {
    const sent = (req.body && req.body.hottok) || req.query.hottok || req.headers["x-hotmart-hottok"];
    if (sent && sent === HOTMART_HOTTOK) return true;
    if (!HOTMART_HMAC_SECRET) return false; // so tem hottok config, e nao bateu
  }
  // 2. Se HOTMART_HMAC_SECRET setado, verifica header x-hotmart-hmac-sha256
  if (HOTMART_HMAC_SECRET) {
    const sig = req.headers["x-hotmart-hmac-sha256"] || req.headers["x-signature"] || "";
    if (!sig) return false;
    const body = JSON.stringify(req.body || {});
    const expected = crypto.createHmac("sha256", HOTMART_HMAC_SECRET).update(body).digest("hex");
    try { return crypto.timingSafeEqual(Buffer.from(sig, "utf8"), Buffer.from(expected, "utf8")); } catch { return false; }
  }
  // 3. Nem hottok nem HMAC configurados = modo aberto
  return true;
}

const HOTMART_RULES_DEFAULTS = [
  { status: "paid",       delayMin: 1,  enabled: true,  message: "{nome}, matricula aprovada na Hotmart! 🎉\n\nSeu acesso ao {produto} ({valor}) chega em instantes no email. Qualquer duvida me chama aqui.\n\nBora? ✨" },
  { status: "pending",    delayMin: 30, enabled: true,  message: "Oi {nome}! Vi que voce gerou um boleto/pix pra {produto}. Qualquer coisa com o pagamento, me chama que resolvo aqui. Pix cai na hora ✨" },
  { status: "abandoned",  delayMin: 15, enabled: true,  message: "{nome}, vi que voce comecou o checkout do {produto} na Hotmart. Ficou alguma duvida? Posso te ajudar a finalizar - Pix, cartao ou boleto." },
  { status: "expired",    delayMin: 5,  enabled: true,  message: "{nome}, seu boleto do {produto} venceu. Quer que eu gere um novo ou prefere Pix (cai na hora)?" },
  { status: "refunded",   delayMin: 1,  enabled: false, message: "{nome}, reembolso confirmado ({valor}). Chega na sua conta em ate 7 dias uteis.\n\nSe mudar de ideia, eh so me avisar!" },
  { status: "chargedback",delayMin: 0,  enabled: false, message: "{nome}, identifiquei chargeback no {produto}. Vamos conversar? Estou aqui se quiser entender algo." }
];
function hotmartRulesLoad() {
  try { return JSON.parse(require("fs").readFileSync(HOTMART_RULES_FILE, "utf8")); }
  catch { require("fs").writeFileSync(HOTMART_RULES_FILE, JSON.stringify(HOTMART_RULES_DEFAULTS, null, 2)); return HOTMART_RULES_DEFAULTS.slice(); }
}
function hotmartRulesSave(arr) { try { require("fs").writeFileSync(HOTMART_RULES_FILE, JSON.stringify(arr || [], null, 2)); } catch (e) { console.error("[hotmart rules]", e?.message); } }

app.post("/api/webhook/hotmart", (req, res) => {
  try {
    if (!hotmartVerifyAuth(req)) {
      return res.status(401).json({ ok: false, error: "autenticacao invalida (hottok/HMAC)" });
    }
    const norm = normalizeHotmartPayload(req.body);
    const arr = hotmartLoad();
    arr.push(norm);
    hotmartSave(arr);

    let autoScheduledId = null;
    try {
      if (norm.phone) {
        const rules = hotmartRulesLoad();
        const rule = rules.find(r => r.enabled && r.status === norm.status);
        if (rule && rule.message) {
          const expanded = expandGreennTemplate(rule.message, norm);
          const sendAt = Date.now() + (Number(rule.delayMin) || 0) * 60 * 1000;
          const schedArr = schedLoad();
          const item = {
            id: schedNewId(),
            phone: norm.phone,
            message: expanded,
            note: `[auto Hotmart: ${norm.statusLabel}]`,
            sendAt,
            status: "pending",
            createdAt: Date.now(),
            sentAt: null,
            error: null,
            source: "hotmart-auto",
            sourceStatus: norm.status,
            sourceProduct: norm.productName,
            sourceTransaction: norm.transactionId
          };
          schedArr.push(item);
          schedSave(schedArr);
          autoScheduledId = item.id;
          console.log(`[hotmart-auto] agendou ${item.id} (${norm.status})`);
        }
      }
    } catch (e) { console.error("[hotmart-auto]", e?.message); }

    broadcastSSE({
      type: "hotmart_event",
      data: {
        event: norm.event, status: norm.status, statusLabel: norm.statusLabel,
        name: norm.name, phone: norm.phone, email: norm.email,
        productName: norm.productName, total: norm.total, currency: norm.currency,
        transactionId: norm.transactionId, paymentType: norm.paymentType,
        installments: norm.installments, receivedAt: norm.receivedAt, autoScheduledId
      }
    });
    res.json({ ok: true, normalized: { phone: norm.phone, name: norm.name, status: norm.status, event: norm.event }, autoScheduledId });
  } catch (e) {
    console.error("[hotmart webhook]", e?.message);
    res.status(500).json({ ok: false, error: e?.message });
  }
});

function hotmartMetrics() {
  const all = hotmartLoad();
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x.getTime(); };
  const today = startOfDay(now), week = now - 7 * day, month = now - 30 * day;
  const bucket = (filterFn) => {
    const arr = all.filter(filterFn);
    const paid = arr.filter(x => x.status === "paid");
    const abandoned = arr.filter(x => x.status === "abandoned");
    const refused = arr.filter(x => x.status === "refused");
    const expired = arr.filter(x => x.status === "expired");
    const refunded = arr.filter(x => x.status === "refunded" || x.status === "chargedback");
    const revenue = paid.reduce((s, x) => s + (Number(x.total) || 0), 0);
    return {
      total: arr.length, paid: paid.length, abandoned: abandoned.length,
      refused: refused.length, expired: expired.length, refunded: refunded.length,
      revenue: Math.round(revenue * 100) / 100,
      conversionPct: arr.length ? Math.round((paid.length / arr.length) * 1000) / 10 : 0,
      avgTicket: paid.length ? Math.round((revenue / paid.length) * 100) / 100 : 0
    };
  };
  const paidAll = all.filter(x => x.status === "paid" && x.productName);
  const byProduct = {};
  paidAll.forEach(x => {
    if (!byProduct[x.productName]) byProduct[x.productName] = { count: 0, revenue: 0 };
    byProduct[x.productName].count++;
    byProduct[x.productName].revenue += Number(x.total) || 0;
  });
  const topProducts = Object.keys(byProduct)
    .map(name => ({ name, count: byProduct[name].count, revenue: Math.round(byProduct[name].revenue * 100) / 100 }))
    .sort((a, b) => b.revenue - a.revenue).slice(0, 5);
  const days7 = [];
  for (let i = 6; i >= 0; i--) {
    const dStart = startOfDay(now - i * day), dEnd = dStart + day;
    const dayPaid = all.filter(x => x.receivedAt >= dStart && x.receivedAt < dEnd && x.status === "paid");
    days7.push({ date: new Date(dStart).toISOString().slice(0, 10), vendas: dayPaid.length, receita: Math.round(dayPaid.reduce((s, x) => s + (Number(x.total) || 0), 0) * 100) / 100 });
  }
  return { totalEventos: all.length, hoje: bucket(x => x.receivedAt >= today), ultimos7: bucket(x => x.receivedAt >= week), ultimos30: bucket(x => x.receivedAt >= month), topProducts, days7 };
}

function hotmartFilterEvents(events, q) {
  q = q || {};
  const search = String(q.search || '').toLowerCase().trim();
  const status = String(q.status || '').toLowerCase().trim();
  const product = String(q.product || '').toLowerCase().trim();
  return events.filter(ev => {
    if (status && ev.status !== status) return false;
    if (product && !String(ev.productName || '').toLowerCase().includes(product)) return false;
    if (search) {
      const hay = [ev.name, ev.phone, ev.email, ev.productName, ev.statusLabel, ev.transactionId, ev.status, ev.event].join(' ').toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });
}

app.get("/api/integrations/hotmart/events", (req, res) => {
  const arr = hotmartLoad();
  const filtered = hotmartFilterEvents(arr, req.query);
  const limit = Math.min(Number(req.query.limit) || 50, 500);
  res.json({ ok: true, total: arr.length, count: filtered.length, items: filtered.slice(-limit).reverse() });
});
app.get("/api/integrations/hotmart/events.csv", (req, res) => {
  const arr = hotmartLoad();
  const filtered = hotmartFilterEvents(arr, req.query).slice().reverse();
  const esc = v => { if (v === null || v === undefined) return ''; const s = String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const cols = ['receivedAt', 'event', 'status', 'statusLabel', 'name', 'phone', 'email', 'productName', 'total', 'currency', 'transactionId', 'paymentType', 'installments'];
  const lines = [cols.join(',')];
  filtered.forEach(ev => {
    const iso = ev.receivedAt ? new Date(ev.receivedAt).toISOString() : '';
    lines.push([iso, esc(ev.event), esc(ev.status), esc(ev.statusLabel), esc(ev.name), esc(ev.phone), esc(ev.email), esc(ev.productName), esc(ev.total), esc(ev.currency), esc(ev.transactionId), esc(ev.paymentType), esc(ev.installments)].join(','));
  });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="hotmart-events-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send('\uFEFF' + lines.join('\n'));
});
app.get("/api/integrations/hotmart/status", (req, res) => {
  res.json({
    ok: true, enabled: true,
    hottokConfigured: !!HOTMART_HOTTOK,
    hmacConfigured: !!HOTMART_HMAC_SECRET,
    webhookUrl: `${req.protocol}://${req.get("host")}/api/webhook/hotmart`,
    eventsCount: hotmartLoad().length, storageFile: HOTMART_FILE
  });
});
app.get("/api/integrations/hotmart/metrics", (req, res) => { res.json({ ok: true, metrics: hotmartMetrics() }); });
app.get("/api/integrations/hotmart/rules", (req, res) => { res.json({ ok: true, rules: hotmartRulesLoad() }); });
app.put("/api/integrations/hotmart/rules", (req, res) => {
  const arr = Array.isArray(req.body) ? req.body : req.body?.rules;
  if (!Array.isArray(arr)) return res.status(400).json({ ok: false, error: "body deve ser array" });
  const clean = arr.map(r => ({ status: String(r.status || '').toLowerCase(), delayMin: Math.max(0, Math.min(60 * 24, Number(r.delayMin) || 0)), enabled: !!r.enabled, message: String(r.message || '') })).filter(r => r.status && r.message);
  hotmartRulesSave(clean);
  res.json({ ok: true, rules: clean });
});

// ============================================================
// INTEGRACAO EDUZZ (v4.18) - webhook v1 (flat) + v3 (HMAC) + SSE
// ============================================================
const crypto = require("crypto");
const EDUZZ_FILE = process.env.EDUZZ_FILE || path.join(__dirname, "data", "eduzz-events.json");
const EDUZZ_HMAC_SECRET = process.env.EDUZZ_HMAC_SECRET || ""; // v3
const EDUZZ_ORIGIN_SECRET = process.env.EDUZZ_ORIGIN_SECRET || ""; // v1
const EDUZZ_MAX_EVENTS = 200;
const EDUZZ_RULES_FILE = process.env.EDUZZ_RULES_FILE || path.join(__dirname, "data", "eduzz-rules.json");

function eduzzLoad() { try { return JSON.parse(fs.readFileSync(EDUZZ_FILE, "utf8")); } catch { return []; } }
function eduzzSave(arr) { try { fs.writeFileSync(EDUZZ_FILE, JSON.stringify(arr.slice(-EDUZZ_MAX_EVENTS), null, 2)); } catch (e) { console.error("[eduzz]", e?.message); } }

// Mapeia event_name (ou trans_status numerico) Eduzz -> status interno comum
function eduzzMapStatus(eventName, transStatus) {
  const e = String(eventName || "").toLowerCase();
  // Mapeamento por nome de evento (tanto v1 quanto v3)
  if (e === "invoice_paid" || e === "contract_paid" || e.endsWith("_paid")) return "paid";
  if (e === "invoice_refused" || e.includes("refused")) return "refused";
  if (e === "invoice_refund" || e.includes("refund")) return "refunded";
  if (e === "invoice_chargeback" || e.includes("chargeback")) return "chargedback";
  if (e === "invoice_expired" || e.includes("expired")) return "expired";
  if (e === "invoice_canceled" || e.includes("cancel")) return "cancelled";
  if (e === "invoice_waiting_payment" || e.includes("waiting")) return "pending";
  if (e === "invoice_open" || e === "contract_open") return "pending";
  if (e === "cart_abandonment" || e.includes("abandon")) return "abandoned";
  // Fallback por trans_status (v1 numerico)
  // 1 ou 3 = pago na Eduzz legacy
  const s = Number(transStatus);
  if (s === 1 || s === 3) return "paid";
  if (s === 2) return "pending";
  if (s === 4) return "refused";
  if (s === 7) return "refunded";
  return e || "unknown";
}

function normalizeEduzzPayload(raw) {
  raw = raw || {};
  // Detecta v1 (flat com cus_*/product_*/trans_*) vs v3 (nested .data)
  const isFlat = ("cus_email" in raw) || ("cus_name" in raw) || ("trans_cod" in raw) || ("product_cod" in raw);
  const eventName = raw.event_name || raw.event || raw.type || (raw.data && (raw.data.event || raw.data.event_name)) || "";

  let name, email, phone, cel, productName, productCod, transValue, transStatus, transCod, paidAt;
  if (isFlat) {
    name        = raw.cus_name || "";
    email       = raw.cus_email || "";
    cel         = raw.cus_cel || raw.cus_tel || "";
    phone       = String(cel || "").replace(/\D/g, "");
    productName = raw.product_name || "";
    productCod  = raw.product_cod || raw.product_id || "";
    transValue  = Number(raw.trans_value || raw.trans_paid || 0);
    transStatus = raw.trans_status;
    transCod    = raw.trans_cod || raw.trans_id || "";
    paidAt      = raw.trans_paiddate && raw.trans_paidtime ? `${raw.trans_paiddate}T${raw.trans_paidtime}` : null;
  } else {
    // v3: estrutura aninhada (tenta varios paths)
    const d = raw.data || raw;
    const cus = d.customer || d.cus || d.client || {};
    const prod = d.product || d.products?.[0] || d.item || {};
    const trans = d.transaction || d.trans || d.invoice || d;
    name        = cus.name || cus.full_name || "";
    email       = cus.email || "";
    cel         = cus.cellphone || cus.phone || cus.cel || cus.mobile || "";
    phone       = String(cel || "").replace(/\D/g, "");
    productName = prod.name || prod.title || "";
    productCod  = prod.id || prod.code || prod.cod || "";
    transValue  = Number(trans.value || trans.amount || trans.total || 0);
    transStatus = trans.status;
    transCod    = trans.id || trans.code || trans.cod || "";
    paidAt      = trans.paid_at || trans.paidAt || null;
  }

  const status = eduzzMapStatus(eventName, transStatus);
  return {
    event: eventName || "unknown",
    type: "eduzz",
    status,
    statusLabel: greennStatusLabel(status), // reusa labels (mesmo mapping)
    name, email, phone,
    productName,
    productCod,
    total: transValue,
    currency: "BRL",
    transactionId: transCod,
    paidAt,
    receivedAt: Date.now(),
    raw
  };
}

function eduzzVerifyHmac(req) {
  if (!EDUZZ_HMAC_SECRET) return true; // sem secret = aceita
  const sig = req.headers["x-signature"] || req.headers["x-eduzz-signature"] || "";
  if (!sig) return false;
  const body = JSON.stringify(req.body || {});
  const expected = crypto.createHmac("sha256", EDUZZ_HMAC_SECRET).update(body).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(sig, "utf8"), Buffer.from(expected, "utf8"));
}
function eduzzVerifyOrigin(body) {
  if (!EDUZZ_ORIGIN_SECRET) return true;
  return body && body.origin_secret === EDUZZ_ORIGIN_SECRET;
}

// Regras auto-follow-up Eduzz (independentes das Greenn)
const EDUZZ_RULES_DEFAULTS = [
  { status: "paid",       delayMin: 1,  enabled: true,  message: "{nome}, que felicidade ter voce! 🌟\n\nSua matricula em {produto} foi aprovada! ({valor})\n\nAcesso em instantes. Qualquer duvida me chama por aqui.\n\nBora transformar sua oratoria? ✨" },
  { status: "abandoned",  delayMin: 15, enabled: true,  message: "Oi {nome}! Vi que voce comecou a compra do {produto} e parou no meio. Precisa de ajuda? Pix, cartao parcelado ou boleto, resolvo por aqui." },
  { status: "refused",    delayMin: 5,  enabled: true,  message: "{nome}, o pagamento do {produto} nao foi aprovado. Quer tentar outro metodo? Tenho Pix, outro cartao ou boleto." },
  { status: "expired",    delayMin: 5,  enabled: true,  message: "{nome}, seu boleto do {produto} venceu. Quer que eu gere um novo? Tambem tenho Pix que cai na hora." },
  { status: "refunded",   delayMin: 1,  enabled: false, message: "{nome}, reembolso do {produto} ({valor}) confirmado. Chega na sua conta em ate 7 dias uteis.\n\nSe mudar de ideia, eh so me chamar!" }
];
function eduzzRulesLoad() {
  try { return JSON.parse(fs.readFileSync(EDUZZ_RULES_FILE, "utf8")); }
  catch { fs.writeFileSync(EDUZZ_RULES_FILE, JSON.stringify(EDUZZ_RULES_DEFAULTS, null, 2)); return EDUZZ_RULES_DEFAULTS.slice(); }
}
function eduzzRulesSave(arr) { try { fs.writeFileSync(EDUZZ_RULES_FILE, JSON.stringify(arr || [], null, 2)); } catch (e) { console.error("[eduzz rules]", e?.message); } }

app.post("/api/webhook/eduzz", (req, res) => {
  try {
    // Auth: v3 HMAC OU v1 origin_secret
    const okHmac = eduzzVerifyHmac(req);
    const okOrigin = eduzzVerifyOrigin(req.body);
    if (!okHmac && !okOrigin) {
      return res.status(401).json({ ok: false, error: "assinatura invalida" });
    }
    const norm = normalizeEduzzPayload(req.body);
    const arr = eduzzLoad();
    arr.push(norm);
    eduzzSave(arr);

    // auto-follow-up
    let autoScheduledId = null;
    try {
      if (norm.phone) {
        const rules = eduzzRulesLoad();
        const rule = rules.find(r => r.enabled && r.status === norm.status);
        if (rule && rule.message) {
          const expanded = expandGreennTemplate(rule.message, norm); // reusa expandGreennTemplate (mesmo shape)
          const sendAt = Date.now() + (Number(rule.delayMin) || 0) * 60 * 1000;
          const schedArr = schedLoad();
          const item = {
            id: schedNewId(),
            phone: norm.phone,
            message: expanded,
            note: `[auto Eduzz: ${norm.statusLabel}]`,
            sendAt,
            status: "pending",
            createdAt: Date.now(),
            sentAt: null,
            error: null,
            source: "eduzz-auto",
            sourceStatus: norm.status,
            sourceProduct: norm.productName,
            sourceTransaction: norm.transactionId
          };
          schedArr.push(item);
          schedSave(schedArr);
          autoScheduledId = item.id;
          console.log(`[eduzz-auto] agendou ${item.id} pra ${new Date(sendAt).toISOString()} (${norm.status})`);
        }
      }
    } catch (e) { console.error("[eduzz-auto]", e?.message); }

    broadcastSSE({
      type: "eduzz_event",
      data: {
        event: norm.event, status: norm.status, statusLabel: norm.statusLabel,
        name: norm.name, phone: norm.phone, email: norm.email,
        productName: norm.productName, total: norm.total, currency: norm.currency,
        transactionId: norm.transactionId, receivedAt: norm.receivedAt, autoScheduledId
      }
    });
    res.json({ ok: true, normalized: { phone: norm.phone, name: norm.name, status: norm.status }, autoScheduledId });
  } catch (e) {
    console.error("[eduzz webhook]", e?.message);
    res.status(500).json({ ok: false, error: e?.message });
  }
});

function eduzzMetrics() {
  const all = eduzzLoad();
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x.getTime(); };
  const today = startOfDay(now), week = now - 7 * day, month = now - 30 * day;
  const bucket = (filterFn) => {
    const arr = all.filter(filterFn);
    const paid = arr.filter(x => x.status === "paid");
    const abandoned = arr.filter(x => x.status === "abandoned");
    const refused = arr.filter(x => x.status === "refused");
    const expired = arr.filter(x => x.status === "expired");
    const refunded = arr.filter(x => x.status === "refunded" || x.status === "chargedback");
    const revenue = paid.reduce((s, x) => s + (Number(x.total) || 0), 0);
    return {
      total: arr.length, paid: paid.length, abandoned: abandoned.length,
      refused: refused.length, expired: expired.length, refunded: refunded.length,
      revenue: Math.round(revenue * 100) / 100,
      conversionPct: arr.length ? Math.round((paid.length / arr.length) * 1000) / 10 : 0,
      avgTicket: paid.length ? Math.round((revenue / paid.length) * 100) / 100 : 0
    };
  };
  const paidAll = all.filter(x => x.status === "paid" && x.productName);
  const byProduct = {};
  paidAll.forEach(x => {
    if (!byProduct[x.productName]) byProduct[x.productName] = { count: 0, revenue: 0 };
    byProduct[x.productName].count++;
    byProduct[x.productName].revenue += Number(x.total) || 0;
  });
  const topProducts = Object.keys(byProduct)
    .map(name => ({ name, count: byProduct[name].count, revenue: Math.round(byProduct[name].revenue * 100) / 100 }))
    .sort((a, b) => b.revenue - a.revenue).slice(0, 5);
  const days7 = [];
  for (let i = 6; i >= 0; i--) {
    const dStart = startOfDay(now - i * day), dEnd = dStart + day;
    const dayPaid = all.filter(x => x.receivedAt >= dStart && x.receivedAt < dEnd && x.status === "paid");
    days7.push({
      date: new Date(dStart).toISOString().slice(0, 10),
      vendas: dayPaid.length,
      receita: Math.round(dayPaid.reduce((s, x) => s + (Number(x.total) || 0), 0) * 100) / 100
    });
  }
  return { totalEventos: all.length, hoje: bucket(x => x.receivedAt >= today), ultimos7: bucket(x => x.receivedAt >= week), ultimos30: bucket(x => x.receivedAt >= month), topProducts, days7 };
}

function eduzzFilterEvents(events, q) {
  q = q || {};
  const search = String(q.search || '').toLowerCase().trim();
  const status = String(q.status || '').toLowerCase().trim();
  const product = String(q.product || '').toLowerCase().trim();
  return events.filter(ev => {
    if (status && ev.status !== status) return false;
    if (product && !String(ev.productName || '').toLowerCase().includes(product)) return false;
    if (search) {
      const hay = [ev.name, ev.phone, ev.email, ev.productName, ev.statusLabel, ev.transactionId, ev.status].join(' ').toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });
}

app.get("/api/integrations/eduzz/events", (req, res) => {
  const arr = eduzzLoad();
  const filtered = eduzzFilterEvents(arr, req.query);
  const limit = Math.min(Number(req.query.limit) || 50, 500);
  res.json({ ok: true, total: arr.length, count: filtered.length, items: filtered.slice(-limit).reverse() });
});
app.get("/api/integrations/eduzz/events.csv", (req, res) => {
  const arr = eduzzLoad();
  const filtered = eduzzFilterEvents(arr, req.query).slice().reverse();
  const esc = v => { if (v === null || v === undefined) return ''; const s = String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const cols = ['receivedAt', 'status', 'statusLabel', 'name', 'phone', 'email', 'productName', 'total', 'currency', 'transactionId', 'event'];
  const lines = [cols.join(',')];
  filtered.forEach(ev => {
    const iso = ev.receivedAt ? new Date(ev.receivedAt).toISOString() : '';
    lines.push([iso, esc(ev.status), esc(ev.statusLabel), esc(ev.name), esc(ev.phone), esc(ev.email), esc(ev.productName), esc(ev.total), esc(ev.currency), esc(ev.transactionId), esc(ev.event)].join(','));
  });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="eduzz-events-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send('\uFEFF' + lines.join('\n'));
});
app.get("/api/integrations/eduzz/status", (req, res) => {
  res.json({
    ok: true, enabled: true,
    hmacConfigured: !!EDUZZ_HMAC_SECRET,
    originSecretConfigured: !!EDUZZ_ORIGIN_SECRET,
    webhookUrl: `${req.protocol}://${req.get("host")}/api/webhook/eduzz`,
    eventsCount: eduzzLoad().length, storageFile: EDUZZ_FILE
  });
});
app.get("/api/integrations/eduzz/metrics", (req, res) => { res.json({ ok: true, metrics: eduzzMetrics() }); });
app.get("/api/integrations/eduzz/rules", (req, res) => { res.json({ ok: true, rules: eduzzRulesLoad() }); });
app.put("/api/integrations/eduzz/rules", (req, res) => {
  const arr = Array.isArray(req.body) ? req.body : req.body?.rules;
  if (!Array.isArray(arr)) return res.status(400).json({ ok: false, error: "body deve ser array" });
  const clean = arr.map(r => ({ status: String(r.status || '').toLowerCase(), delayMin: Math.max(0, Math.min(60 * 24, Number(r.delayMin) || 0)), enabled: !!r.enabled, message: String(r.message || '') })).filter(r => r.status && r.message);
  eduzzRulesSave(clean);
  res.json({ ok: true, rules: clean });
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
