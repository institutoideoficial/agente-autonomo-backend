const express = require("express");
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

app.get("/", (req, res) => {
  res.json({ status: "Agente autônomo online ✅" });
});

app.post("/chat", async (req, res) => {
  const { messages, systemPrompt } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: "messages é obrigatório" });
  }
  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        max_tokens: 1024,
        messages: [
          { role: "system", content: systemPrompt || "Você é um assistente autônomo inteligente. Responda sempre em português brasileiro." },
          ...messages,
        ],
      }),
    });
    const data = await response.json();
    if (!response.ok) return res.status(500).json({ error: data.error?.message || "Erro na API OpenAI" });
    res.json({ response: data.choices?.[0]?.message?.content || "" });
  } catch (err) {
    res.status(500).json({ error: "Erro interno do servidor" });
  }
});

app.post("/criar-assinatura", async (req, res) => {
  const { email, userId } = req.body;
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "subscription",
      line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],
      customer_email: email,
      metadata: { userId },
      success_url: `${FRONTEND_URL}?plano=pro&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${FRONTEND_URL}?plano=cancelado`,
    });
    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/verificar-assinatura", async (req, res) => {
  const { email } = req.body;
  try {
    const customers = await stripe.customers.list({ email, limit: 1 });
    if (customers.data.length === 0) return res.json({ ativo: false });
    const subscriptions = await stripe.subscriptions.list({
      customer: customers.data[0].id,
      status: "active",
      limit: 1,
    });
    res.json({ ativo: subscriptions.data.length > 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
