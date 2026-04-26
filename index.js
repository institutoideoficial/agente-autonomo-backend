// SPEAKERS CRM Backend - integrado com Bravos WhatsApp API
const express = require("express");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk");
const platformUtils = require('./lib/platform-utils');

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
    const r = await fetch(`${BRAVOS_URL}/health`, { headers: { "bypass-tunnel-reminder": "true", "User-Agent": "imperador-crm" } });
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

    // v4.23: se Cloud API configurada, usa ela. Senao, Bravos (whatsapp-web.js).
    if (process.env.WA_CLOUD_TOKEN && process.env.WA_CLOUD_PHONE_ID) {
      try {
        const result = await waCloudSendMessage(clean, message);
        return res.json({ ok: true, source: "wa-cloud", messageId: result.messages?.[0]?.id, raw: result });
      } catch (e) {
        return res.status(500).json({ ok: false, source: "wa-cloud", error: e?.message });
      }
    }

    // Fallback Bravos
    const chatId = clean.includes("@") ? clean : `${clean}@c.us`;
    const r = await fetch(`${BRAVOS_URL}/send-message`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${BRAVOS_TOKEN}`, "bypass-tunnel-reminder": "true", "User-Agent": "imperador-crm",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ chatId, message: String(message) })
    });
    const data = await r.json();
    res.status(r.status).json({ source: "bravos", ...data });
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
// ============================================================
// GOOGLE AUTO-EVENT (v4.27) - cria evento Calendar quando paid
// ============================================================
const GOOGLE_AUTO_EVENT_ENABLED = process.env.GOOGLE_AUTO_EVENT === "true";
const GOOGLE_AUTO_EVENT_DELAY_HOURS = Number(process.env.GOOGLE_AUTO_EVENT_DELAY_HOURS || 24);
const GOOGLE_AUTO_EVENT_DURATION_MIN = Number(process.env.GOOGLE_AUTO_EVENT_DURATION_MIN || 30);
const GOOGLE_AUTO_EVENT_TITLE_TPL = process.env.GOOGLE_AUTO_EVENT_TITLE_TPL || "Welcome - {produto} - {nome}";

async function tryGoogleAutoEvent(norm) {
  if (!GOOGLE_AUTO_EVENT_ENABLED) return null;
  if (!norm || norm.status !== "paid") return null;
  try {
    const t = googleLoadTokens();
    if (!t || !t.access_token) {
      console.log("[google-auto-event] sem tokens - pula");
      return null;
    }
    const startDate = new Date(Date.now() + GOOGLE_AUTO_EVENT_DELAY_HOURS * 60 * 60 * 1000);
    // arredonda pra hora cheia
    startDate.setMinutes(0, 0, 0);
    const endDate = new Date(startDate.getTime() + GOOGLE_AUTO_EVENT_DURATION_MIN * 60 * 1000);
    const title = GOOGLE_AUTO_EVENT_TITLE_TPL
      .replace(/\{produto\}/g, norm.productName || "Curso")
      .replace(/\{nome\}/g, norm.name || "Aluno")
      .replace(/\{plataforma\}/g, norm.type || "");
    const valor = norm.total ? `R$ ${Number(norm.total).toFixed(2)}` : "";
    const description = `Aluno: ${norm.name || "?"}
WhatsApp: ${norm.phone || "?"}
Email: ${norm.email || "?"}
Produto: ${norm.productName || "?"} (${norm.type || "?"})
Transacao: ${norm.transactionId || "?"} ${valor}

[criado automaticamente pelo CRM Imperador ao receber compra aprovada]`;
    const body = {
      summary: title,
      description,
      start: { dateTime: startDate.toISOString(), timeZone: "America/Sao_Paulo" },
      end:   { dateTime: endDate.toISOString(),   timeZone: "America/Sao_Paulo" },
      attendees: norm.email ? [{ email: norm.email, displayName: norm.name || undefined }] : undefined,
      conferenceData: {
        createRequest: {
          requestId: "imp-auto-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8),
          conferenceSolutionKey: { type: "hangoutsMeet" }
        }
      },
      extendedProperties: {
        private: {
          crmPhone: norm.phone || "",
          crmSource: norm.type || "",
          crmTransaction: norm.transactionId || ""
        }
      }
    };
    const r = await googleApiFetch("/calendar/v3/calendars/primary/events?conferenceDataVersion=1&sendUpdates=all", {
      method: "POST", body: JSON.stringify(body)
    });
    const d = await r.json();
    if (!r.ok) { console.error("[google-auto-event] erro", d.error?.message || r.status); return null; }
    const meetLink = d.conferenceData?.entryPoints?.find(x => x.entryPointType === "video")?.uri || d.hangoutLink;
    console.log(`[google-auto-event] OK ${d.id} -> ${meetLink || d.htmlLink}`);
    broadcastSSE({
      type: "google_event_created",
      data: { eventId: d.id, htmlLink: d.htmlLink, meetLink, summary: d.summary, source: norm.type, phone: norm.phone }
    });
    return { id: d.id, htmlLink: d.htmlLink, meetLink };
  } catch (e) {
    console.error("[google-auto-event]", e?.message);
    return null;
  }
}

app.get("/api/integrations/google/auto-event/status", (req, res) => {
  res.json({
    ok: true,
    enabled: GOOGLE_AUTO_EVENT_ENABLED,
    delayHours: GOOGLE_AUTO_EVENT_DELAY_HOURS,
    durationMin: GOOGLE_AUTO_EVENT_DURATION_MIN,
    titleTemplate: GOOGLE_AUTO_EVENT_TITLE_TPL,
    googleConnected: !!(googleLoadTokens()?.access_token),
    note: GOOGLE_AUTO_EVENT_ENABLED
      ? "Quando webhook receber status=paid, evento Calendar com Meet eh criado automaticamente."
      : "Desativado. Setar env GOOGLE_AUTO_EVENT=true e restart pra ativar."
  });
});

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
    tryGoogleAutoEvent(norm).catch(()=>{});

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
  return platformUtils.computeMetrics(greennLoad(), {
    paidStatuses: ["paid","approved"],
    abandonedStatuses: ["abandoned","checkoutabandoned"]
  });
}
app.get("/api/integrations/greenn/metrics", (req, res) => {
  res.json({ ok: true, metrics: greennMetrics() });
});

// Lista eventos recentes com filtros (pra UI de Integrações) - v4.16
function greennFilterEvents(events, q) {
  return platformUtils.filterEvents(events, q);
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
// IA SUGESTÃO DE RESPOSTA (v4.26) - Claude rascunha, Vanessa revisa
// ============================================================
const SPEAKERS_SYSTEM_PROMPT = `Voce eh assistente de WhatsApp da Vanessa Labastie, mentora de oratoria da Speakers Play Academy.

Seu trabalho: SUGERIR um rascunho de resposta breve, calorosa e profissional (max 80 palavras) que a Vanessa pode editar antes de enviar.

Tom: pessoal, calorosa, direta, sem floreios. Como uma mentora gentil falando 1-a-1.
Contexto da Vanessa:
- Speakers Play Academy: formacao de oratoria
- NeuroHeart: metodo proprio
- Livro: "A Ciencia do Ser Integral"
- Atende alunos por WhatsApp, sem equipe

Regras:
- Se o aluno mandou pergunta, responda direto (nao floreie)
- Se eh uma duvida tecnica que voce nao tem certeza, pergunte mais detalhes
- Se eh feedback positivo, agradece e estimula compartilhar
- Sem emojis exagerados (max 1)
- Termina com algo acionavel (link, proximo passo, pergunta)
- NUNCA finja ser a Vanessa - voce eh um rascunho pra ela revisar
- Linguagem simples (PT-BR informal mas educado)`;

app.post("/api/ai/suggest", async (req, res) => {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return res.status(503).json({ ok: false, error: "ANTHROPIC_API_KEY nao configurada no servidor. Adicione no .env e restart." });
    }
    const { messages, contactName, productContext } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ ok: false, error: "messages[] obrigatorio" });
    }
    // Limita historico ao ultimo 20 msgs (controla custo + foco)
    const recent = messages.slice(-20);
    const conversationContext = recent.map(m => {
      const who = (m.r === "out" || m.r === "a" || m.fromMe) ? "Vanessa" : (contactName || "Aluno");
      return `${who}: ${m.t || m.text || m.body || ""}`;
    }).join("\n");

    const userPrompt = `Historico recente da conversa com ${contactName || "aluno(a)"}${productContext ? ` (comprou: ${productContext})` : ""}:

${conversationContext}

Gere APENAS o rascunho de resposta da Vanessa pra mandar agora (texto puro, sem aspas, sem prefixo "Vanessa:").`;

    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 300,
      system: SPEAKERS_SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt }]
    });
    const suggestion = response.content?.[0]?.text?.trim() || "(sem sugestao)";
    res.json({
      ok: true,
      suggestion,
      tokens: { input: response.usage?.input_tokens || 0, output: response.usage?.output_tokens || 0 }
    });
  } catch (e) {
    console.error("[ai-suggest]", e?.message);
    res.status(500).json({ ok: false, error: e?.message });
  }
});

app.get("/api/ai/status", (req, res) => {
  res.json({
    ok: true,
    configured: !!process.env.ANTHROPIC_API_KEY,
    model: "claude-haiku-4-5"
  });
});

// ============================================================
// WEBHOOK GENERICO (v4.24) - Zapier/Make/n8n/qualquer
// ============================================================
const GENERIC_FILE = process.env.GENERIC_FILE || path.join(__dirname, "data", "generic-events.json");
const GENERIC_TOKEN = process.env.GENERIC_TOKEN || "";
const GENERIC_MAX = 200;
function genericLoad() { try { return JSON.parse(require("fs").readFileSync(GENERIC_FILE, "utf8")); } catch { return []; } }
function genericSave(arr) { try { require("fs").writeFileSync(GENERIC_FILE, JSON.stringify(arr.slice(-GENERIC_MAX), null, 2)); } catch (e) { console.error("[generic]", e?.message); } }

function normalizeGenericPayload(raw, query) {
  raw = raw || {}; query = query || {};
  function findKey(obj, ...keys) {
    if (!obj || typeof obj !== "object") return null;
    const lk = keys.map(k => k.toLowerCase());
    for (const k of Object.keys(obj)) if (lk.includes(k.toLowerCase()) && obj[k] != null && obj[k] !== "") return obj[k];
    for (const k of Object.keys(obj)) if (typeof obj[k] === "object") { const v = findKey(obj[k], ...keys); if (v !== null) return v; }
    return null;
  }
  const phoneRaw = query.phone || findKey(raw, "phone","telephone","cellphone","whatsapp","mobile","celular","tel","checkout_phone","cus_cel");
  const name = query.name || findKey(raw, "name","full_name","nome","fullname","customer_name") || "";
  const email = query.email || findKey(raw, "email","mail") || "";
  const productName = query.product || findKey(raw, "product_name","product","item","title","produto") || "";
  const total = Number(query.total || findKey(raw, "total","value","amount","price","valor") || 0);
  const status = String(query.status || findKey(raw, "status","state","event_status") || "received").toLowerCase();
  const transactionId = query.transactionId || findKey(raw, "id","transaction_id","order_id","transaction") || null;
  const event = query.event || findKey(raw, "event","event_name","type") || "generic";
  return {
    event, type: "generic", status, statusLabel: greennStatusLabel(status),
    name, email, phone: String(phoneRaw || "").replace(/\D/g, ""),
    productName, total, currency: "BRL", transactionId,
    receivedAt: Date.now(), raw
  };
}

app.post("/api/webhook/generic", (req, res) => {
  try {
    if (GENERIC_TOKEN) {
      const sent = req.query.token || req.headers["x-webhook-token"] || req.headers["authorization"]?.replace(/^Bearer\s+/i, "");
      if (sent !== GENERIC_TOKEN) return res.status(401).json({ ok: false, error: "token invalido" });
    }
    const norm = normalizeGenericPayload(req.body, req.query);
    const arr = genericLoad(); arr.push(norm); genericSave(arr);
    tryGoogleAutoEvent(norm).catch(()=>{});
    broadcastSSE({ type: "generic_event", data: { ...norm, raw: undefined } });
    res.json({ ok: true, normalized: { phone: norm.phone, name: norm.name, status: norm.status, event: norm.event } });
  } catch (e) { console.error("[generic webhook]", e?.message); res.status(500).json({ ok: false, error: e?.message }); }
});
app.get("/api/webhook/generic", (req, res) => {
  if (Object.keys(req.query).length === 0) return res.status(400).json({ ok: false, error: "POST com JSON ou GET com query string" });
  if (GENERIC_TOKEN && req.query.token !== GENERIC_TOKEN) return res.status(401).json({ ok: false, error: "token invalido" });
  const norm = normalizeGenericPayload({}, req.query);
  const arr = genericLoad(); arr.push(norm); genericSave(arr);
    tryGoogleAutoEvent(norm).catch(()=>{});
  broadcastSSE({ type: "generic_event", data: { ...norm, raw: undefined } });
  res.json({ ok: true, normalized: { phone: norm.phone, status: norm.status } });
});
app.get("/api/integrations/generic/status", (req, res) => {
  res.json({
    ok: true, enabled: true, tokenConfigured: !!GENERIC_TOKEN,
    webhookUrl: `${req.protocol}://${req.get("host")}/api/webhook/generic`,
    eventsCount: genericLoad().length,
    examples: {
      curl: `curl -X POST '${req.protocol}://${req.get("host")}/api/webhook/generic' -H 'Content-Type: application/json' -d '{"name":"Joao","phone":"5511999999999","status":"paid","product":"Curso X","total":497}'`,
      queryUrl: `${req.protocol}://${req.get("host")}/api/webhook/generic?phone=5511999999999&name=Joao&status=paid&product=Curso&total=497`
    }
  });
});
app.get("/api/integrations/generic/events", (req, res) => {
  const arr = genericLoad();
  const limit = Math.min(Number(req.query.limit) || 50, 500);
  res.json({ ok: true, count: arr.length, items: arr.slice(-limit).reverse() });
});

