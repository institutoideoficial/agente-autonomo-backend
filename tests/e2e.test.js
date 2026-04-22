// E2E: sobe backend CRM + mock Bravos em memoria e testa o fluxo completo.
// Requer: npm install (ja rodado) + node v18+
// Uso: node tests/e2e.test.js

const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

const MOCK_PORT = 4317;
const CRM_PORT = 3517;
let mockBravos, crmProc;
let pass = 0, fail = 0;
function expect(cond, label){ (cond ? (pass++, console.log("  PASS:", label)) : (fail++, console.log("  FAIL:", label))); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Mock Bravos ----------
const bravosLog = [];
const historyFixture = {
  ok: true, chatId: "5511999@c.us", count: 3,
  messages: [
    { message_id: "m3", chat_id: "5511999@c.us", body: "recente",  from_me: 1, direction: "out", timestamp: "2025-04-21T12:03:00.000Z" },
    { message_id: "m2", chat_id: "5511999@c.us", body: "meio",     from_me: 0, direction: "in",  timestamp: "2025-04-21T12:02:00.000Z" },
    { message_id: "m1", chat_id: "5511999@c.us", body: "antigo",   from_me: 0, direction: "in",  timestamp: "2025-04-21T12:01:00.000Z" }
  ]
};

function startMockBravos(){
  return new Promise((resolve) => {
    mockBravos = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => body += c);
      req.on('end', () => {
        bravosLog.push({ method: req.method, url: req.url, headers: req.headers, body });
        res.setHeader('Content-Type', 'application/json');
        if (req.method === 'GET' && req.url === '/health') {
          return res.end(JSON.stringify({ ok: true, clientId: "speakers-crm", isReady: true, isAuthenticated: true, hasQr: false }));
        }
        if (req.method === 'GET' && req.url.startsWith('/history')) {
          return res.end(JSON.stringify(historyFixture));
        }
        if (req.method === 'POST' && req.url === '/send-message') {
          const j = JSON.parse(body || '{}');
          return res.end(JSON.stringify({ ok: true, to: j.chatId, messageId: "fake_msg_id_123" }));
        }
        res.statusCode = 404;
        res.end(JSON.stringify({ ok: false }));
      });
    });
    mockBravos.listen(MOCK_PORT, '127.0.0.1', () => resolve());
  });
}

