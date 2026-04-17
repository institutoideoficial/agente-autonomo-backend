const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const OPENAI_KEY = process.env.OPENAI_API_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const EVOLUTION_URL = process.env.EVOLUTION_URL || 'https://evolution-api-production-a3c7.up.railway.app';
const EVOLUTION_KEY = process.env.EVOLUTION_KEY || 'agentecreator123';
const SERVER_URL = process.env.SERVER_URL || 'https://agente-autonomo-production-cb49.up.railway.app';

const qrCodes = {};
const historico = {};

async function chamarIA(messages, system) {
  if (ANTHROPIC_KEY) {
    const r = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-opus-4-6', max_tokens: 1000, system, messages
    }, { headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } });
    return r.data.content[0].text;
  }
  const msgs = system ? [{ role: 'system', content: system }, ...messages] : messages;
  const r = await axios.post('https://api.openai.com/v1/chat/completions', {
    model: 'gpt-4o-mini', max_tokens: 1000, messages: msgs
  }, { headers: { Authorization: 'Bearer ' + OPENAI_KEY, 'content-type': 'application/json' } });
  return r.data.choices[0].message.content;
}

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.post('/chat', async (req, res) => {
  try {
    const reply = await chamarIA(req.body.messages || [],
      'Voce e um assistente autonomo chamado Agente Creator. Responda em portugues.');
    res.json({ reply });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/qr/:inst', (req, res) => {
  const qr = qrCodes[req.params.inst];
  if (qr === 'connected') return res.json({ status: 'connected' });
  res.json({ base64: qr || null, status: qr ? 'ready' : 'waiting' });
});

app.post('/instancia/criar', async (req, res) => {
  const nome = req.body.nome;
  try {
    await axios.delete(EVOLUTION_URL + '/instance/delete/' + nome, { headers: { apikey: EVOLUTION_KEY } }).catch(() => {});
    await new Promise(r => setTimeout(r, 500));
    const c = await axios.post(EVOLUTION_URL + '/instance/create',
      { instanceName: nome, qrcode: true, integration: 'WHATSAPP-BAILEYS' },
      { headers: { apikey: EVOLUTION_KEY } });
    const token = c.data.hash;
    await axios.post(EVOLUTION_URL + '/webhook/set/' + nome, {
      webhook: { enabled: true, url: SERVER_URL + '/webhook/evolution',
        webhookByEvents: false, webhookBase64: true,
        events: ['QRCODE_UPDATED', 'MESSAGES_UPSERT', 'CONNECTION_UPDATE'] }
    }, { headers: { apikey: token } });
    res.json({ ok: true, token, instanceName: nome });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/webhook/evolution', (req, res) => {
  const { event, instance, data } = req.body;
  if (event === 'qrcode.updated' && data && data.qrcode && data.qrcode.base64)
    qrCodes[instance] = data.qrcode.base64;
  if (event === 'connection.update' && data && data.state === 'open')
    qrCodes[instance] = 'connected';
  if (event === 'messages.upsert') {
    const msg = data && data.messages && data.messages[0];
    if (!msg || msg.key.fromMe) return res.sendStatus(200);
    const numero = msg.key.remoteJid;
    const texto = msg.message && (msg.message.conversation ||
      (msg.message.extendedTextMessage && msg.message.extendedTextMessage.text));
    if (texto) responder(instance, numero, texto);
  }
  res.sendStatus(200);
});

async function responder(inst, numero, texto) {
  try {
    if (!historico[numero]) historico[numero] = [];
    historico[numero].push({ role: 'user', content: texto });
    const reply = await chamarIA(historico[numero].slice(-10), 'Voce e um assistente autonomo. Responda em portugues.');
    historico[numero].push({ role: 'assistant', content: reply });
    await axios.post(EVOLUTION_URL + '/message/sendText/' + inst,
      { number: numero, text: reply }, { headers: { apikey: EVOLUTION_KEY } });
  } catch (e) { console.error('[Responder]', e.message); }
}

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log('Agente Creator v9 porta ' + PORT));