// ============================================================
// CONTATOS / BULK / IA TEMPLATES / AUTO-ARCHIVE (v4.31)
// ============================================================

// Helper: agrega contatos unicos cross-plataforma
function aggregateContacts() {
  const fsLib = require('fs');
  function tryLoad(file) { try { return JSON.parse(fsLib.readFileSync(file, 'utf8')); } catch { return []; } }
  const sources = [
    ['greenn', GREENN_FILE], ['eduzz', EDUZZ_FILE], ['hotmart', HOTMART_FILE],
    ['kiwify', KIWIFY_FILE], ['generic', GENERIC_FILE]
  ];
  const byPhone = {};
  sources.forEach(([source, f]) => {
    tryLoad(f).forEach(ev => {
      if (!ev.phone) return;
      const k = ev.phone;
      if (!byPhone[k]) byPhone[k] = {
        phone: ev.phone, name: ev.name || '', email: ev.email || '',
        events: 0, paid: 0, totalValue: 0, products: {},
        sources: {}, firstSeenAt: ev.receivedAt || 0, lastSeenAt: 0,
        statuses: {}
      };
      const c = byPhone[k];
      c.events++;
      if (ev.name && (!c.name || c.name.length < ev.name.length)) c.name = ev.name;
      if (ev.email && !c.email) c.email = ev.email;
      c.sources[source] = (c.sources[source] || 0) + 1;
      if (ev.status) c.statuses[ev.status] = (c.statuses[ev.status] || 0) + 1;
      if (ev.status === 'paid' || ev.status === 'approved') {
        c.paid++;
        c.totalValue += Number(ev.total) || 0;
      }
      if (ev.productName) c.products[ev.productName] = (c.products[ev.productName] || 0) + 1;
      if (ev.receivedAt && ev.receivedAt < c.firstSeenAt) c.firstSeenAt = ev.receivedAt;
      if (ev.receivedAt > c.lastSeenAt) c.lastSeenAt = ev.receivedAt;
    });
  });
  return Object.values(byPhone)
    .map(c => ({ ...c, totalValue: Math.round(c.totalValue * 100) / 100 }))
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
}

