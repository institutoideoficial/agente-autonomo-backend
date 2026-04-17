const express = require('express');
const axios = require('axios');
const cors = require('cors');
const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const OPENAI_KEY = process.env.OPENAI_API_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const EVOLUTION_URL = process.env.EVOLUTION_URL || 'https://evolution-api-production-a3c7.up.railway.app';
const EVOLUTION_KEY = process.env.EVOLUTION_KEY || 'agentecreator123';
const SERVER_URL = process.env.SERVER_URL || 'https://agente-autonomo-production-cb49.up.railway.app';

const qrCodes = {};
const historico = {};
const conversas = {};
const contatos = {};

async function chamarIA(messages, system) {
  if (ANTHROPIC_KEY) {
    const r = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-opus-4-6', max_tokens: 1000, system, messages
    }, { headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } });
    return r.data.content[0].text;
  } else {
    const msgs = system ? [{ role: 'system', content: system }, ...messages] : messages;
    const r = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-4o-mini', max_tokens: 1000, messages: msgs
    }, { headers: { Authorization: 'Bearer ' + OPENAI_KEY, 'content-type': 'application/json' } });
    return r.data.choices[0].message.content;
  }
}

app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agente Creator</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#111b21;color:#e9edef;height:100vh;display:flex;overflow:hidden}
/* SIDEBAR */
#sidebar{width:380px;min-width:380px;background:#111b21;border-right:1px solid #2a3942;display:flex;flex-direction:column}
#sidebar-header{background:#202c33;padding:10px 16px;display:flex;align-items:center;justify-content:space-between;min-height:60px}
#sidebar-header h2{font-size:19px;font-weight:600;color:#e9edef}
.header-icons{display:flex;gap:8px}
.icon-btn{background:none;border:none;color:#aebac1;cursor:pointer;padding:8px;border-radius:50%;font-size:18px;display:flex;align-items:center;justify-content:center}
.icon-btn:hover{background:#2a3942}
#search-bar{padding:8px 12px;background:#111b21}
#search-bar input{width:100%;background:#2a3942;border:none;border-radius:8px;padding:8px 12px 8px 36px;color:#e9edef;font-size:14px;outline:none}
#search-wrap{position:relative}
#search-wrap::before{content:'🔍';position:absolute;left:10px;top:50%;transform:translateY(-50%);font-size:14px;opacity:0.6}
#connect-bar{padding:8px 12px;background:#005c4b;display:flex;align-items:center;justify-content:space-between;cursor:pointer}
#connect-bar:hover{background:#017561}
#connect-bar span{font-size:13px;font-weight:500}
#conv-list{flex:1;overflow-y:auto}
#conv-list::-webkit-scrollbar{width:6px}
#conv-list::-webkit-scrollbar-track{background:transparent}
#conv-list::-webkit-scrollbar-thumb{background:#2a3942;border-radius:3px}
.conv-item{display:flex;align-items:center;padding:12px 16px;cursor:pointer;border-bottom:1px solid #1f2c34;gap:12px}
.conv-item:hover{background:#2a3942}
.conv-item.active{background:#2a3942}
.avatar{width:49px;height:49px;border-radius:50%;background:#2a3942;display:flex;align-items:center;justify-content:center;font-size:20px;flex-shrink:0;font-weight:600;color:#e9edef}
.conv-info{flex:1;min-width:0}
.conv-name{font-size:16px;font-weight:400;color:#e9edef;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.conv-preview{font-size:13px;color:#8696a0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px}
.conv-meta{display:flex;flex-direction:column;align-items:flex-end;gap:4px;flex-shrink:0}
.conv-time{font-size:12px;color:#8696a0}
.conv-badge{background:#00a884;color:#fff;border-radius:50%;width:20px;height:20px;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700}
/* MAIN */
#main{flex:1;display:flex;flex-direction:column;background:#0b141a}
#main-header{background:#202c33;padding:10px 16px;display:flex;align-items:center;gap:12px;min-height:60px}
#main-header .avatar{width:40px;height:40px;font-size:16px}
#contact-info{flex:1}
#contact-name{font-size:15px;font-weight:600}
#contact-status{font-size:13px;color:#8696a0;margin-top:1px}
#main-actions{display:flex;gap:4px}
#chat-bg{flex:1;overflow-y:auto;padding:20px;background-image:url("data:image/svg+xml,%3Csvg width='400' height='400' xmlns='http://www.w3.org/2000/svg'%3E%3Crect width='400' height='400' fill='%230b141a'/%3E%3C/svg%3E")}
#chat-bg::-webkit-scrollbar{width:6px}
#chat-bg::-webkit-scrollbar-thumb{background:#2a3942;border-radius:3px}
.msg-wrap{display:flex;margin-bottom:4px}
.msg-wrap.user{justify-content:flex-end}
.msg-wrap.agent{justify-content:flex-start}
.bubble{max-width:65%;padding:8px 12px;border-radius:8px;font-size:14.2px;line-height:1.5;word-break:break-word;position:relative}
.bubble.user{background:#005c4b;border-bottom-right-radius:2px}
.bubble.agent{background:#202c33;border-bottom-left-radius:2px}
.bubble-time{font-size:11px;color:#8696a0;margin-top:3px;text-align:right}
.system-msg{text-align:center;margin:12px 0}
.system-msg span{background:#182229;color:#8696a0;font-size:12.5px;padding:5px 12px;border-radius:8px}
#chat-footer{background:#202c33;padding:10px 16px;display:flex;align-items:center;gap:8px}
#chat-input{flex:1;background:#2a3942;border:none;border-radius:10px;padding:11px 16px;color:#e9edef;font-size:15px;outline:none;resize:none;max-height:100px;font-family:inherit}
#chat-input::placeholder{color:#8696a0}
#send-btn{background:#00a884;color:#fff;border:none;border-radius:50%;width:48px;height:48px;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:20px;flex-shrink:0}
#send-btn:hover{background:#017561}
#send-btn:disabled{background:#2a3942;cursor:not-allowed}
/* QR PANEL */
#qr-panel{position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.85);z-index:1000;display:none;align-items:center;justify-content:center}
#qr-box{background:#202c33;border-radius:16px;padding:32px;text-align:center;max-width:360px;width:90%}
#qr-box h3{color:#e9edef;font-size:18px;margin-bottom:8px}
#qr-box p{color:#8696a0;font-size:13px;margin-bottom:20px}
#qr-img{width:240px;height:240px;border-radius:8px;background:#111}
#qr-status{margin-top:16px;font-size:13px;color:#8696a0}
#qr-close{margin-top:16px;background:#2a3942;color:#e9edef;border:none;border-radius:8px;padding:10px 24px;cursor:pointer;font-size:14px}
#qr-close:hover{background:#374248}
/* EMPTY STATE */
#empty-state{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;color:#8696a0}
#empty-state .logo{font-size:64px;margin-bottom:16px;opacity:0.3}
#empty-state h3{font-size:20px;color:#e9edef;margin-bottom:8px}
#empty-state p{font-size:14px;text-align:center;max-width:280px;line-height:1.5}
</style>
</head>
<body>

<div id="sidebar">
  <div id="sidebar-header">
    <h2>Agente Creator</h2>
    <div class="header-icons">
      <button class="icon-btn" title="Nova conversa" onclick="novaConversa()">✏️</button>
      <button class="icon-btn" title="Menu">⋮</button>
    </div>
  </div>
  <div id="search-bar">
    <div id="search-wrap">
      <input type="text" placeholder="Pesquisar ou começar uma nova conversa" id="search-input" oninput="filtrarConversas(this.value)"/>
    </div>
  </div>
  <div id="connect-bar" onclick="abrirQR()">
    <span>📱 Conectar WhatsApp</span>
    <span id="wa-status">⚪ Desconectado</span>
  </div>
  <div id="conv-list">
    <div class="conv-item" onclick="selecionarConversa('demo1','Visitante Demo','Olá! Quero saber mais.')">
      <div class="avatar" style="background:#1d3557">VD</div>
      <div class="conv-info">
        <div class="conv-name">Visitante Demo</div>
        <div class="conv-preview">Olá! Quero saber mais.</div>
      </div>
      <div class="conv-meta">
        <div class="conv-time">Agora</div>
        <div class="conv-badge">1</div>
      </div>
    </div>
  </div>
</div>

<div id="main">
  <div id="empty-state" id="empty">
    <div class="logo">🤖</div>
    <h3>Agente Creator</h3>
    <p>Selecione uma conversa ou conecte seu WhatsApp para começar.</p>
  </div>
</div>

<div id="qr-panel">
  <div id="qr-box">
    <h3>Conectar WhatsApp</h3>
    <p>Abra o WhatsApp no celular → Dispositivos conectados → Conectar</p>
    <img id="qr-img" src="" alt="QR Code"/>
    <div id="qr-status">Aguardando QR Code...</div>
    <button id="qr-close" onclick="fecharQR()">Fechar</button>
  </div>
</div>

<script>
let currentChat = null;
const chats = { demo1: [{ role:'agent', text:'Olá! Sou o Agente Creator com IA. Como posso ajudar?', time: hora() }] };
const nomes = { demo1: 'Visitante Demo' };

function hora() {
  return new Date().toLocaleTimeString('pt-BR', {hour:'2-digit',minute:'2-digit'});
}

function selecionarConversa(id, nome, preview) {
  currentChat = id;
  if (!chats[id]) chats[id] = [];
  if (!nomes[id]) nomes[id] = nome;
  document.querySelectorAll('.conv-item').forEach(el => el.classList.remove('active'));
  event.currentTarget.classList.add('active');
  const badge = event.currentTarget.querySelector('.conv-badge');
  if (badge) badge.remove();
  renderMain(id, nome);
}

function renderMain(id, nome) {
  const main = document.getElementById('main');
  const initials = nome.split(' ').map(w=>w[0]).join('').substring(0,2).toUpperCase();
  const colors = ['#1d3557','#2d6a4f','#6a0572','#c77dff','#3a86ff','#ff6b6b'];
  const color = colors[nome.charCodeAt(0) % colors.length];
  main.innerHTML = `
    <div id="main-header">
      <div class="avatar" style="background:${color}">${initials}</div>
      <div id="contact-info">
        <div id="contact-name">${nome}</div>
        <div id="contact-status">online</div>
      </div>
      <div id="main-actions">
        <button class="icon-btn">🔍</button>
        <button class="icon-btn">⋮</button>
      </div>
    </div>
    <div id="chat-bg"></div>
    <div id="chat-footer">
      <button class="icon-btn" style="color:#8696a0;font-size:22px">😊</button>
      <button class="icon-btn" style="color:#8696a0;font-size:22px">📎</button>
      <textarea id="chat-input" placeholder="Digite uma mensagem" rows="1" onkeydown="handleKey(event)"></textarea>
      <button id="send-btn" onclick="enviar()">&#10148;</button>
    </div>
  `;
  renderMensagens(id);
}

function renderMensagens(id) {
  const bg = document.getElementById('chat-bg');
  if (!bg) return;
  bg.innerHTML = '<div class="system-msg"><span>As mensagens são protegidas com criptografia</span></div>';
  (chats[id] || []).forEach(m => {
    const div = document.createElement('div');
    div.className = 'msg-wrap ' + m.role;
    div.innerHTML = `<div class="bubble ${m.role}"><div>${m.text}</div><div class="bubble-time">${m.time || hora()}</div></div>`;
    bg.appendChild(div);
  });
  bg.scrollTop = bg.scrollHeight;
}

function handleKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); enviar(); }
}

async function enviar() {
  const inp = document.getElementById('chat-input');
  if (!inp) return;
  const text = inp.value.trim();
  if (!text || !currentChat) return;
  inp.value = '';
  inp.style.height = 'auto';
  if (!chats[currentChat]) chats[currentChat] = [];
  chats[currentChat].push({ role:'user', text, time: hora() });
  renderMensagens(currentChat);
  atualizarSidebar(currentChat, text);
  const btn = document.getElementById('send-btn');
  if (btn) btn.disabled = true;
  const msgs = chats[currentChat].filter(m => m.role !== 'system').map(m => ({
    role: m.role === 'agent' ? 'assistant' : 'user', content: m.text
  }));
  try {
    const r = await fetch('/chat', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ messages: msgs })
    });
    const d = await r.json();
    const reply = d.reply || d.error || 'Erro';
    chats[currentChat].push({ role:'agent', text: reply, time: hora() });
    renderMensagens(currentChat);
    atualizarSidebar(currentChat, reply);
  } catch(e) {
    chats[currentChat].push({ role:'agent', text:'Erro de conexão: ' + e.message, time: hora() });
    renderMensagens(currentChat);
  }
  if (btn) btn.disabled = false;
}

function atualizarSidebar(id, lastMsg) {
  const items = document.querySelectorAll('.conv-item');
  items.forEach(item => {
    if (item.getAttribute('onclick') && item.getAttribute('onclick').includes(id)) {
      const prev = item.querySelector('.conv-preview');
      if (prev) prev.textContent = lastMsg;
      const time = item.querySelector('.conv-time');
      if (time) time.textContent = hora();
    }
  });
}

function novaConversa() {
  const nome = prompt('Nome do contato:');
  if (!nome) return;
  const id = 'chat_' + Date.now();
  nomes[id] = nome;
  chats[id] = [{ role:'agent', text:'Olá, ' + nome + '! Como posso ajudar?', time: hora() }];
  const list = document.getElementById('conv-list');
  const initials = nome.split(' ').map(w=>w[0]).join('').substring(0,2).toUpperCase();
  const colors = ['#1d3557','#2d6a4f','#6a0572','#3a86ff','#ff6b6b'];
  const color = colors[nome.charCodeAt(0) % colors.length];
  const div = document.createElement('div');
  div.className = 'conv-item';
  div.setAttribute('onclick', "selecionarConversa('" + id + "','" + nome + "','Olá')");
  div.innerHTML = `<div class="avatar" style="background:${color}">${initials}</div><div class="conv-info"><div class="conv-name">${nome}</div><div class="conv-preview">Nova conversa</div></div><div class="conv-meta"><div class="conv-time">Agora</div></div>`;
  list.insertBefore(div, list.firstChild);
  selecionarConversa.call({ currentTarget: div }, id, nome, 'Nova conversa');
  currentChat = id;
  renderMain(id, nome);
}

function filtrarConversas(q) {
  document.querySelectorAll('.conv-item').forEach(el => {
    const name = el.querySelector('.conv-name');
    el.style.display = (!q || (name && name.textContent.toLowerCase().includes(q.toLowerCase()))) ? '' : 'none';
  });
}

let qrInterval = null;
async function abrirQR() {
  document.getElementById('qr-panel').style.display = 'flex';
  try {
    const r = await fetch('/instancia/criar', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ nome: 'agente1' })
    });
    const d = await r.json();
    if (d.ok) {
      document.getElementById('qr-status').textContent = 'Instância criada, aguardando QR...';
      qrInterval = setInterval(pollQR, 2000);
    }
  } catch(e) {
    document.getElementById('qr-status').textContent = 'Erro ao criar instância: ' + e.message;
  }
}

async function pollQR() {
  try {
    const r = await fetch('/qr/agente1');
    const d = await r.json();
    if (d.base64) {
      const src = d.base64.startsWith('data:') ? d.base64 : 'data:image/png;base64,' + d.base64;
      document.getElementById('qr-img').src = src;
      document.getElementById('qr-status').textContent = 'Escaneie com seu WhatsApp!';
    } else if (d.status === 'connected') {
      clearInterval(qrInterval);
      fecharQR();
      document.getElementById('wa-status').textContent = '🟢 Conectado';
      document.getElementById('connect-bar').style.background = '#1d4e3a';
    }
  } catch(e) {}
}

function fecharQR() {
  document.getElementById('qr-panel').style.display = 'none';
  if (qrInterval) { clearInterval(qrInterval); qrInterval = null; }
}
</script>
</body>
</html>`);
});

app.post('/chat', async (req, res) => {
  try {
    const messages = req.body.messages || [];
    const system = req.body.system || 'Voce e um assistente autonomo inteligente chamado Agente Creator. Responda em portugues brasileiro de forma util e direta.';
    const reply = await chamarIA(messages, system);
    res.json({ reply });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/qr/:instancia', (req, res) => {
  const qr = qrCodes[req.params.instancia];
  res.json({ base64: qr || null, status: qr ? 'ready' : 'waiting' });
});

app.post('/instancia/criar', async (req, res) => {
  const nome = req.body.nome;
  try {
    await axios.delete(EVOLUTION_URL + '/instance/delete/' + nome, { headers: { apikey: EVOLUTION_KEY } }).catch(() => {});
    await new Promise(r => setTimeout(r, 500));
    const criar = await axios.post(EVOLUTION_URL + '/instance/create', {
      instanceName: nome, qrcode: true, integration: 'WHATSAPP-BAILEYS'
    }, { headers: { apikey: EVOLUTION_KEY } });
    const token = criar.data.hash;
    await axios.post(EVOLUTION_URL + '/webhook/set/' + nome, {
      webhook: { enabled: true, url: SERVER_URL + '/webhook/evolution', webhookByEvents: false, webhookBase64: true, events: ['QRCODE_UPDATED', 'MESSAGES_UPSERT', 'CONNECTION_UPDATE'] }
    }, { headers: { apikey: token } });
    res.json({ ok: true, token, instanceName: nome });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/webhook/evolution', (req, res) => {
  const { event, instance, data } = req.body;
  if (event === 'qrcode.updated' && data?.qrcode?.base64) {
    qrCodes[instance] = data.qrcode.base64;
    console.log('[QR] Recebido para', instance);
  }
  if (event === 'messages.upsert') {
    const msg = data?.messages?.[0];
    if (!msg || msg.key.fromMe) return res.sendStatus(200);
    const numero = msg.key.remoteJid;
    const texto = msg.message?.conversation || msg.message?.extendedTextMessage?.text;
    if (!texto) return res.sendStatus(200);
    responder(instance, numero, texto);
  }
  if (event === 'connection.update' && data?.state === 'open') {
    qrCodes[instance] = 'connected';
    console.log('[WhatsApp] Conectado:', instance);
  }
  res.sendStatus(200);
});

async function responder(instancia, numero, texto) {
  try {
    if (!historico[numero]) historico[numero] = [];
    historico[numero].push({ role: 'user', content: texto });
    const reply = await chamarIA(historico[numero].slice(-10), 'Voce e um assistente autonomo. Responda em portugues.');
    historico[numero].push({ role: 'assistant', content: reply });
    await axios.post(EVOLUTION_URL + '/message/sendText/' + instancia, { number: numero, text: reply }, { headers: { apikey: EVOLUTION_KEY } });
  } catch (err) {
    console.error('[Responder]', err.message);
  }
}

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log('Agente Creator v8 porta ' + PORT));