// ---------- CRM Backend ----------
function startCRM(){
  return new Promise((resolve) => {
    crmProc = spawn(process.execPath, [path.join(__dirname, '..', 'index.js')], {
      env: { ...process.env, PORT: String(CRM_PORT), BRAVOS_URL: `http://127.0.0.1:${MOCK_PORT}`, BRAVOS_TOKEN: 'test_tok' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let buf = '';
    crmProc.stdout.on('data', (d) => {
      buf += String(d);
      if (buf.includes(`rodando na porta ${CRM_PORT}`)) resolve();
    });
    crmProc.stderr.on('data', (d) => console.error("[crm stderr]", String(d).trim()));
  });
}

// ---------- SSE collector ----------
function collectSSE(timeoutMs = 2000){
  return new Promise((resolve, reject) => {
    const events = [];
    const req = http.get(`http://127.0.0.1:${CRM_PORT}/events`, { headers: { Accept: 'text/event-stream' } }, (res) => {
      let buf = '';
      res.on('data', (chunk) => {
        buf += String(chunk);
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const line = block.split('\n').find(l => l.startsWith('data: '));
          if (line) {
            const payload = line.slice(6);
            try { events.push(JSON.parse(payload)); } catch (e) {}
          }
        }
      });
    });
    setTimeout(() => { req.destroy(); resolve(events); }, timeoutMs);
  });
}

// ---------- Tests ----------
async function run(){
  console.log("== iniciando mock Bravos + CRM ==");
  await startMockBravos();
  await startCRM();
  await sleep(200);

  console.log("\n== Teste: GET /health ==");
  {
    const r = await fetch(`http://127.0.0.1:${CRM_PORT}/health`);
    const j = await r.json();
    expect(r.status === 200, "status 200");
    expect(j.ok === true, "ok true");
  }

  console.log("\n== Teste: GET /api/status/speakers-crm (Bravos ready) ==");
  {
    const r = await fetch(`http://127.0.0.1:${CRM_PORT}/api/status/speakers-crm`);
    const j = await r.json();
    expect(j.status === "connected", "status connected");
    expect(j.state === "connected", "state connected");
    expect(j.instance && j.instance.isReady === true, "instance.isReady preservado");
  }

  console.log("\n== Teste: GET /api/history ==");
  {
    const r = await fetch(`http://127.0.0.1:${CRM_PORT}/api/history?chatId=${encodeURIComponent("5511999@c.us")}`);
    const j = await r.json();
    expect(r.status === 200, "status 200");
    expect(Array.isArray(j.messages), "messages array");
    expect(j.messages.length === 3, "3 mensagens");
    const lastBravosReq = bravosLog[bravosLog.length - 1];
    expect(lastBravosReq.headers.authorization === "Bearer test_tok", "bearer token encaminhado ao Bravos");
  }

  console.log("\n== Teste: POST /api/send-message ==");
  {
    const r = await fetch(`http://127.0.0.1:${CRM_PORT}/api/send-message`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: "5511999999999", message: "Ola!" })
    });
    const j = await r.json();
    expect(j.ok === true, "ok true");
    expect(j.messageId === "fake_msg_id_123", "messageId preservado");
    const sendReq = bravosLog.find(l => l.url === '/send-message');
    const sentBody = JSON.parse(sendReq.body);
    expect(sentBody.chatId === "5511999999999@c.us", "chatId construido com @c.us");
    expect(sentBody.message === "Ola!", "message enviada");
    expect(sendReq.headers.authorization === "Bearer test_tok", "bearer token ao Bravos");
  }

  console.log("\n== Teste: SSE broadcast de message_in via webhook ==");
  {
    const ssePromise = collectSSE(1500);
    await sleep(100);
    // Dispara webhook (emula o Bravos mandando um message_in)
    const fire = await fetch(`http://127.0.0.1:${CRM_PORT}/api/webhook/bravos`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: "message_in",
        data: { chat_id: "5511999@c.us", body: "chegando", from_me: 0, direction: "in", timestamp: "2025-04-21T12:10:00.000Z", pushname: "Cliente" },
        clientId: "speakers-crm",
        timestamp: 1713700800000
      })
    });
    expect((await fire.json()).ok === true, "webhook ack ok");
    const events = await ssePromise;
    const msgIn = events.find(e => e.type === "message_in");
    expect(!!msgIn, "SSE recebeu message_in");
    expect(msgIn && msgIn.data && msgIn.data.body === "chegando", "payload preservado");
    expect(msgIn && msgIn.clientId === "speakers-crm", "clientId preservado");
  }

  console.log("\n== Teste: SSE broadcast de whatsapp_ready e whatsapp_disconnected ==");
  {
    const ssePromise = collectSSE(1500);
    await sleep(100);
    await fetch(`http://127.0.0.1:${CRM_PORT}/api/webhook/bravos`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: "ready", data: { ok: true }, clientId: "speakers-crm", timestamp: 1 })
    });
    await fetch(`http://127.0.0.1:${CRM_PORT}/api/webhook/bravos`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: "disconnected", data: { reason: "LOGOUT" }, clientId: "speakers-crm", timestamp: 2 })
    });
    const events = await ssePromise;
    expect(events.some(e => e.type === "whatsapp_ready"), "SSE recebeu whatsapp_ready");
    const disc = events.find(e => e.type === "whatsapp_disconnected");
    expect(!!disc, "SSE recebeu whatsapp_disconnected");
    expect(disc && disc.data && disc.data.reason === "LOGOUT", "disconnected reason preservado");
  }

  console.log("\n== Teste: fallback de payload desconhecido ==");
  {
    const ssePromise = collectSSE(1500);
    await sleep(100);
    await fetch(`http://127.0.0.1:${CRM_PORT}/api/webhook/bravos`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: "evento_inedito", data: { foo: "bar" }, clientId: "speakers-crm", timestamp: 3 })
    });
    const events = await ssePromise;
    const fb = events.find(e => e.type === "new_message");
    expect(!!fb, "fallback new_message para tipos desconhecidos");
    expect(fb && fb.data && fb.data.type === "evento_inedito", "payload bruto preservado");
  }

  console.log("\n== Teste: GET /app serve index.html com patch v4.1 ==");
  {
    const r = await fetch(`http://127.0.0.1:${CRM_PORT}/app`);
    const html = await r.text();
    expect(r.status === 200, "status 200");
    expect(html.includes("IMPERADOR REAL-TIME PATCH v4.1"), "patch v4.1 presente");
    expect(html.includes("disableAllBots"), "disableAllBots definido");
    expect(html.includes("whatsapp_ready"), "dispatcher SSE tipado presente");
    expect(!html.includes("(function startSSE("), "startSSE IIFE nativo removido");
    // Garante que existe apenas UMA conexao EventSource (so a do patch v4.1)
    const esMatches = html.match(/new EventSource\s*\(/g) || [];
    expect(esMatches.length === 1, "apenas 1 new EventSource no HTML (nao duplica SSE)");
    expect(!html.includes("Carlos Mendez"), "contato demo Carlos removido");
    expect(!html.includes("Ana Lima"), "contato demo Ana removido");
    expect(!html.includes("Roberto Faria"), "contato demo Roberto removido");
    expect(!html.includes("Patricia Souza"), "contato demo Patricia removido");
    expect(!html.includes("Marcos Oliveira"), "contato demo Marcos removido");
  }

  console.log("\n== Teste: UI Waseller v4.2 (6 mudancas visuais) ==");
  {
    const r = await fetch(`http://127.0.0.1:${CRM_PORT}/app`);
    const html = await r.text();
    // #1 Filtros pill customizaveis
    expect(html.includes('id="pills"'), "#1 container pills presente");
    expect(html.includes("pillsBuiltIn"), "#1 array pillsBuiltIn presente");
    expect(html.includes("IMP_PILLS_KEY"), "#1 localStorage pills definido");
    expect(html.includes("renderPills()"), "#1 funcao renderPills presente");
    // #2 Trancadas + Arquivadas
    expect(html.includes('id="sb-pinned"'), "#2 container sb-pinned presente");
    expect(html.includes("function arquivar"), "#2 funcao arquivar presente");
    expect(html.includes("function trancar"), "#2 funcao trancar presente");
    expect(html.includes("IMP_FLAGS_KEY"), "#2 localStorage flags definido");
    expect(html.includes("Conversas trancadas"), "#2 label trancadas presente");
    expect(html.includes("Arquivadas"), "#2 label arquivadas presente");
    // #3 Sidebar 12 icones
    const navMatches = html.match(/<button class="nav-btn"[^>]*id="nav-/g) || [];
    expect(navMatches.length >= 11, "#3 sidebar com 11+ nav-btn (era 5)"); // 1 active + 11 nao-active
    expect(html.includes('id="nav-agenda"'), "#3 nav agenda");
    expect(html.includes('id="nav-tags"'), "#3 nav tags");
    expect(html.includes('id="nav-templates"'), "#3 nav templates");
    expect(html.includes('id="nav-disparos"'), "#3 nav disparos");
    expect(html.includes('id="nav-integ"'), "#3 nav integracoes");
    expect(html.includes('id="nav-lixeira"'), "#3 nav lixeira");
    expect(html.includes('id="nav-notif"'), "#3 nav notificacoes");
    expect(html.includes("PLACEHOLDERS"), "#3 mapa de placeholders das features novas");
    expect(html.includes("renderPlaceholder"), "#3 funcao renderPlaceholder");
    // #4 Painel direito quick actions
    expect(html.includes("qa-grid"), "#4 grid de quick actions");
    expect(html.includes('class="qa-btn"'), "#4 botoes qa-btn");
    expect(html.includes("function copiarInfoContato"), "#4 funcao copiar info");
    expect(html.includes("function lembreteRapido"), "#4 funcao lembrete");
    expect(html.includes("function excluirConv"), "#4 funcao excluir");
    // #5 Header chat com 7 botoes SVG
    expect(html.includes("function favoritarConv"), "#5 funcao favoritar");
    expect(html.includes("function silenciarConv"), "#5 funcao silenciar");
    expect(html.includes("function traduzirChat"), "#5 funcao traduzir");
    expect(html.includes("function encerrarChat"), "#5 funcao encerrar");
    expect(html.includes("isPinned"), "#5 helper isPinned");
    expect(html.includes("isMuted"), "#5 helper isMuted");
    // #6 Background doodle dourado no canvas
    expect(html.includes("background-image:url"), "#6 background-image inline");
    expect(html.includes("%23C8A84B") || html.includes("#C8A84B"), "#6 cor dourada no SVG");
    // Bug fix renderRP: garante que nao tem mais s.n / s.t (era q.n / q.t)
    expect(!html.includes("'+s.n+'"), "bugfix renderRP: s.n -> q.n");
    expect(!html.includes("'+s.t+"), "bugfix renderRP: s.t -> q.t");
    // Mojibake check: nao deve ter mais bytes double-encoded comuns
    expect(!html.includes("ð¤"), "mojibake 🤖 corrigido");
    expect(!html.includes("ð¾"), "mojibake 💾 corrigido");
    expect(!html.includes("â¡ Rapida"), "mojibake ⚡ corrigido");
  }

  console.log("\n== Teste: GET / serve welcome.html ==");
  {
    const r = await fetch(`http://127.0.0.1:${CRM_PORT}/`);
    const html = await r.text();
    expect(r.status === 200, "status 200");
    expect(html.includes("SPEAKERS CRM"), "welcome page");
    expect(html.includes("Conectar WhatsApp"), "card WhatsApp");
  }

  console.log("\n== Teste: /api/bot sem ANTHROPIC_API_KEY retorna 500 ==");
  {
    const r = await fetch(`http://127.0.0.1:${CRM_PORT}/api/bot`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: "user", content: "oi" }] })
    });
    expect(r.status === 500, "retorna 500");
    const j = await r.json();
    expect(/ANTHROPIC_API_KEY/.test(j.error || ""), "erro mencionou ANTHROPIC_API_KEY");
  }

  console.log("\n== Teste: /api/history sem chatId retorna 400 ==");
  {
    const r = await fetch(`http://127.0.0.1:${CRM_PORT}/api/history`);
    expect(r.status === 400, "retorna 400");
  }

  console.log("\n== Teste: /api/send-message sem phone retorna 400 ==");
  {
    const r = await fetch(`http://127.0.0.1:${CRM_PORT}/api/send-message`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: "sem phone" })
    });
    expect(r.status === 400, "retorna 400");
  }

  console.log(`\n=== E2E: ${pass} pass, ${fail} fail ===`);
}

run().then(() => {
  if (crmProc) crmProc.kill();
  if (mockBravos) mockBravos.close();
  process.exit(fail === 0 ? 0 : 1);
}).catch((e) => {
  console.error("ERRO E2E:", e);
  if (crmProc) crmProc.kill();
  if (mockBravos) mockBravos.close();
  process.exit(1);
});