app.get("/api/contacts", (req, res) => {
  const all = aggregateContacts();
  const search = String(req.query.search || '').toLowerCase().trim();
  const filtered = search
    ? all.filter(c => [c.name, c.phone, c.email].join(' ').toLowerCase().includes(search))
    : all;
  const limit = Math.min(Number(req.query.limit) || 100, 1000);
  res.json({ ok: true, total: all.length, count: filtered.length, items: filtered.slice(0, limit) });
});

app.get("/api/contacts.csv", (req, res) => {
  const all = aggregateContacts();
  const flat = all.map(c => ({
    phone: c.phone, name: c.name, email: c.email,
    events: c.events, paid: c.paid, totalValue: c.totalValue,
    sources: Object.keys(c.sources).join('|'),
    topProduct: Object.keys(c.products).sort((a,b)=>c.products[b]-c.products[a])[0] || '',
    firstSeenAt: c.firstSeenAt ? new Date(c.firstSeenAt).toISOString() : '',
    lastSeenAt: c.lastSeenAt ? new Date(c.lastSeenAt).toISOString() : ''
  }));
  const csv = platformUtils.eventsToCSV(flat, ['phone','name','email','events','paid','totalValue','sources','topProduct','firstSeenAt','lastSeenAt']);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="contatos-${new Date().toISOString().slice(0,10)}.csv"`);
  res.send(csv);
});

// === BULK SEND com rate limit (anti-ban) ===
const BULK_RATE_PER_DAY = Number(process.env.BULK_RATE_PER_DAY || 30);
const BULK_DELAY_SEC = Number(process.env.BULK_DELAY_SEC || 60);
let _bulkSentToday = []; // { sentAt }

app.post("/api/bulk-send", async (req, res) => {
  try {
    const { recipients, message, dryRun } = req.body || {};
    if (!Array.isArray(recipients) || recipients.length === 0) return res.status(400).json({ ok: false, error: "recipients[] obrigatorio" });
    if (!message) return res.status(400).json({ ok: false, error: "message obrigatorio" });

    // Rate limit diario
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    _bulkSentToday = _bulkSentToday.filter(s => s.sentAt > dayAgo);
    const remaining = BULK_RATE_PER_DAY - _bulkSentToday.length;
    if (recipients.length > remaining) {
      return res.status(429).json({ ok: false, error: `Limite diario (${BULK_RATE_PER_DAY}) excedido. Restante hoje: ${remaining}.` });
    }

    if (dryRun) {
      return res.json({ ok: true, dryRun: true, wouldSend: recipients.length, remainingToday: remaining, scheduledIds: [] });
    }

    // Agenda envios espacados pelo schedSave (worker existente cuida)
    const arr = schedLoad();
    const ids = [];
    const now = Date.now();
    recipients.forEach((phone, i) => {
      const cleanPhone = String(phone).replace(/\D/g, '');
      if (!cleanPhone) return;
      const item = {
        id: schedNewId(),
        phone: cleanPhone,
        message: String(message),
        note: '[bulk-send]',
        sendAt: now + (i * BULK_DELAY_SEC * 1000),
        status: 'pending',
        createdAt: now, sentAt: null, error: null,
        source: 'bulk-send'
      };
      arr.push(item);
      ids.push(item.id);
      _bulkSentToday.push({ sentAt: now });
    });
    schedSave(arr);
    res.json({ ok: true, scheduledCount: ids.length, scheduledIds: ids, spreadOverMin: Math.ceil(recipients.length * BULK_DELAY_SEC / 60), remainingToday: remaining - ids.length });
  } catch (e) { res.status(500).json({ ok: false, error: e?.message }); }
});

app.get("/api/bulk-send/status", (req, res) => {
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  _bulkSentToday = _bulkSentToday.filter(s => s.sentAt > dayAgo);
  res.json({ ok: true, sentToday: _bulkSentToday.length, dailyLimit: BULK_RATE_PER_DAY, remainingToday: BULK_RATE_PER_DAY - _bulkSentToday.length, delayBetweenMsgsSec: BULK_DELAY_SEC });
});

// === IA TEMPLATE SUGGEST (gera novo template via Claude) ===
app.post("/api/ai/template-suggest", async (req, res) => {
  try {
    if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ ok: false, error: "ANTHROPIC_API_KEY nao configurada" });
    const { status, platform, productHint, tone } = req.body || {};
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const prompt = `Voce eh assistente da Vanessa Labastie da Speakers Play Academy (formacao em oratoria, NeuroHeart). Gere UM template curto de WhatsApp pra responder automaticamente quando:
- Plataforma: ${platform || "qualquer"}
- Status do evento: ${status || "qualquer"}
${productHint ? '- Contexto produto: ' + productHint : ''}
- Tom: ${tone || "calorosa, profissional, max 70 palavras"}

Use variaveis {nome}, {produto}, {valor}, {hora} onde fizer sentido.
Responda APENAS o texto do template, sem aspas, sem comentarios.`;
    const resp = await client.messages.create({
      model: "claude-haiku-4-5", max_tokens: 300,
      messages: [{ role: "user", content: prompt }]
    });
    const suggestion = resp.content?.[0]?.text?.trim() || "";
    res.json({ ok: true, template: suggestion, model: "claude-haiku-4-5" });
  } catch (e) { res.status(500).json({ ok: false, error: e?.message }); }
});

// === AUTO-ARCHIVE (cron interno: marca conv inativa >30d) ===
// Como o frontend gerencia isArchived em localStorage, esse endpoint expoe lista
// de telefones candidatos a arquivar baseado em ultima atividade nos webhooks.
app.get("/api/auto-archive/candidates", (req, res) => {
  const days = Math.max(7, Math.min(365, Number(req.query.days) || 30));
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const all = aggregateContacts();
  const candidates = all.filter(c => c.lastSeenAt < cutoff && c.lastSeenAt > 0);
  res.json({ ok: true, days, cutoff, total: all.length, candidates: candidates.length, items: candidates.slice(0, 200) });
});

// ============================================================
// INSIGHTS / HEALTH / EXPORT (v4.29)
// ============================================================
const SERVER_BOOT_AT = Date.now();

app.get("/api/insights/health", async (req, res) => {
  try {
    const fsLib = require('fs');
    let bravosOk = false, bravosState = null;
    try {
      const r = await fetch(`${BRAVOS_URL}/health`, { signal: AbortSignal.timeout(8000), headers: { "bypass-tunnel-reminder": "true", "User-Agent": "imperador-crm" } });
      const d = await r.json();
      bravosOk = !!d.isReady;
      bravosState = { isReady: d.isReady, isAuthenticated: d.isAuthenticated, hasQr: d.hasQr, uptimeSec: d.uptimeSec };
    } catch (e) { bravosState = { error: e.message }; }
    function tryLoad(file) { try { return JSON.parse(fsLib.readFileSync(file, 'utf8')); } catch { return []; } }
    const greenn = tryLoad(GREENN_FILE).length;
    const eduzz  = tryLoad(EDUZZ_FILE).length;
    const hotmart= tryLoad(HOTMART_FILE).length;
    const kiwify = tryLoad(KIWIFY_FILE).length;
    const generic= tryLoad(GENERIC_FILE).length;
    const waCloud= tryLoad(WA_CLOUD_FILE).length;
    const scheduled = (typeof schedLoad === 'function' ? schedLoad() : []);
    res.json({
      ok: true,
      crm: { uptimeSec: Math.round((Date.now() - SERVER_BOOT_AT) / 1000), version: "v4.32", bootAt: new Date(SERVER_BOOT_AT).toISOString() },
      bravos: { ok: bravosOk, ...bravosState, url: BRAVOS_URL },
      ai: { configured: !!process.env.ANTHROPIC_API_KEY },
      google: { configured: !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET), connected: !!(googleLoadTokens()?.access_token), autoEvent: GOOGLE_AUTO_EVENT_ENABLED },
      events: { total: greenn + eduzz + hotmart + kiwify + generic + waCloud, greenn, eduzz, hotmart, kiwify, generic, waCloud },
      scheduled: { total: scheduled.length, pending: scheduled.filter(s => s.status === 'pending').length, sent: scheduled.filter(s => s.status === 'sent').length, failed: scheduled.filter(s => s.status === 'failed').length },
      sse: { connectedClients: sseClients.size }
    });
  } catch (e) { res.status(500).json({ ok: false, error: e?.message }); }
});

app.get("/api/export/all.csv", (req, res) => {
  try {
    const fsLib = require('fs');
    function tryLoad(file) { try { return JSON.parse(fsLib.readFileSync(file, 'utf8')); } catch { return []; } }
    const all = [];
    [['greenn', GREENN_FILE], ['eduzz', EDUZZ_FILE], ['hotmart', HOTMART_FILE], ['kiwify', KIWIFY_FILE], ['generic', GENERIC_FILE]]
      .forEach(([source, f]) => tryLoad(f).forEach(e => all.push({ source, ...e })));
    all.sort((a, b) => (b.receivedAt || 0) - (a.receivedAt || 0));
    const csv = platformUtils.eventsToCSV(all, ['receivedAt', 'source', 'event', 'status', 'statusLabel', 'name', 'phone', 'email', 'productName', 'total', 'currency', 'transactionId', 'paymentType', 'installments']);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="imperador-all-events-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
  } catch (e) { res.status(500).json({ ok: false, error: e?.message }); }
});

// ============================================================
// INTEGRACAO WHATSAPP CLOUD API (v4.23) - Meta oficial
// ============================================================
const WA_CLOUD_TOKEN = process.env.WA_CLOUD_TOKEN || "";
const WA_CLOUD_PHONE_ID = process.env.WA_CLOUD_PHONE_ID || "";
const WA_CLOUD_VERIFY_TOKEN = process.env.WA_CLOUD_VERIFY_TOKEN || "imperador-verify-2026";
const WA_CLOUD_API_VERSION = process.env.WA_CLOUD_API_VERSION || "v20.0";
const WA_CLOUD_FILE = process.env.WA_CLOUD_FILE || path.join(__dirname, "data", "wa-cloud-events.json");
const WA_CLOUD_MAX = 200;

function waCloudLoad() { try { return JSON.parse(require("fs").readFileSync(WA_CLOUD_FILE, "utf8")); } catch { return []; } }
function waCloudSave(arr) { try { require("fs").writeFileSync(WA_CLOUD_FILE, JSON.stringify(arr.slice(-WA_CLOUD_MAX), null, 2)); } catch (e) { console.error("[wa-cloud]", e?.message); } }
function waCloudConfigured() { return !!(WA_CLOUD_TOKEN && WA_CLOUD_PHONE_ID); }

// GET /api/webhook/wa-cloud - handshake do Meta
app.get("/api/webhook/wa-cloud", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === WA_CLOUD_VERIFY_TOKEN) {
    console.log("[wa-cloud] webhook verificado");
    return res.status(200).send(challenge);
  }
  return res.status(403).send("Forbidden");
});

// POST /api/webhook/wa-cloud - recebe mensagens
app.post("/api/webhook/wa-cloud", (req, res) => {
  try {
    const body = req.body || {};
    // Meta envia: { entry: [{ changes: [{ value: { messages, contacts, statuses } }] }] }
    const entry = (body.entry || [])[0];
    const change = (entry?.changes || [])[0];
    const value = change?.value || {};
    const messages = value.messages || [];
    const contacts = value.contacts || [];
    const statuses = value.statuses || [];
    const arr = waCloudLoad();

    // Processa mensagens recebidas
    messages.forEach(msg => {
      const from = msg.from; // numero do remetente
      const contact = contacts.find(c => c.wa_id === from) || {};
      const name = contact.profile?.name || from;
      let text = "";
      if (msg.type === "text") text = msg.text?.body || "";
      else if (msg.type === "image") text = "[imagem]" + (msg.image?.caption ? " " + msg.image.caption : "");
      else if (msg.type === "audio") text = "[audio]";
      else if (msg.type === "video") text = "[video]" + (msg.video?.caption ? " " + msg.video.caption : "");
      else if (msg.type === "document") text = "[documento]";
      else if (msg.type === "location") text = "[localizacao]";
      else if (msg.type === "sticker") text = "[sticker]";
      else text = "[" + msg.type + "]";

      const evt = {
        type: "message_in",
        receivedAt: Date.now(),
        from: from,
        name: name,
        text: text,
        msgType: msg.type,
        messageId: msg.id,
        timestamp: msg.timestamp,
        raw: msg
      };
      arr.push(evt);

      // Broadcast SSE no formato compativel (igual Bravos)
      broadcastSSE({
        type: "message_in",
        data: {
          chat_id: from + "@c.us",
          from_id: from,
          body: text,
          type: msg.type,
          from_me: 0,
          direction: "in",
          timestamp: msg.timestamp ? Number(msg.timestamp) * 1000 : Date.now(),
          pushname: name,
          message_id: msg.id
        },
        clientId: "wa-cloud",
        timestamp: Date.now()
      });
    });

    // Processa status (delivered/read/failed)
    statuses.forEach(s => {
      arr.push({
        type: "status",
        receivedAt: Date.now(),
        messageId: s.id,
        recipient: s.recipient_id,
        status: s.status,
        timestamp: s.timestamp,
        raw: s
      });
      broadcastSSE({
        type: "wa_cloud_status",
        data: { messageId: s.id, recipient: s.recipient_id, status: s.status, timestamp: s.timestamp }
      });
    });

    waCloudSave(arr);
    res.status(200).send("OK");
  } catch (e) {
    console.error("[wa-cloud webhook]", e?.message);
    res.status(500).json({ ok: false, error: e?.message });
  }
});

// Envia mensagem via Cloud API
async function waCloudSendMessage(phone, message) {
  if (!waCloudConfigured()) throw new Error("Cloud API nao configurada");
  const cleanPhone = String(phone).replace(/\D/g, "");
  const r = await fetch(`https://graph.facebook.com/${WA_CLOUD_API_VERSION}/${WA_CLOUD_PHONE_ID}/messages`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${WA_CLOUD_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: cleanPhone,
      type: "text",
      text: { body: String(message) }
    })
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error?.message || `HTTP ${r.status}`);
  return d;
}

