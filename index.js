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
const EVOLUTION_URL = (process.env.EVOLUTION_URL || 'https://evolution-api-production-a3c7.up.railway.app').replace(/\/+$/, '');
const EVOLUTION_KEY = process.env.EVOLUTION_KEY || 'agentecreator123';
const SERVER_URL = (process.env.SERVER_URL || 'https://agente-autonomo-production-cb49.up.railway.app').replace(/\/+$/, '');

const qrStore = {};
const historico = {};

console.log('[Config] EVOLUTION_URL:', EVOLUTION_URL);
console.log('[Config] SERVER_URL:', SERVER_URL);

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
      req.body.system || 'Voce e um assistente autonomo chamado Agente Creator. Responda em portugues.');
    res.json({ reply });
  } catch (err) {
    console.error('[Chat]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET QR - hybrid: check memory store first, then poll Evolution API directly
app.get('/qr/:inst', async (req, res) => {
  const inst = req.params.inst;
  if (qrStore[inst] === 'connected') return res.json({ status: 'connected' });
  if (qrStore[inst]) return res.json({ base64: qrStore[inst], status: 'ready' });
  
  // Poll Evolution API directly as fallback
  try {
    const r = await axios.get(EVOLUTION_URL + '/instance/connect/' + inst, {
      headers: { apikey: EVOLUTION_KEY }, timeout: 8000
    });
    console.log('[QR Poll]', inst, JSON.stringify(r.data).substring(0, 100));
    if (r.data && r.data.base64) {
      qrStore[inst] = r.data.base64;
      return res.json({ base64: r.data.base64, status: 'ready' });
    }
    if (r.data && r.data.instance && r.data.instance.state === 'open') {
      qrStore[inst] = 'connected';
      return res.json({ status: 'connected' });
    }
    res.json({ status: 'waiting', count: r.data.count || 0, raw: r.data });
  } catch (err) {
    res.json({ status: 'waiting', error: err.message });
  }
});

// Create instance with correct flow for Evolution API v2
app.post('/instancia/criar', async (req, res) => {
  const nome = req.body.nome || 'agente1';
  try {
    // Step 1: Check if instance already exists
    let token = null;
    try {
      const instances = await axios.get(EVOLUTION_URL + '/instance/fetchInstances', {
        headers: { apikey: EVOLUTION_KEY }
      });
      const existing = (instances.data || []).find(i => i.name === nome);
      if (existing) {
        token = existing.token;
        console.log('[Instancia] Existing instance found, token:', token);
        // Reset connection to trigger new QR
        try {
          await axios.delete(EVOLUTION_URL + '/instance/logout/' + nome, {
            headers: { apikey: EVOLUTION_KEY }
          });
          await new Promise(r => setTimeout(r, 1000));
        } catch(e) { console.log('[Instancia] Logout err (ok):', e.message); }
      }
    } catch(e) { console.log('[FetchInstances]', e.message); }

    // Step 2: Create instance if needed
    if (!token) {
      try {
        await axios.delete(EVOLUTION_URL + '/instance/delete/' + nome, {
          headers: { apikey: EVOLUTION_KEY }
        });
        await new Promise(r => setTimeout(r, 500));
      } catch(e) {}

      const criar = await axios.post(EVOLUTION_URL + '/instance/create', {
        instanceName: nome,
        qrcode: true,
        integration: 'WHATSAPP-BAILEYS',
        rejectCall: false,
        msgCall: ''
      }, { headers: { apikey: EVOLUTION_KEY } });

      console.log('[Criar]', JSON.stringify(criar.data).substring(0, 200));
      token = (criar.data.hash && (criar.data.hash.apikey || criar.data.hash)) || 
               criar.data.token || EVOLUTION_KEY;
    }

    const finalToken = typeof token === 'object' ? (token.apikey || EVOLUTION_KEY) : token;

    // Step 3: Set webhook using global API key
    try {
      await axios.post(EVOLUTION_URL + '/webhook/set/' + nome, {
        webhook: {
          enabled: true,
          url: SERVER_URL + '/webhook/evolution',
          webhookByEvents: false,
          webhookBase64: true,
          events: ['QRCODE_UPDATED', 'MESSAGES_UPSERT', 'CONNECTION_UPDATE', 'SEND_MESSAGE']
        }
      }, { headers: { apikey: EVOLUTION_KEY } });
      console.log('[Webhook] Set for', nome);
    } catch(e) {
      console.log('[Webhook] Error (will use direct polling):', e.message);
    }

    // Step 4: Trigger connection
    try {
      const conn = await axios.get(EVOLUTION_URL + '/instance/connect/' + nome, {
        headers: { apikey: EVOLUTION_KEY }
      });
      console.log('[Connect]', JSON.stringify(conn.data).substring(0, 150));
      if (conn.data && conn.data.base64) {
        qrStore[nome] = conn.data.base64;
      }
    } catch(e) {
      console.log('[Connect]', e.message);
    }

    res.json({ ok: true, token: finalToken, instanceName: nome });
  } catch (err) {
    console.error('[Instancia]', err.response ? JSON.stringify(err.response.data) : err.message);
    res.status(500).json({ error: err.response ? JSON.stringify(err.response.data) : err.message });
  }
});

// Webhook - receive QR and messages from Evolution API
app.post('/webhook/evolution', (req, res) => {
  const { event, instance, data } = req.body;
  console.log('[Webhook]', event, instance);
  
  if (event === 'qrcode.updated' && data) {
    const qr = data.qrcode && (data.qrcode.base64 || data.qrcode);
    if (qr) {
      qrStore[instance] = typeof qr === 'object' ? qr.base64 : qr;
      console.log('[QR] Received for', instance);
    }
  }
  if (event === 'connection.update' && data && (data.state === 'open' || data.status === 'open')) {
    qrStore[instance] = 'connected';
    console.log('[Connected]', instance);
  }
  if (event === 'messages.upsert') {
    const msg = data && data.messages && data.messages[0];
    if (!msg || msg.key.fromMe) return res.sendStatus(200);
    const numero = msg.key.remoteJid;
    const texto = msg.message && (msg.message.conversation ||
      (msg.message.extendedTextMessage && msg.message.extendedTextMessage.text) ||
      (msg.message.imageMessage && msg.message.imageMessage.caption));
    if (texto && numero) responder(instance, numero, texto);
  }
  res.sendStatus(200);
});

async function responder(inst, numero, texto) {
  try {
    if (!historico[numero]) historico[numero] = [];
    historico[numero].push({ role: 'user', content: texto });
    const reply = await chamarIA(historico[numero].slice(-10), 
      'Voce e um assistente autonomo chamado Agente Creator. Responda em portugues de forma util e direta.');
    historico[numero].push({ role: 'assistant', content: reply });
    await axios.post(EVOLUTION_URL + '/message/sendText/' + inst,
      { number: numero, text: reply },
      { headers: { apikey: EVOLUTION_KEY } });
    console.log('[Responder]', numero, '->', reply.substring(0, 50));
  } catch (err) {
    console.error('[Responder]', err.message);
  }
}

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log('[Agente Creator v10] Porta', PORT));
