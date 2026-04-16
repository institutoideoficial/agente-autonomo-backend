———êéôêúêéôêconst express = require("express");
const cors = require("cors");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_PRICE_ID = process.env.STRIPE_PRICE_ID;
const FRONTEND_URL = process.env.FRONTEND_URL || "https://agente-autonomo.vercel.app";
const stripe = require("stripe")(STRIPE_SECRET_KEY);

const waInstances = {};

async function getWASocket(userId) {
  const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = await import("@whiskeysockets/baileys");
  const { Boom } = await import("@hapi/boom");
  const QRCode = await import("qrcode");
  const fs = require("fs");

  const authDir = `/tmp/auth_${userId}`;
  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  const sock = makeWASocket({ auth: state, printQRInTerminal: false, logger: { level: "silent", log: () => {}, info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {}, child: () => ({ level: "silent", log: () => {}, info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {} }) } });

  if (!waInstances[userId]) waInstances[userId] = {};
  waInstances[userId].sock = sock;
  waInstances[userId].status = "connecting";

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      try {
        const qrImage = await QRCode.default.toDataURL(qr);
        waInstances[userId].qr = qrImage;
        waInstances[userId].status = "qr";
        console.log(`QR gerado para ${userId}`);
      } catch (e) { console.error("Erro QR:", e); }
    }
    if (connection === "close") {
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
      if (code !== DisconnectReason.loggedOut) {
        console.log(`Reconectando ${userId}...`);
        setTimeout(() => getWASocket(userId), 3000);
      } else {
        waInstances[userId].status = "disconnected";
        waInstances[userId].qr = null;
      }
    } else if (connection === "open") {
      waInstances[userId].status = "connected";
      waInstances[userId].qr = null;
      console.log(`WhatsApp conectado: ${userId}`);
    }
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("messages.upsert", async ({ messages }) => {
    for (const msg of messages) {
      if (!msg.key.fromMe && msg.message) {
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
        if (!text) continue;
        try {
          const res = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${OPENAI_API_KEY}` },
            body: JSON.stringify({
              model: "gpt-4o-mini", max_tokens: 1024,
              messages: [
                { role: "system", content: "Você é um assistente inteligente. Responda sempre em português brasileiro de forma direta e útil." },
                { role: "user", content: text }
              ]
            })
          });
          const data = await res.json();
          const reply = data.choices?.[0]?.message?.content;
          if (reply) await sock.sendMessage(msg.key.remoteJid, { text: reply });
        } catch (e) { console.error("Erro resposta:", e); }
      }
    }
  });

  return sock;
}

app.get("/", (req, res) => res.json({ status: "Agente autônomo online ✅" }));

app.post("/chat", async (req, res) => {
  const { messages, systemPrompt } = req.body;
  if (!messages || !Array.isArray(messages)) return res.status(400).json({ error: "messages obrigatório" });
  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({ model: "gpt-4o-mini", max_tokens: 1024, messages: [{ role: "system", content: systemPrompt || "Você é um assistente. Responda em português brasileiro." }, ...messages] })
    });
    const data = await response.json();
    if (!response.ok) return res.status(500).json({ error: data.error?.message });
    res.json({ response: data.choices?.[0]?.message?.content || "" });
  } catch (e) { res.status(500).json({ error: "Erro interno" }); }
});

app.post("/whatsapp/connect", async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: "userId obrigatório" });
  try {
    if (waInstances[userId]?.status === "connected") return res.json({ status: "connected" });
    if (!waInstances[userId] || waInstances[userId]?.status === "disconnected") {
      getWASocket(userId).catch(console.error);
    }
    await new Promise(r => setTimeout(r, 5000));
    res.json({ status: waInstances[userId]?.status || "connecting", qr: waInstances[userId]?.qr || null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/whatsapp/status/:userId", (req, res) => {
  const inst = waInstances[req.params.userId];
  res.json({ status: inst?.status || "disconnected", qr: inst?.qr || null });
});

app.post("/whatsapp/disconnect/:userId", async (req, res) => {
  const inst = waInstances[req.params.userId];
  if (inst?.sock) { try { await inst.sock.logout(); } catch {} }
  delete waInstances[req.params.userId];
  res.json({ status: "disconnected" });
});

app.post("/criar-assinatura", async (req, res) => {
  const { email, userId } = req.body;
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"], mode: "subscription",
      line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],
      customer_email: email, metadata: { userId },
      success_url: `${FRONTEND_URL}?plano=pro&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${FRONTEND_URL}?plano=cancelado`
    });
    res.json({ url: session.url });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/verificar-assinatura", async (req, res) => {
  const { email } = req.body;
  try {
    const customers = await stripe.customers.list({ email, limit: 1 });
    if (!customers.data.length) return res.json({ ativo: false });
    const subs = await stripe.subscriptions.list({ customer: customers.data[0].id, status: "active", limit: 1 });
    res.json({ ativo: subs.data.length > 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