// Status / config / events / test
app.get("/api/integrations/wa-cloud/status", (req, res) => {
  res.json({
    ok: true,
    configured: waCloudConfigured(),
    phoneId: WA_CLOUD_PHONE_ID || null,
    apiVersion: WA_CLOUD_API_VERSION,
    webhookUrl: `${req.protocol}://${req.get("host")}/api/webhook/wa-cloud`,
    verifyToken: WA_CLOUD_VERIFY_TOKEN,
    eventsCount: waCloudLoad().length
  });
});
app.get("/api/integrations/wa-cloud/events", (req, res) => {
  const arr = waCloudLoad();
  const limit = Math.min(Number(req.query.limit) || 50, 500);
  res.json({ ok: true, count: arr.length, items: arr.slice(-limit).reverse() });
});
app.post("/api/integrations/wa-cloud/test", async (req, res) => {
  try {
    const { phone, message } = req.body || {};
    if (!phone || !message) return res.status(400).json({ ok: false, error: "phone e message obrigatorios" });
    const result = await waCloudSendMessage(phone, message);
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message });
  }
});

// ============================================================
// INTEGRACAO GOOGLE CALENDAR + MEET (v4.21) - OAuth 2.0
// ============================================================
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || ""; // ex: http://localhost:3000/oauth/google/callback
const GOOGLE_TOKENS_FILE = process.env.GOOGLE_TOKENS_FILE || path.join(__dirname, "data", "google-tokens.json");
const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile"
].join(" ");

