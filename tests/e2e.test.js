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
    // Templates v4.3
    expect(html.includes("renderTemplatesPage"), "Templates: render CRUD presente");
    expect(html.includes("loadTemplates"), "Templates: loadTemplates definido");
    expect(html.includes("saveTemplates"), "Templates: saveTemplates definido");
    expect(html.includes("expandVars"), "Templates: expandVars definido");
    expect(html.includes("IMP_TPL_KEY"), "Templates: localStorage key");
    expect(html.includes("function tplOpenForm"), "Templates: form opener");
    expect(html.includes("function tplSave"), "Templates: save");
    expect(html.includes("function tplDelete"), "Templates: delete");
    expect(html.includes("/tmp:"), "Templates: atalho /tmp: documentado");
    expect(html.includes("{nome}"), "Templates: variavel {nome}");
    expect(html.includes("{hora}"), "Templates: variavel {hora}");
    expect(html.includes("QRS_DEFAULTS"), "Templates: array default");
    // Kanban v4.4 drag-drop
    expect(html.includes("kb-board"), "Kanban: board container");
    expect(html.includes("kb-card"), "Kanban: card class");
    expect(html.includes("kb-col"), "Kanban: col class");
    expect(html.includes("dragstart"), "Kanban: handler dragstart");
    expect(html.includes("dragover"), "Kanban: handler dragover");
    expect(html.includes("'drop'"), "Kanban: handler drop");
    expect(html.includes("Em atendimento"), "Kanban: coluna nova");
    // Dashboard v4.5
    expect(html.includes("function computeMetrics"), "Dashboard: computeMetrics");
    expect(html.includes("function renderKPIBar"), "Dashboard: renderKPIBar");
    expect(html.includes('id="kpi-bar"'), "Dashboard: KPI bar container");
    expect(html.includes("dash-grid"), "Dashboard: grid de cards");
    expect(html.includes("Por departamento"), "Dashboard: secao departamento");
    expect(html.includes("Por etiqueta"), "Dashboard: secao etiqueta");
    expect(html.includes("avgRespMin"), "Dashboard: tempo medio resposta");
    // Tags v4.6
    expect(html.includes("function renderTagsPage"), "Tags: render page");
    expect(html.includes("function loadTags"), "Tags: loadTags");
    expect(html.includes("function tagAdd"), "Tags: add");
    expect(html.includes("function tagRemove"), "Tags: remove");
    expect(html.includes("function tagSetColor"), "Tags: setColor");
    expect(html.includes("TAGS_DEFAULTS"), "Tags: defaults");
    expect(html.includes("IMP_TAGS_KEY"), "Tags: localStorage key");
    // Lixeira v4.7
    expect(html.includes("function renderTrashPage"), "Lixeira: render");
    expect(html.includes("trashPurgeOld"), "Lixeira: auto-purge");
    expect(html.includes("function trashMove"), "Lixeira: move pra lixeira");
    expect(html.includes("function trashRestore"), "Lixeira: restaurar");
    expect(html.includes("function trashEmpty"), "Lixeira: esvaziar");
    expect(html.includes("TRASH_TTL_DAYS"), "Lixeira: TTL configuravel");
    expect(html.includes("IMP_TRASH_KEY"), "Lixeira: localStorage");
    // Agendados v4.8 (frontend)
    expect(html.includes("function renderAgendaPage"), "Agenda: render");
    expect(html.includes("function agendaCreate"), "Agenda: create");
    expect(html.includes("function agendaCancel"), "Agenda: cancel");
    expect(html.includes("function agendaSubmit"), "Agenda: submit");
    // Busca expandida v4.9
    expect(html.includes("(c.msgs||[]).map"), "Busca: matchea conteudo de mensagens");
    expect(html.includes("inp.focus(); inp.select"), "Busca: atalho '/' foca input");
    // Som + Notif v4.10
    expect(html.includes("function playBeep"), "Audio: playBeep");
    expect(html.includes("function showNotif"), "Notif: showNotif");
    expect(html.includes("AudioContext"), "Audio: WebAudio API");
    expect(html.includes("notifPermission"), "Notif: pede permissao");
    expect(html.includes("IMP_AUDIO_KEY"), "Audio: localStorage toggle");
    // Theme v4.11
    expect(html.includes("body.theme-light"), "Theme: classe light com paleta");
    expect(html.includes("toggleTheme"), "Theme: funcao global");
    expect(html.includes("IMP_THEME_KEY"), "Theme: localStorage");
    expect(html.includes('id="nav-theme"'), "Theme: botao na sidebar");
    // Greenn v4.12 frontend
    expect(html.includes("function handleGreennEvent"), "Greenn: handleEvent");
    expect(html.includes("function renderIntegracoesPage"), "Greenn: renderIntegracoes");
    expect(html.includes("function greennMatchOrCreateConv"), "Greenn: match/create conv");
    expect(html.includes("function greennAutoTag"), "Greenn: tag auto");
    expect(html.includes('greenn_event'), "Greenn: SSE handler");
    // v4.13 Greenn templates + historico
    expect(html.includes("'Greenn-BoasVindas'"), "Greenn: template boas-vindas");
    expect(html.includes("'Greenn-Abandono'"), "Greenn: template abandono");
    expect(html.includes("'Greenn-Recusada'"), "Greenn: template recusada");
    expect(html.includes("'Greenn-Reembolso'"), "Greenn: template reembolso");
    expect(html.includes("{produto}"), "Greenn: variavel produto em templates");
    expect(html.includes("{valor}"), "Greenn: variavel valor");
    expect(html.includes("function renderGreennSection"), "Greenn: historico no painel");
    expect(html.includes("greennHistory"), "Greenn: array de historico");
    expect(html.includes("greennLast"), "Greenn: ultimo evento armazenado");
    // v4.14 Regras UI
    expect(html.includes("function greennRulesFetch"), "Rules: fetch regras");
    expect(html.includes("function greennRuleToggle"), "Rules: toggle regra");
    expect(html.includes("function greennRuleSaveFields"), "Rules: salvar regras");
    expect(html.includes("Regras de auto-follow-up"), "Rules: card na pagina");
    // v4.15 Dashboard Greenn
    expect(html.includes("🌱 Vendas Greenn"), "Dashboard: secao Greenn");
    expect(html.includes("Receita hoje"), "Dashboard Greenn: card receita hoje");
    expect(html.includes("Top produtos"), "Dashboard Greenn: top produtos");
    expect(html.includes("/api/integrations/greenn/metrics"), "Dashboard: fetch metrics");
  }

  console.log("\n== Teste: Greenn metrics endpoint (v4.15) ==");
  {
    // dispara 3 webhooks pra ter dados
    const base = `http://127.0.0.1:${CRM_PORT}`;
    await fetch(`${base}/api/webhook/greenn`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: { customer: { name: 'A', phone: '5511111111111' }, product: { name: 'Curso 1' }, transaction: { status: 'paid', total: 500 } } }) });
    await fetch(`${base}/api/webhook/greenn`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: { customer: { name: 'B', phone: '5511222222222' }, product: { name: 'Curso 2' }, transaction: { status: 'paid', total: 1000 } } }) });
    await fetch(`${base}/api/webhook/greenn`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: { customer: { name: 'C', phone: '5511333333333' }, product: { name: 'Curso 1' }, transaction: { status: 'abandoned' } } }) });
    const r = await fetch(`${base}/api/integrations/greenn/metrics`);
    const j = await r.json();
    expect(j.ok === true && j.metrics, "metrics endpoint OK");
    const m = j.metrics;
    expect(m.hoje.paid >= 2, "conta aprovadas de hoje");
    expect(m.hoje.revenue >= 1500, "soma receita hoje");
    expect(m.hoje.abandoned >= 1, "conta abandonadas");
    expect(m.hoje.conversionPct > 0, "calcula conversao");
    expect(m.hoje.avgTicket > 0, "calcula ticket medio");
    expect(Array.isArray(m.topProducts), "top products array");
    expect(m.topProducts.some(p => p.name === 'Curso 1'), "Curso 1 no top");
    expect(Array.isArray(m.days7) && m.days7.length === 7, "serie 7 dias");
  }

  console.log("\n== Teste: Greenn filtros + CSV + retry (v4.16) ==");
  {
    const base = `http://127.0.0.1:${CRM_PORT}`;
    // Dispara variados
    await fetch(`${base}/api/webhook/greenn`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: { customer: { name: 'Filtro1', phone: '5511444444001' }, product: { name: 'ProdutoA' }, transaction: { status: 'paid', total: 100 } } }) });
    await fetch(`${base}/api/webhook/greenn`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: { customer: { name: 'Filtro2', phone: '5511444444002' }, product: { name: 'ProdutoB' }, transaction: { status: 'abandoned' } } }) });
    await fetch(`${base}/api/webhook/greenn`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: { customer: { name: 'Filtro3', phone: '5511444444003' }, product: { name: 'ProdutoA' }, transaction: { status: 'refused' } } }) });
    // filtra por status
    const r1 = await fetch(`${base}/api/integrations/greenn/events?status=paid`);
    const j1 = await r1.json();
    expect(j1.items.every(x => x.status === 'paid'), "filtro status paid");
    // filtra por produto
    const r2 = await fetch(`${base}/api/integrations/greenn/events?product=ProdutoA`);
    const j2 = await r2.json();
    expect(j2.items.every(x => (x.productName || '').includes('ProdutoA')), "filtro produto");
    // busca por nome
    const r3 = await fetch(`${base}/api/integrations/greenn/events?search=Filtro2`);
    const j3 = await r3.json();
    expect(j3.items.some(x => x.name === 'Filtro2'), "search matchea nome");
    // CSV
    const r4 = await fetch(`${base}/api/integrations/greenn/events.csv`);
    expect(r4.status === 200, "CSV status 200");
    const ct = r4.headers.get('content-type');
    expect(ct && ct.includes('text/csv'), "content-type CSV");
    const csv = await r4.text();
    expect(csv.startsWith('\uFEFF') || csv.includes('receivedAt'), "CSV com header");
    expect(csv.includes('Filtro1') || csv.includes('Filtro2') || csv.includes('Filtro3'), "CSV contem dados");
    // Retry em scheduled sent: cria um, aguarda processar? Vamos usar um forced
    const created = await (await fetch(`${base}/api/scheduled`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: '5511000000000', message: 'x', sendAt: Date.now() + 3600 * 1000 }) })).json();
    const retryR = await fetch(`${base}/api/scheduled/${created.item.id}/retry`, { method: 'POST' });
    // nao vai funcionar pois status ainda eh pending
    expect(retryR.status === 409, "retry em pending retorna 409");
    // 404
    const retry404 = await fetch(`${base}/api/scheduled/sch_inexistente/retry`, { method: 'POST' });
    expect(retry404.status === 404, "retry inexistente -> 404");
  }

  console.log("\n== Teste: Eduzz webhook v1 (flat) (v4.18) ==");
  {
    const base = `http://127.0.0.1:${CRM_PORT}`;
    // Status
    const r0 = await fetch(`${base}/api/integrations/eduzz/status`);
    const j0 = await r0.json();
    expect(j0.ok === true && j0.webhookUrl.endsWith('/api/webhook/eduzz'), "status ok + webhookUrl");

    // Payload v1 flat (formato legado Eduzz)
    const flatPayload = {
      event_name: 'invoice_paid',
      cus_name: 'Cliente Eduzz V1',
      cus_email: 'v1@test.com',
      cus_cel: '11977776666',
      product_name: 'Curso Eduzz Anual',
      product_cod: 123456,
      trans_cod: 'tx_ed_001',
      trans_value: 697,
      trans_status: 3
    };
    const r1 = await fetch(`${base}/api/webhook/eduzz`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(flatPayload)
    });
    const j1 = await r1.json();
    expect(j1.ok === true, "webhook v1 aceitou");
    expect(j1.normalized.phone === '11977776666', "normalizou phone de cus_cel");
    expect(j1.normalized.name === 'Cliente Eduzz V1', "normalizou name de cus_name");
    expect(j1.normalized.status === 'paid', "mapeou invoice_paid -> paid");
    expect(typeof j1.autoScheduledId === 'string', "criou auto-schedule");

    // Lista eventos
    const r2 = await fetch(`${base}/api/integrations/eduzz/events?limit=5`);
    const j2 = await r2.json();
    expect(j2.items[0].productName === 'Curso Eduzz Anual', "productName preservado");
    expect(j2.items[0].total === 697, "total preservado");
    expect(j2.items[0].type === 'eduzz', "type=eduzz");

    // Payload v3 nested (formato moderno)
    const nestedPayload = {
      event: 'invoice_paid',
      data: {
        customer: { name: 'Cliente Eduzz V3', email: 'v3@test.com', cellphone: '11944443333' },
        product: { name: 'Curso V3', id: 'p-v3' },
        transaction: { id: 'tx_ed_v3', status: 'paid', value: 1297 }
      }
    };
    const r3 = await fetch(`${base}/api/webhook/eduzz`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(nestedPayload)
    });
    const j3 = await r3.json();
    expect(j3.ok === true, "webhook v3 aceitou");
    expect(j3.normalized.phone === '11944443333', "v3: phone de customer.cellphone");
    expect(j3.normalized.name === 'Cliente Eduzz V3', "v3: name de customer.name");
    expect(j3.normalized.status === 'paid', "v3: status paid");

    // Mapeamento de eventos variados
    for (const [ev, expected] of [['invoice_refused', 'refused'], ['invoice_refund', 'refunded'], ['cart_abandonment', 'abandoned'], ['invoice_expired', 'expired'], ['invoice_waiting_payment', 'pending']]) {
      const r = await fetch(`${base}/api/webhook/eduzz`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event_name: ev, cus_name: 'X', cus_cel: '11900000001' })
      });
      const j = await r.json();
      expect(j.normalized.status === expected, `${ev} -> ${expected}`);
    }

    // Metrics
    const rm = await fetch(`${base}/api/integrations/eduzz/metrics`);
    const jm = await rm.json();
    expect(jm.ok === true && jm.metrics, "metrics endpoint");
    expect(jm.metrics.hoje.paid >= 2, "metrics conta pagas");
    expect(jm.metrics.hoje.revenue >= 697 + 1297, "metrics soma receita");

    // CSV
    const rc = await fetch(`${base}/api/integrations/eduzz/events.csv`);
    expect(rc.status === 200 && (rc.headers.get('content-type') || '').includes('text/csv'), "CSV ok");
    const csvText = await rc.text();
    expect(csvText.includes('Cliente Eduzz V1') || csvText.includes('Cliente Eduzz V3'), "CSV tem dados");

    // Rules
    const rr = await fetch(`${base}/api/integrations/eduzz/rules`);
    const jr = await rr.json();
    expect(jr.ok === true && Array.isArray(jr.rules) && jr.rules.length >= 5, "5+ regras default Eduzz");
    expect(jr.rules.some(r => r.status === 'expired'), "regra expired existe (especifica Eduzz)");
  }

  console.log("\n== Teste: Eduzz HMAC signature (v4.18) ==");
  {
    // Com EDUZZ_HMAC_SECRET nao configurado, HMAC eh aceito (modo aberto). Isso vem do env.
    // Como o server foi iniciado sem esses env, request sem signature passa. Valida comportamento:
    const r = await fetch(`http://127.0.0.1:${CRM_PORT}/api/webhook/eduzz`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event_name: 'invoice_paid', cus_name: 'No Auth', cus_cel: '11988887777' })
    });
    expect(r.status === 200, "sem secret configurado, aceita tudo");
  }

  console.log("\n== Teste: Eduzz frontend (v4.18) ==");
  {
    const r = await fetch(`http://127.0.0.1:${CRM_PORT}/app`);
    const html = await r.text();
    expect(html.includes("function handleEduzzEvent"), "Eduzz: handler SSE");
    expect(html.includes("eduzz_event"), "Eduzz: escuta eduzz_event");
    expect(html.includes("📘 Eduzz"), "Eduzz: aba na UI");
    expect(html.includes("fetchEduzzRules"), "Eduzz: fetch rules");
    expect(html.includes("fetchEduzzEvents"), "Eduzz: fetch events");
    expect(html.includes("'Eduzz-BoasVindas'"), "Eduzz: template BoasVindas");
    expect(html.includes("'Eduzz-Abandono'"), "Eduzz: template Abandono");
    expect(html.includes("'Eduzz-Boleto-Vencido'"), "Eduzz: template Boleto Vencido");
    expect(html.includes("IMP_PLATFORM_KEY"), "Eduzz: persiste aba ativa");
    expect(html.includes("📘 Vendas Eduzz"), "Dashboard: secao Eduzz");
    // v4.19 Hotmart frontend
    expect(html.includes("function handleHotmartEvent"), "Hotmart: handler SSE");
    expect(html.includes("hotmart_event"), "Hotmart: escuta hotmart_event");
    expect(html.includes("🔥 Hotmart"), "Hotmart: aba na UI");
    expect(html.includes("fetchHotmartRules"), "Hotmart: fetch rules");
    expect(html.includes("fetchHotmartEvents"), "Hotmart: fetch events");
    expect(html.includes("'Hotmart-BoasVindas'"), "Hotmart: template BoasVindas");
    expect(html.includes("'Hotmart-Boleto'"), "Hotmart: template Boleto");
    expect(html.includes("'Hotmart-Abandono'"), "Hotmart: template Abandono");
    expect(html.includes("'Hotmart-Recusada'"), "Hotmart: template Recusada");
    expect(html.includes("🔥 Vendas Hotmart"), "Dashboard: secao Hotmart");
    expect(html.includes("#ef5f1e"), "Hotmart: cor laranja do branding");
  }

  console.log("\n== Teste: Hotmart webhook v2 (v4.19) ==");
  {
    const base = `http://127.0.0.1:${CRM_PORT}`;
    // Status
    const r0 = await fetch(`${base}/api/integrations/hotmart/status`);
    const j0 = await r0.json();
    expect(j0.ok === true && j0.webhookUrl.endsWith('/api/webhook/hotmart'), "status + URL");

    // Payload v2 completo PURCHASE_APPROVED
    const payload = {
      id: 'uuid-xyz-001',
      event: 'PURCHASE_APPROVED',
      version: '2.0.0',
      data: {
        product: { id: 99001, name: 'Curso Hotmart X', ucode: 'UC-XYZ' },
        buyer: {
          name: 'Lucas Hot',
          email: 'lucas@test.com',
          document: '000.000.000-00',
          phone: { country_code: '55', area_code: '11', number: '988776655' }
        },
        purchase: {
          transaction: 'HP123456',
          status: 'APPROVED',
          price: { value: 1997, currency_value: 'BRL' },
          payment: { type: 'CREDIT_CARD', installments_number: 12 },
          approved_date: Date.now()
        }
      }
    };
    const r1 = await fetch(`${base}/api/webhook/hotmart`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const j1 = await r1.json();
    expect(j1.ok === true, "webhook aceitou");
    expect(j1.normalized.phone === '5511988776655', "phone montado de country_code+area_code+number");
    expect(j1.normalized.name === 'Lucas Hot', "name extraido de buyer");
    expect(j1.normalized.status === 'paid', "mapeou PURCHASE_APPROVED -> paid");
    expect(j1.normalized.event === 'PURCHASE_APPROVED', "event preservado");
    expect(typeof j1.autoScheduledId === 'string', "auto-schedule criado");

    // Teste com buyer.checkout_phone direto
    const p2 = { event: 'PURCHASE_APPROVED', data: { buyer: { name: 'Tel Direto', checkout_phone: '+5511999998888' }, product: { name: 'X' }, purchase: { status: 'APPROVED', price: { value: 100 } } } };
    const r2 = await fetch(`${base}/api/webhook/hotmart`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p2) });
    const j2 = await r2.json();
    expect(j2.normalized.phone === '5511999998888', "phone de checkout_phone");

    // Testa mapeamento de outros eventos
    for (const [event, expectedStatus] of [
      ['PURCHASE_REFUNDED', 'refunded'],
      ['PURCHASE_CHARGEBACK', 'chargedback'],
      ['PURCHASE_EXPIRED', 'expired'],
      ['PURCHASE_CANCELED', 'cancelled'],
      ['PURCHASE_DELAYED', 'pending'],
      ['PURCHASE_OUT_OF_SHOPPING_CART', 'abandoned'],
      ['PURCHASE_BILLET_PRINTED', 'pending']
    ]) {
      const r = await fetch(`${base}/api/webhook/hotmart`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event, data: { buyer: { name: 'X', checkout_phone: '+5511900000001' }, product: { name: 'Y' }, purchase: { status: 'X' } } })
      });
      const j = await r.json();
      expect(j.normalized.status === expectedStatus, `${event} -> ${expectedStatus}`);
    }

    // Metrics
    const rm = await fetch(`${base}/api/integrations/hotmart/metrics`);
    const jm = await rm.json();
    expect(jm.ok && jm.metrics.hoje.paid >= 2, "metrics conta paid");
    expect(jm.metrics.hoje.revenue >= 1997, "metrics soma receita");

    // CSV com paymentType e installments
    const rc = await fetch(`${base}/api/integrations/hotmart/events.csv`);
    const csv = await rc.text();
    expect(rc.status === 200, "CSV 200");
    expect(csv.includes('CREDIT_CARD') || csv.includes('paymentType'), "CSV tem paymentType");

    // Rules
    const rr = await fetch(`${base}/api/integrations/hotmart/rules`);
    const jr = await rr.json();
    expect(jr.rules.length >= 5, "5+ regras default");
    expect(jr.rules.some(r => r.status === 'pending'), "regra pending (boleto/pix)");
  }

  console.log("\n== Teste: Webhook Greenn (v4.12) ==");
  {
    // Status endpoint
    const r1 = await fetch(`http://127.0.0.1:${CRM_PORT}/api/integrations/greenn/status`);
    const j1 = await r1.json();
    expect(j1.ok === true, "status endpoint OK");
    expect(typeof j1.webhookUrl === 'string', "webhookUrl presente");
    expect(j1.webhookUrl.endsWith('/api/webhook/greenn'), "webhookUrl formato correto");

    // Recebe evento (sem token, modo aberto)
    const payload = {
      event: 'saleUpdated', type: 'sale',
      data: {
        customer: { name: 'Aluno Teste', phone: '5511988887777', email: 'aluno@test.com' },
        product: { name: 'Speakers Play - Anual' },
        transaction: { id: 'tx_abc123', status: 'paid', total: 1497, currency: 'BRL' }
      }
    };
    const r2 = await fetch(`http://127.0.0.1:${CRM_PORT}/api/webhook/greenn`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const j2 = await r2.json();
    expect(j2.ok === true, "webhook aceitou payload");
    expect(j2.normalized && j2.normalized.phone === '5511988887777', "normalizou phone");
    expect(j2.normalized && j2.normalized.name === 'Aluno Teste', "normalizou nome");
    expect(j2.normalized && j2.normalized.status === 'paid', "normalizou status");

    // Lista eventos
    const r3 = await fetch(`http://127.0.0.1:${CRM_PORT}/api/integrations/greenn/events?limit=10`);
    const j3 = await r3.json();
    expect(j3.ok === true && Array.isArray(j3.items), "list events OK");
    expect(j3.items.length >= 1, "evento aparece na lista");
    expect(j3.items[0].statusLabel === 'Aprovada', "statusLabel mapeado pra Aprovada");
    expect(j3.items[0].productName === 'Speakers Play - Anual', "productName preservado");
    expect(j3.items[0].total === 1497, "total preservado");

    // SSE broadcast: cria conexao SSE e dispara webhook, conferindo que evento chega
    const ssePromise = collectSSE(1500);
    await sleep(100);
    await fetch(`http://127.0.0.1:${CRM_PORT}/api/webhook/greenn`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'saleUpdated', data: { customer: { phone: '5511777776666', name: 'SSE Test' }, transaction: { status: 'refused' } } })
    });
    const events = await ssePromise;
    const grEvt = events.find(e => e.type === 'greenn_event');
    expect(!!grEvt, "SSE broadcast greenn_event recebido");
    expect(grEvt && grEvt.data && grEvt.data.status === 'refused', "status refused na SSE");
    expect(grEvt && grEvt.data && grEvt.data.statusLabel === 'Recusada', "statusLabel Recusada");
  }

  console.log("\n== Teste: Greenn auto-follow-up rules (v4.14) ==");
  {
    // Lista regras default
    const r1 = await fetch(`http://127.0.0.1:${CRM_PORT}/api/integrations/greenn/rules`);
    const j1 = await r1.json();
    expect(j1.ok === true && Array.isArray(j1.rules), "regras carregaram");
    expect(j1.rules.some(r => r.status === 'paid' && r.enabled), "regra paid habilitada por default");
    expect(j1.rules.some(r => r.status === 'abandoned' && r.enabled), "regra abandoned habilitada");

    // Dispara webhook de 'paid' - deve criar agendamento automatico
    const pagoPayload = {
      event: 'saleUpdated',
      data: {
        customer: { name: 'Auto Test', phone: '5511966665555', email: 'auto@test.com' },
        product: { name: 'Curso Teste Auto' },
        transaction: { id: 'tx_auto_1', status: 'paid', total: 999.90 }
      }
    };
    const r2 = await fetch(`http://127.0.0.1:${CRM_PORT}/api/webhook/greenn`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(pagoPayload)
    });
    const j2 = await r2.json();
    expect(j2.ok === true, "webhook processou");
    expect(typeof j2.autoScheduledId === 'string' && j2.autoScheduledId.startsWith('sch_'), "agendamento auto criado");

    // Confere que o agendamento existe
    const r3 = await fetch(`http://127.0.0.1:${CRM_PORT}/api/scheduled?status=pending`);
    const j3 = await r3.json();
    const autoItem = j3.items.find(x => x.id === j2.autoScheduledId);
    expect(!!autoItem, "agendamento aparece na lista pending");
    expect(autoItem.source === 'greenn-auto', "tem source=greenn-auto");
    expect(autoItem.sourceStatus === 'paid', "sourceStatus preservado");
    expect(autoItem.sourceProduct === 'Curso Teste Auto', "sourceProduct preservado");
    expect(autoItem.message.includes('Auto'), "mensagem expandida com {nome}");
    expect(autoItem.message.includes('Curso Teste Auto'), "mensagem expandida com {produto}");
    expect(autoItem.message.includes('999'), "mensagem expandida com {valor}");

    // Update regra pra desabilitar 'paid'
    const newRules = j1.rules.map(r => r.status === 'paid' ? { ...r, enabled: false } : r);
    const r4 = await fetch(`http://127.0.0.1:${CRM_PORT}/api/integrations/greenn/rules`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newRules)
    });
    const j4 = await r4.json();
    expect(j4.ok === true, "update rules OK");
    expect(j4.rules.find(r => r.status === 'paid').enabled === false, "paid desabilitada");

    // Agora webhook paid NAO deve criar agendamento
    const r5 = await fetch(`http://127.0.0.1:${CRM_PORT}/api/webhook/greenn`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: { customer: { phone: '5511955554444' }, transaction: { status: 'paid' } } })
    });
    const j5 = await r5.json();
    expect(j5.autoScheduledId === null, "sem autoSchedule quando regra desabilitada");

    // Restaura regras pra nao atrapalhar outros testes
    await fetch(`http://127.0.0.1:${CRM_PORT}/api/integrations/greenn/rules`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(j1.rules)
    });
  }

  console.log("\n== Teste: API agendamento (v4.8) ==");
  {
    // Cria
    const sendAt = Date.now() + 60 * 60 * 1000;
    const r1 = await fetch(`http://127.0.0.1:${CRM_PORT}/api/scheduled`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: '5511999990001', message: 'teste', sendAt: sendAt, note: 'unit' })
    });
    const j1 = await r1.json();
    expect(j1.ok === true, "criar OK");
    expect(j1.item && j1.item.status === 'pending', "status pending");
    expect(j1.item && j1.item.id && j1.item.id.startsWith('sch_'), "id gerado");
    const id = j1.item.id;
    // Lista
    const r2 = await fetch(`http://127.0.0.1:${CRM_PORT}/api/scheduled?status=pending`);
    const j2 = await r2.json();
    expect(j2.ok === true && Array.isArray(j2.items), "list ok");
    expect(j2.items.some(x => x.id === id), "item recem-criado aparece na lista");
    // Cancela
    const r3 = await fetch(`http://127.0.0.1:${CRM_PORT}/api/scheduled/${id}`, { method: 'DELETE' });
    const j3 = await r3.json();
    expect(j3.ok === true, "cancelar OK");
    expect(j3.item && j3.item.status === 'cancelled', "status cancelled");
    // Validacoes
    const r4 = await fetch(`http://127.0.0.1:${CRM_PORT}/api/scheduled`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({})
    });
    expect(r4.status === 400, "criar sem campos -> 400");
    const r5 = await fetch(`http://127.0.0.1:${CRM_PORT}/api/scheduled`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: '5511', message: 'x', sendAt: 100 })
    });
    expect(r5.status === 400, "sendAt no passado -> 400");
    const r6 = await fetch(`http://127.0.0.1:${CRM_PORT}/api/scheduled/inexistente`, { method: 'DELETE' });
    expect(r6.status === 404, "cancelar inexistente -> 404");
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