function googleLoadTokens() { try { return JSON.parse(require("fs").readFileSync(GOOGLE_TOKENS_FILE, "utf8")); } catch { return null; } }
function googleSaveTokens(t) { try { require("fs").writeFileSync(GOOGLE_TOKENS_FILE, JSON.stringify(t || null, null, 2)); } catch (e) { console.error("[google tokens]", e?.message); } }
function googleConfigured() { return !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET); }
function googleRedirectUri(req) { return GOOGLE_REDIRECT_URI || `${req.protocol}://${req.get("host")}/oauth/google/callback`; }

async function googleRefreshAccessToken() {
  const t = googleLoadTokens();
  if (!t || !t.refresh_token) throw new Error("sem refresh_token (reconecte)");
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: t.refresh_token,
      grant_type: "refresh_token"
    })
  });
  const d = await r.json();
  if (!r.ok) throw new Error(`refresh falhou: ${d.error_description || d.error || r.status}`);
  const next = {
    ...t,
    access_token: d.access_token,
    expires_at: Date.now() + (Number(d.expires_in) || 3600) * 1000,
    // refresh_token pode vir novo ou ficar o mesmo
    refresh_token: d.refresh_token || t.refresh_token
  };
  googleSaveTokens(next);
  return next;
}

async function googleApiFetch(urlPath, opts = {}) {
  let t = googleLoadTokens();
  if (!t || !t.access_token) throw new Error("nao conectado");
  if (!t.expires_at || t.expires_at < Date.now() + 30 * 1000) {
    t = await googleRefreshAccessToken();
  }
  const url = urlPath.startsWith("http") ? urlPath : `https://www.googleapis.com${urlPath}`;
  const headers = { "Authorization": `Bearer ${t.access_token}`, "Content-Type": "application/json", ...(opts.headers || {}) };
  let r = await fetch(url, { ...opts, headers });
  if (r.status === 401) {
    // token invalido, tenta refresh 1x
    t = await googleRefreshAccessToken();
    headers["Authorization"] = `Bearer ${t.access_token}`;
    r = await fetch(url, { ...opts, headers });
  }
  return r;
}

// --- Rotas OAuth ---
app.get("/oauth/google/authorize", (req, res) => {
  if (!googleConfigured()) {
    return res.status(400).send(`<h2>Google nao configurado</h2>
      <p>Configure as variaveis de ambiente GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET.</p>
      <p>Veja docs/GOOGLE_SETUP.md no repo pra criar no Google Cloud Console.</p>`);
  }
  const state = crypto.randomBytes(16).toString("hex");
  res.cookie?.("google_oauth_state", state, { httpOnly: true, maxAge: 10 * 60 * 1000 });
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: googleRedirectUri(req),
    response_type: "code",
    scope: GOOGLE_SCOPES,
    access_type: "offline",
    prompt: "consent",
    state,
    include_granted_scopes: "true"
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

app.get("/oauth/google/callback", async (req, res) => {
  try {
    if (!googleConfigured()) return res.status(400).send("Google nao configurado");
    const { code, error } = req.query;
    if (error) return res.status(400).send(`<h3>Google recusou: ${error}</h3>`);
    if (!code) return res.status(400).send("sem code");
    const r = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: String(code),
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: googleRedirectUri(req),
        grant_type: "authorization_code"
      })
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error_description || d.error || `HTTP ${r.status}`);
    // Busca info do usuario
    let userInfo = {};
    try {
      const u = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", { headers: { Authorization: `Bearer ${d.access_token}` } });
      userInfo = await u.json();
    } catch (e) {}
    const tokens = {
      access_token: d.access_token,
      refresh_token: d.refresh_token,
      expires_at: Date.now() + (Number(d.expires_in) || 3600) * 1000,
      scope: d.scope,
      token_type: d.token_type,
      email: userInfo.email || null,
      name: userInfo.name || null,
      picture: userInfo.picture || null,
      connected_at: Date.now()
    };
    googleSaveTokens(tokens);
    res.send(`<html><body style="font-family:sans-serif;background:#0d0d0d;color:#e9edef;padding:40px;text-align:center">
      <h2 style="color:#C8A84B">✅ Conectado!</h2>
      <p>Sua conta Google <strong>${userInfo.email || "?"}</strong> foi conectada.</p>
      <p>Pode fechar esta janela e voltar pro CRM.</p>
      <script>setTimeout(function(){window.close();},3000);</script>
    </body></html>`);
  } catch (e) {
    console.error("[google callback]", e?.message);
    res.status(500).send(`<h3>Erro: ${e?.message || e}</h3>`);
  }
});

app.post("/api/integrations/google/disconnect", (req, res) => {
  const t = googleLoadTokens();
  if (t && t.access_token) {
    // Revoga no Google (best-effort)
    fetch(`https://oauth2.googleapis.com/revoke?token=${t.access_token}`, { method: "POST" }).catch(() => {});
  }
  googleSaveTokens(null);
  res.json({ ok: true });
});

app.get("/api/integrations/google/status", (req, res) => {
  const t = googleLoadTokens();
  res.json({
    ok: true,
    configured: googleConfigured(),
    connected: !!(t && t.access_token),
    email: t?.email || null,
    name: t?.name || null,
    picture: t?.picture || null,
    expiresAt: t?.expires_at || null,
    connectedAt: t?.connected_at || null,
    authorizeUrl: googleConfigured() ? "/oauth/google/authorize" : null,
    redirectUri: googleRedirectUri(req)
  });
});

// Listar eventos do calendario primary
app.get("/api/integrations/google/events", async (req, res) => {
  try {
    const timeMin = req.query.from || new Date().toISOString();
    const timeMax = req.query.to || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const maxResults = Math.min(Number(req.query.limit) || 20, 100);
    const params = new URLSearchParams({
      timeMin, timeMax, maxResults: String(maxResults),
      singleEvents: "true", orderBy: "startTime"
    });
    const r = await googleApiFetch(`/calendar/v3/calendars/primary/events?${params}`);
    const d = await r.json();
    if (!r.ok) return res.status(r.status).json({ ok: false, error: d.error?.message || d.error || "erro google" });
    const items = (d.items || []).map(e => ({
      id: e.id,
      summary: e.summary,
      description: e.description,
      start: e.start?.dateTime || e.start?.date,
      end: e.end?.dateTime || e.end?.date,
      htmlLink: e.htmlLink,
      meetLink: e.conferenceData?.entryPoints?.find(x => x.entryPointType === "video")?.uri || e.hangoutLink || null,
      attendees: (e.attendees || []).map(a => ({ email: a.email, name: a.displayName, status: a.responseStatus })),
      status: e.status,
      created: e.created
    }));
    res.json({ ok: true, count: items.length, items });
  } catch (e) {
    console.error("[google events list]", e?.message);
    res.status(500).json({ ok: false, error: e?.message });
  }
});

// Criar evento (com opcional Meet link automatico)
app.post("/api/integrations/google/events", async (req, res) => {
  try {
    const { summary, description, start, end, durationMin, attendees, withMeet, phone, chatId } = req.body || {};
    if (!summary) return res.status(400).json({ ok: false, error: "summary obrigatorio" });
    if (!start) return res.status(400).json({ ok: false, error: "start obrigatorio (ISO)" });
    const startDate = new Date(start);
    if (isNaN(startDate.getTime())) return res.status(400).json({ ok: false, error: "start invalido" });
    const endDate = end ? new Date(end) : new Date(startDate.getTime() + (Number(durationMin) || 60) * 60 * 1000);
    if (isNaN(endDate.getTime())) return res.status(400).json({ ok: false, error: "end invalido" });

    const body = {
      summary: String(summary),
      description: description ? String(description) : undefined,
      start: { dateTime: startDate.toISOString(), timeZone: "America/Sao_Paulo" },
      end:   { dateTime: endDate.toISOString(),   timeZone: "America/Sao_Paulo" },
      attendees: Array.isArray(attendees) ? attendees.filter(a => a && a.email).map(a => ({ email: a.email, displayName: a.displayName })) : undefined
    };
    // Meet link automatico
    if (withMeet) {
      body.conferenceData = {
        createRequest: {
          requestId: "speakers-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8),
          conferenceSolutionKey: { type: "hangoutsMeet" }
        }
      };
    }
    // Metadata extra (nao indexavel pela API Google, mas retorna)
    if (phone || chatId) {
      body.extendedProperties = {
        private: {
          crmPhone: phone ? String(phone) : "",
          crmChatId: chatId ? String(chatId) : ""
        }
      };
    }
    const qs = withMeet ? "?conferenceDataVersion=1&sendUpdates=all" : "?sendUpdates=all";
    const r = await googleApiFetch(`/calendar/v3/calendars/primary/events${qs}`, {
      method: "POST", body: JSON.stringify(body)
    });
    const d = await r.json();
    if (!r.ok) return res.status(r.status).json({ ok: false, error: d.error?.message || d.error || "erro google" });
    res.json({
      ok: true,
      event: {
        id: d.id,
        summary: d.summary,
        start: d.start?.dateTime,
        end: d.end?.dateTime,
        htmlLink: d.htmlLink,
        meetLink: d.conferenceData?.entryPoints?.find(x => x.entryPointType === "video")?.uri || d.hangoutLink || null,
        attendees: (d.attendees || []).map(a => a.email),
        description: d.description
      }
    });
  } catch (e) {
    console.error("[google event create]", e?.message);
    res.status(500).json({ ok: false, error: e?.message });
  }
});

app.delete("/api/integrations/google/events/:id", async (req, res) => {
  try {
    const r = await googleApiFetch(`/calendar/v3/calendars/primary/events/${encodeURIComponent(req.params.id)}?sendUpdates=all`, { method: "DELETE" });
    if (!r.ok && r.status !== 204) {
      const d = await r.json().catch(() => ({}));
      return res.status(r.status).json({ ok: false, error: d.error?.message || `HTTP ${r.status}` });
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message });
  }
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
    tryGoogleAutoEvent(norm).catch(()=>{});

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
  return platformUtils.computeMetrics(kiwifyLoad(), {
    paidStatuses: ["paid"],
    abandonedStatuses: ["abandoned"]
  });
}

function kiwifyFilterEvents(events, q) {
  return platformUtils.filterEvents(events, q);
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
    tryGoogleAutoEvent(norm).catch(()=>{});

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
  return platformUtils.computeMetrics(hotmartLoad(), {
    paidStatuses: ["paid"],
    abandonedStatuses: ["abandoned"]
  });
}

function hotmartFilterEvents(events, q) {
  return platformUtils.filterEvents(events, q);
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
    tryGoogleAutoEvent(norm).catch(()=>{});

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
  return platformUtils.computeMetrics(eduzzLoad(), {
    paidStatuses: ["paid"],
    abandonedStatuses: ["abandoned"]
  });
}

function eduzzFilterEvents(events, q) {
  return platformUtils.filterEvents(events, q);
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
