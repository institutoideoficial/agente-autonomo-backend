// SPEAKERS CRM Backend - integrado com Bravos WhatsApp API
const express = require("express");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk");
const platformUtils = require('./lib/platform-utils');
const webPush = require("web-push");
const bcrypt = require("bcryptjs");
const cookieParser = require("cookie-parser");
const rateLimit = require("express-rate-limit");
const otplib = require("otplib");

const app = express();
app.use(cookieParser());
const PORT = process.env.PORT || 3000;

// Config Bravos WhatsApp API
const BRAVOS_URL = process.env.BRAVOS_URL || "https://bravos-whatsapp-api-production.up.railway.app";
const BRAVOS_TOKEN = process.env.BRAVOS_TOKEN || "sp_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2";

// v4.34: Rate limit nos webhooks publicos (anti-DoS / spam)
// Estrategia: 60 req/min por IP nas rotas /api/webhook/*
// Bypass automatico se header X-Webhook-Token bate com algum dos secrets (legitimo, alta freq ok)
const webhookRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "rate limit excedido (60 req/min)" },
  // skip se vem com auth correta (Greenn/Hotmart/Kiwify token, ou Eduzz HMAC valido)
  skip: (req) => {
    const tok = req.headers["x-webhook-token"] || req.headers["x-hotmart-hottok"] || req.query.signature || req.query.hottok || "";
    if (!tok) return false;
    const validTokens = [
      process.env.GREENN_TOKEN,
      process.env.HOTMART_HOTTOK,
      process.env.KIWIFY_TOKEN
    ].filter(Boolean);
    return validTokens.some(v => v === tok);
  }
});
app.use("/api/webhook/", webhookRateLimit);

// Rate limit pra signup/login (anti-bruteforce): 10 tentativas/15min por IP
const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { ok: false, error: "muitas tentativas - tenta de novo em 15min" },
  standardHeaders: true,
  legacyHeaders: false
});
app.use("/auth/login", authRateLimit);
app.use("/auth/signup", authRateLimit);

// v4.32: capturar rawBody pra HMAC verification em webhooks (somente quando aplicavel)
app.use(express.json({
  verify: (req, _res, buf) => {
    // somente armazena pra POSTs em /api/webhook/* (evita memoria desnecessaria)
    if (req.method === 'POST' && req.url && req.url.startsWith('/api/webhook/')) {
      req.rawBody = buf.toString('utf8');
    }
  },
  limit: '2mb'
}));

// v4.33: AUTH SYSTEM (cookie-based session + signup/login UI)
// Mantem fallback Basic Auth opt-in pra cron interno, mas UI usa cookie.
const BASIC_AUTH_USER = process.env.BASIC_AUTH_USER || '';
const BASIC_AUTH_PASS = process.env.BASIC_AUTH_PASS || '';
const SIGNUP_INVITE_CODE = process.env.SIGNUP_INVITE_CODE || ''; // se setado, exige codigo no signup
const AUTH_SESSION_TTL_DAYS = Number(process.env.AUTH_SESSION_TTL_DAYS || 30);
const AUTH_BYPASS_PREFIX = ['/health', '/healthz', '/api/webhook/', '/oauth/google/', '/oauth/instagram/', '/api/push/vapid-public-key', '/auth/', '/login', '/login.html', '/icon-', '/manifest.json', '/sw.js', '/favicon', '/wa-agent', '/wa/qr', '/api/status/', '/e/', '/t/', '/api/public/'];

const USERS_FILE = process.env.USERS_FILE || path.join(__dirname, "data", "users.json");
const SESSIONS_FILE = process.env.SESSIONS_FILE || path.join(__dirname, "data", "sessions.json");

function _loadJsonFile(p, def) { try { return JSON.parse(require('fs').readFileSync(p, 'utf8')); } catch { return def; } }
function _saveJsonFile(p, data) { try { require('fs').writeFileSync(p, JSON.stringify(data, null, 2)); } catch (e) { console.error('[auth] save', p, e?.message); } }

function usersLoad() { return _loadJsonFile(USERS_FILE, []); }
function usersSave(arr) { _saveJsonFile(USERS_FILE, arr); }
function sessionsLoad() { return _loadJsonFile(SESSIONS_FILE, []); }
function sessionsSave(arr) { _saveJsonFile(SESSIONS_FILE, arr); }

function sessionsClean() {
  const now = Date.now();
  const arr = sessionsLoad().filter(s => s.expiresAt > now);
  sessionsSave(arr);
  return arr;
}

function sessionFindByToken(token) {
  if (!token) return null;
  const arr = sessionsClean();
  return arr.find(s => s.token === token) || null;
}

function sessionCreate(userId) {
  const crypto = require('crypto');
  const token = crypto.randomBytes(32).toString('hex');
  const arr = sessionsClean();
  const item = { token, userId, createdAt: Date.now(), expiresAt: Date.now() + AUTH_SESSION_TTL_DAYS * 24 * 60 * 60 * 1000 };
  arr.push(item);
  sessionsSave(arr);
  return item;
}

function sessionDelete(token) {
  if (!token) return;
  const arr = sessionsLoad().filter(s => s.token !== token);
  sessionsSave(arr);
}

function authBypass(reqUrl) {
  return AUTH_BYPASS_PREFIX.some(p => reqUrl === p || reqUrl.startsWith(p));
}

function authResolveUser(req) {
  // 1. Cookie de sessao
  const token = req.cookies?.imp_session;
  if (token) {
    const sess = sessionFindByToken(token);
    if (sess) {
      const user = usersLoad().find(u => u.id === sess.userId);
      if (user) return { user, via: 'cookie' };
    }
  }
  // 2. Fallback: Basic Auth (uso interno cron)
  const h = req.headers.authorization || '';
  if (h.startsWith('Basic ') && BASIC_AUTH_USER && BASIC_AUTH_PASS) {
    try {
      const dec = Buffer.from(h.slice(6), 'base64').toString('utf8');
      const i = dec.indexOf(':');
      if (i > 0) {
        const u = dec.slice(0, i), p = dec.slice(i + 1);
        if (u === BASIC_AUTH_USER && p === BASIC_AUTH_PASS) {
          return { user: { id: 'basic-' + u, email: u + '@local', name: u, role: 'admin', createdAt: 0 }, via: 'basic' };
        }
      }
    } catch {}
  }
  return null;
}

// Middleware principal - protege tudo exceto bypass
app.use((req, res, next) => {
  if (authBypass(req.url)) return next();
  const auth = authResolveUser(req);
  if (auth) { req.user = auth.user; return next(); }
  // Pra HTML/UI, redireciona pra login. Pra API, retorna 401 JSON.
  if (req.headers.accept && req.headers.accept.includes('text/html')) {
    return res.redirect('/login?next=' + encodeURIComponent(req.url));
  }
  res.status(401).json({ ok: false, error: 'auth required' });
});
console.log('[auth] sistema cookie+signup ativo (TTL ' + AUTH_SESSION_TTL_DAYS + 'd)' + (BASIC_AUTH_USER ? ', fallback Basic ativo' : ''));

// === Endpoints de auth ===
app.post('/auth/signup', async (req, res) => {
  try {
    const { email, password, name, inviteCode } = req.body || {};
    if (!email || !password) return res.status(400).json({ ok: false, error: 'email e senha obrigatorios' });
    if (password.length < 6) return res.status(400).json({ ok: false, error: 'senha minima 6 caracteres' });
    if (SIGNUP_INVITE_CODE && inviteCode !== SIGNUP_INVITE_CODE) {
      return res.status(403).json({ ok: false, error: 'codigo de convite invalido' });
    }
    const users = usersLoad();
    const emailLow = String(email).toLowerCase().trim();
    if (users.find(u => u.email === emailLow)) return res.status(409).json({ ok: false, error: 'email ja cadastrado' });
    const passwordHash = await bcrypt.hash(password, 10);
    const user = {
      id: 'usr_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      email: emailLow,
      name: String(name || emailLow.split('@')[0]).trim(),
      passwordHash,
      role: users.length === 0 ? 'admin' : 'user', // 1o usuario = admin
      createdAt: Date.now(),
      lastLoginAt: Date.now()
    };
    users.push(user);
    usersSave(users);
    const sess = sessionCreate(user.id);
    res.cookie('imp_session', sess.token, {
      httpOnly: true, secure: req.secure || req.headers['x-forwarded-proto'] === 'https',
      sameSite: 'lax', maxAge: AUTH_SESSION_TTL_DAYS * 24 * 60 * 60 * 1000
    });
    res.json({ ok: true, user: { id: user.id, email: user.email, name: user.name, role: user.role } });
  } catch (e) { res.status(500).json({ ok: false, error: e?.message }); }
});

app.post('/auth/login', async (req, res) => {
  try {
    const { email, password, totp } = req.body || {};
    if (!email || !password) return res.status(400).json({ ok: false, error: 'email e senha obrigatorios' });
    const emailLow = String(email).toLowerCase().trim();
    const users = usersLoad();
    const user = users.find(u => u.email === emailLow);
    if (!user) return res.status(401).json({ ok: false, error: 'email ou senha invalidos' });
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return res.status(401).json({ ok: false, error: 'email ou senha invalidos' });
    // v4.34: 2FA TOTP - se ativo, exige token
    if (user.totpEnabled && user.totpSecret) {
      if (!totp) return res.status(401).json({ ok: false, requires2FA: true, error: 'codigo 2FA obrigatorio' });
      const v = otplib.verifySync({ token: String(totp).replace(/\D/g, ''), secret: user.totpSecret });
      if (!v || !v.valid) return res.status(401).json({ ok: false, requires2FA: true, error: 'codigo 2FA invalido ou expirado' });
    }
    user.lastLoginAt = Date.now();
    usersSave(users);
    const sess = sessionCreate(user.id);
    res.cookie('imp_session', sess.token, {
      httpOnly: true, secure: req.secure || req.headers['x-forwarded-proto'] === 'https',
      sameSite: 'lax', maxAge: AUTH_SESSION_TTL_DAYS * 24 * 60 * 60 * 1000
    });
    res.json({ ok: true, user: { id: user.id, email: user.email, name: user.name, role: user.role, has2FA: !!user.totpEnabled } });
  } catch (e) { res.status(500).json({ ok: false, error: e?.message }); }
});

// v4.34: 2FA TOTP setup/enable/disable
app.post('/auth/2fa/setup', (req, res) => {
  try {
    const auth = authResolveUser(req);
    if (!auth) return res.status(401).json({ ok: false, error: 'auth required' });
    const users = usersLoad();
    const user = users.find(u => u.id === auth.user.id);
    if (!user) return res.status(404).json({ ok: false, error: 'user nao encontrado (2FA precisa login real, nao Basic Auth)' });
    if (user.totpEnabled) return res.status(400).json({ ok: false, error: '2FA ja ativo. Desative primeiro.' });
    // Gera secret novo (mas NAO salva ainda - so depois do enable)
    const secret = otplib.generateSecret();
    user._pendingTotpSecret = secret;
    usersSave(users);
    const issuer = 'Imperador CRM';
    const accountName = user.email;
    const otpauthUrl = otplib.generateURI({ secret, label: accountName, issuer });
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(otpauthUrl)}`;
    res.json({ ok: true, secret, otpauthUrl, qrUrl, instructions: 'Escaneia o QR no Google Authenticator/Authy/1Password. Depois manda o codigo de 6 digitos pra /auth/2fa/enable.' });
  } catch (e) { res.status(500).json({ ok: false, error: e?.message }); }
});

app.post('/auth/2fa/enable', (req, res) => {
  try {
    const auth = authResolveUser(req);
    if (!auth) return res.status(401).json({ ok: false, error: 'auth required' });
    const { token } = req.body || {};
    if (!token) return res.status(400).json({ ok: false, error: 'token obrigatorio' });
    const users = usersLoad();
    const user = users.find(u => u.id === auth.user.id);
    if (!user) return res.status(404).json({ ok: false, error: 'user nao encontrado (2FA precisa login real, nao Basic Auth)' });
    if (user.totpEnabled) return res.status(400).json({ ok: false, error: '2FA ja ativo' });
    if (!user._pendingTotpSecret) return res.status(400).json({ ok: false, error: 'rode /auth/2fa/setup primeiro' });
    const v = otplib.verifySync({ token: String(token).replace(/\D/g, ''), secret: user._pendingTotpSecret });
    if (!v || !v.valid) return res.status(400).json({ ok: false, error: 'codigo invalido ou expirado' });
    user.totpSecret = user._pendingTotpSecret;
    user.totpEnabled = true;
    user.totpEnabledAt = Date.now();
    delete user._pendingTotpSecret;
    usersSave(users);
    res.json({ ok: true, message: '2FA ativado. A partir do proximo login vai pedir o codigo.' });
  } catch (e) { res.status(500).json({ ok: false, error: e?.message }); }
});

app.post('/auth/2fa/disable', async (req, res) => {
  try {
    const auth = authResolveUser(req);
    if (!auth) return res.status(401).json({ ok: false, error: 'auth required' });
    const { password } = req.body || {};
    if (!password) return res.status(400).json({ ok: false, error: 'senha obrigatoria pra desativar 2FA' });
    const users = usersLoad();
    const user = users.find(u => u.id === auth.user.id);
    if (!user) return res.status(404).json({ ok: false, error: 'user nao encontrado (2FA precisa login real, nao Basic Auth)' });
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return res.status(401).json({ ok: false, error: 'senha invalida' });
    delete user.totpSecret;
    delete user.totpEnabled;
    delete user.totpEnabledAt;
    delete user._pendingTotpSecret;
    usersSave(users);
    res.json({ ok: true, message: '2FA desativado' });
  } catch (e) { res.status(500).json({ ok: false, error: e?.message }); }
});

app.get('/auth/2fa/status', (req, res) => {
  const auth = authResolveUser(req);
  if (!auth) return res.status(401).json({ ok: false });
  const users = usersLoad();
  const user = users.find(u => u.id === auth.user.id);
  if (!user) return res.status(404).json({ ok: false });
  res.json({
    ok: true,
    enabled: !!user.totpEnabled,
    enabledAt: user.totpEnabledAt || null,
    pendingSetup: !!user._pendingTotpSecret
  });
});

app.post('/auth/logout', (req, res) => {
  const token = req.cookies?.imp_session;
  if (token) sessionDelete(token);
  res.clearCookie('imp_session');
  res.json({ ok: true });
});

app.get('/auth/me', (req, res) => {
  const auth = authResolveUser(req);
  if (!auth) return res.status(401).json({ ok: false });
  // Carrega dados frescos pra pegar has2FA
  const users = usersLoad();
  const fresh = users.find(u => u.id === auth.user.id) || auth.user;
  res.json({ ok: true, user: { id: fresh.id, email: fresh.email, name: fresh.name, role: fresh.role, has2FA: !!fresh.totpEnabled }, via: auth.via });
});

app.get('/auth/users-count', (_req, res) => {
  // publico: usado pelo signup pra mostrar "Voce sera o admin" ou nao
  res.json({ ok: true, count: usersLoad().length, requiresInvite: !!SIGNUP_INVITE_CODE });
});

// Rota /login serve a pagina HTML
app.get('/login', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));

// v4.33: rota raiz redireciona pra /app (que vai pedir login se nao autenticado)
app.get("/", (req, res) => res.redirect('/app'));
app.get("/app", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.use(express.static(path.join(__dirname, "public")));

// SSE clients
const sseClients = new Set();

function broadcastSSE(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(c => { try { c.write(msg); } catch (e) {} });
  // v4.32: tambem dispara push notification pra eventos de venda/cart/msg
  try { maybePushFromEvent(data); } catch (e) { console.error("[push hook]", e?.message); }
}

// Mapeia evento SSE -> push notification (so quando ha sub ativa)
function maybePushFromEvent(evt) {
  if (!evt || !evt.type) return;
  // Imports tardios pra evitar TDZ (pushBroadcast e definido depois)
  if (typeof pushBroadcast !== 'function') return;
  const platIcon = { greenn:'🌱', eduzz:'📘', hotmart:'🔥', kiwify:'🥝' };
  const fmtBR = (v) => 'R$ ' + Number(v||0).toFixed(2).replace('.', ',');
  let title = '', body = '', tag = '', url = '/app';

  if (['greenn_event','eduzz_event','hotmart_event','kiwify_event'].includes(evt.type)) {
    const plat = evt.type.replace('_event', '');
    const d = evt.data || {};
    const status = String(d.status || '').toLowerCase();
    const nome = d.name || d.email || 'Cliente';
    const prod = d.productName || '';
    tag = plat + '-' + (d.transactionId || Date.now());
    if (['paid','approved','complete'].includes(status)) {
      title = (platIcon[plat] || '🔔') + ' Venda aprovada — ' + fmtBR(d.total);
      body = nome + (prod ? ' — ' + prod : '');
    } else if (['abandoned','cart_abandoned','checkoutabandoned'].includes(status)) {
      title = (platIcon[plat] || '🔔') + ' Carrinho abandonado';
      body = nome + (prod ? ' — ' + prod : '');
    } else if (['refused','declined','canceled'].includes(status)) {
      title = (platIcon[plat] || '🔔') + ' Compra recusada';
      body = nome + (prod ? ' — ' + prod : '');
    } else { return; }
  } else if (evt.type === 'message_in') {
    const d = evt.data || {};
    title = 'Nova mensagem — ' + (d.pushname || d.from_id || 'Contato');
    body = (d.body || '(midia)').slice(0, 140);
    tag = 'msg-' + (d.chat_id || Date.now());
  } else { return; }

  // Dispara em background, nao bloqueia SSE
  pushBroadcast({ title, body, tag, url }).catch(e => console.error("[push broadcast]", e?.message));
}

// Health
app.get("/health", (req, res) => res.json({ ok: true, service: "speakers-crm-backend" }));

// ============================================================
// v4.32: WEB PUSH NOTIFICATIONS (VAPID) - mobile/PWA real push
// ============================================================
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "";
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:institutoideoficial@gmail.com";
const PUSH_SUBS_FILE = process.env.PUSH_SUBS_FILE || path.join(__dirname, "data", "push-subscriptions.json");

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  try {
    webPush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
    console.log("[push] VAPID configurado");
  } catch (e) { console.error("[push] VAPID erro:", e?.message); }
} else {
  console.warn("[push] VAPID nao configurado (sem env VAPID_PUBLIC_KEY/PRIVATE_KEY)");
}

function pushSubsLoad() {
  try { return JSON.parse(require('fs').readFileSync(PUSH_SUBS_FILE, 'utf8')); } catch { return []; }
}
function pushSubsSave(arr) {
  try { require('fs').writeFileSync(PUSH_SUBS_FILE, JSON.stringify(arr || [], null, 2)); }
  catch (e) { console.error("[push] save err", e?.message); }
}

// Envia push pra todas inscricoes. Remove inscricoes invalidas (410 Gone).
async function pushBroadcast(payload) {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return { sent: 0, removed: 0, skipped: "vapid nao configurado" };
  const subs = pushSubsLoad();
  if (subs.length === 0) return { sent: 0, removed: 0, skipped: "sem inscricoes" };
  const body = JSON.stringify(payload);
  let sent = 0, removed = 0;
  const stillValid = [];
  for (const s of subs) {
    try {
      await webPush.sendNotification(s.subscription, body);
      sent++;
      stillValid.push(s);
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) {
        removed++;
        console.log("[push] removida inscricao expirada", s.subscription?.endpoint?.slice(0, 60));
      } else {
        stillValid.push(s);
        console.error("[push] envio falhou", e?.statusCode, e?.message);
      }
    }
  }
  if (removed > 0) pushSubsSave(stillValid);
  return { sent, removed, total: subs.length };
}

// Endpoint publico (sem auth) pra SW pegar a chave VAPID publica
app.get("/api/push/vapid-public-key", (_req, res) => {
  if (!VAPID_PUBLIC_KEY) return res.status(503).json({ ok: false, error: "VAPID nao configurado" });
  res.json({ ok: true, publicKey: VAPID_PUBLIC_KEY });
});

// Inscreve um device pra receber push (precisa auth)
app.post("/api/push/subscribe", (req, res) => {
  try {
    const sub = req.body && req.body.subscription;
    if (!sub || !sub.endpoint) return res.status(400).json({ ok: false, error: "subscription invalida" });
    const subs = pushSubsLoad();
    // Evita duplicatas (mesma endpoint = mesmo device)
    const idx = subs.findIndex(s => s.subscription?.endpoint === sub.endpoint);
    const item = { subscription: sub, label: req.body.label || '', subscribedAt: Date.now() };
    if (idx >= 0) subs[idx] = item; else subs.push(item);
    pushSubsSave(subs);
    res.json({ ok: true, total: subs.length, replaced: idx >= 0 });
  } catch (e) { res.status(500).json({ ok: false, error: e?.message }); }
});

// Remove inscricao
app.post("/api/push/unsubscribe", (req, res) => {
  try {
    const endpoint = req.body && req.body.endpoint;
    if (!endpoint) return res.status(400).json({ ok: false, error: "endpoint obrigatorio" });
    const subs = pushSubsLoad();
    const filtered = subs.filter(s => s.subscription?.endpoint !== endpoint);
    pushSubsSave(filtered);
    res.json({ ok: true, removed: subs.length - filtered.length, total: filtered.length });
  } catch (e) { res.status(500).json({ ok: false, error: e?.message }); }
});

// Status: quantas inscricoes ativas
app.get("/api/push/status", (_req, res) => {
  const subs = pushSubsLoad();
  res.json({
    ok: true,
    configured: !!(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY),
    publicKey: VAPID_PUBLIC_KEY || null,
    totalSubscriptions: subs.length,
    devices: subs.map(s => ({ label: s.label || '', subscribedAt: s.subscribedAt, endpointHash: (s.subscription?.endpoint || '').slice(-30) }))
  });
});

// Envia push de teste pra todas inscricoes
app.post("/api/push/test", async (req, res) => {
  const r = await pushBroadcast({
    title: req.body?.title || "Imperador CRM - Teste",
    body: req.body?.body || "Funcionou! Notificacoes push reais ativas. 🎉",
    tag: "test-push",
    url: "/app"
  });
  res.json({ ok: true, ...r });
});

// v4.32: /healthz - deep healthcheck pra UptimeRobot/monitor externo (bypass auth)
// Retorna 200 OK se tudo crítico funciona, 503 se algo essencial caiu.
// Checa: app vivo, disk leitura/escrita data dir, anthropic key configurada, DNS propagated.
app.get("/healthz", async (req, res) => {
  const checks = {};
  let allOk = true;
  // 1. App vivo (sempre passa se response chega aqui)
  checks.app = { ok: true, uptimeSec: Math.round(process.uptime()) };
  // 2. Data dir leitura/escrita
  try {
    const fsLib = require('fs');
    const testFile = path.join(__dirname, 'data', '.healthz-write-test');
    fsLib.writeFileSync(testFile, String(Date.now()));
    fsLib.unlinkSync(testFile);
    checks.disk = { ok: true };
  } catch (e) { checks.disk = { ok: false, error: e?.message }; allOk = false; }
  // 3. AI config
  checks.ai = { ok: !!process.env.ANTHROPIC_API_KEY, configured: !!process.env.ANTHROPIC_API_KEY };
  // (nao bloqueia 503 se IA nao configurada — feature opcional)
  // 4. DNS propagated flag
  try {
    const flag = JSON.parse(require('fs').readFileSync(path.join(__dirname, 'data', 'dns-propagated.flag'), 'utf8'));
    checks.dns = { ok: !!flag.propagated, propagatedAt: flag.propagatedAt };
  } catch { checks.dns = { ok: false, hint: "ainda nao propagou" }; }
  // (nao bloqueia 503 — DNS pode tar fora se acessou via IP)
  // 5. Bravos opcional (se config quebrou, nao falha — feature)
  try {
    const r = await fetch(`${BRAVOS_URL}/health`, { headers: { 'bypass-tunnel-reminder': 'true' }, signal: AbortSignal.timeout(3000) });
    checks.bravos = { ok: r.ok, status: r.status };
  } catch (e) { checks.bravos = { ok: false, error: e?.message?.slice(0, 80) }; }

  const code = allOk ? 200 : 503;
  res.status(code).json({ ok: allOk, status: allOk ? "healthy" : "degraded", checks, ts: new Date().toISOString() });
});

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

// v4.33: Proxy do QR code do Bravos (autenticado pelo CRM)
// Bravos serve QR como pagina HTML em / e como imagem em /qr.png
app.get("/wa/qr", async (req, res) => {
  try {
    const r = await fetch(`${BRAVOS_URL}/qr.png`, { headers: { "bypass-tunnel-reminder": "true" } });
    if (r.ok) {
      const buf = Buffer.from(await r.arrayBuffer());
      res.setHeader('Content-Type', r.headers.get('content-type') || 'image/png');
      res.setHeader('Cache-Control', 'no-store');
      return res.send(buf);
    }
    // fallback: HTML page
    const r2 = await fetch(`${BRAVOS_URL}/`, { headers: { "bypass-tunnel-reminder": "true" } });
    const html = await r2.text();
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (e) {
    res.status(503).send(`<h2>Bravos offline</h2><p>${e?.message}</p>`);
  }
});

// QR do bravos-agent (2a instancia, numero dedicado do agente autonomo)
const BRAVOS_AGENT_URL = (process.env.BRAVOS_AGENT_URL || "http://bravos-agent:3001").replace(/\/$/, "");
app.get("/wa-agent/qr", async (req, res) => {
  try {
    const r = await fetch(`${BRAVOS_AGENT_URL}/qr.png`, { headers: { "bypass-tunnel-reminder": "true" } });
    if (r.ok) {
      const buf = Buffer.from(await r.arrayBuffer());
      res.setHeader('Content-Type', r.headers.get('content-type') || 'image/png');
      res.setHeader('Cache-Control', 'no-store');
      return res.send(buf);
    }
    const r2 = await fetch(`${BRAVOS_AGENT_URL}/`, { headers: { "bypass-tunnel-reminder": "true" } });
    const html = await r2.text();
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (e) {
    res.status(503).send(`<h2>bravos-agent offline</h2><p>${e?.message}</p>`);
  }
});

app.get("/wa-agent/status", async (req, res) => {
  try {
    const r = await fetch(`${BRAVOS_AGENT_URL}/health`, { headers: { "Authorization": `Bearer ${BRAVOS_TOKEN}` } });
    const d = await r.json().catch(() => ({}));
    // Compat com a UI generica: state='connected' quando ja autenticado e pronto
    if (d.isReady && d.isAuthenticated) d.state = "connected";
    res.json(d);
  } catch (e) {
    res.status(503).json({ error: e?.message });
  }
});

app.get("/wa-agent", async (req, res) => {
  res.send(`<!doctype html><html><head><meta charset="utf-8"><title>Conectar WhatsApp do Agente</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font-family:-apple-system,sans-serif;background:#0a0a0a;color:#e8e6e1;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:20px;text-align:center}
.box{max-width:520px;background:#141312;border:1px solid #262421;border-radius:14px;padding:28px}
h1{color:#C8A84B;margin:0 0 8px;font-size:22px}
.tag{display:inline-block;background:#C8A84B22;color:#C8A84B;border-radius:6px;padding:3px 10px;font-size:11px;margin-bottom:12px}
.qr{background:#fff;padding:14px;border-radius:10px;margin:18px auto;max-width:300px;display:block}
.qr img{width:100%;display:block}
.steps{text-align:left;font-size:13px;color:#8a8580;margin-top:16px;line-height:1.6}
.status{font-size:12px;color:#8a8580;margin-top:14px}
.status.on{color:#10b981}
</style></head><body>
<div class="box">
<span class="tag">AGENTE AUTONOMO</span>
<h1>📱 Conectar WhatsApp do Agente</h1>
<div style="font-size:13px;color:#8a8580">Escaneia o QR no celular do numero dedicado ao agente</div>
<div class="qr"><img src="/wa-agent/qr?t=${Date.now()}" id="qrimg" onerror="this.parentElement.innerHTML='<div style=\\'color:#666;padding:30px\\'>QR carregando ou ja autenticado...</div>'"></div>
<div class="steps">
<strong>Como escanear:</strong><br>
1. Abre WhatsApp no celular do <strong>numero do agente</strong><br>
2. ⋮ menu &rarr; Aparelhos conectados<br>
3. <strong>Conectar um aparelho</strong><br>
4. Aponta camera pro QR acima
</div>
<div class="status" id="st">Aguardando conexao...</div>
</div>
<script>
async function check(){
  try{
    var r = await fetch('/wa-agent/status');
    var d = await r.json();
    var conn = d.state === 'connected' || (d.instance && d.instance.isReady);
    var st = document.getElementById('st');
    if(conn){ st.className='status on'; st.innerHTML='✅ Conectado! Pode fechar essa pagina.'; document.getElementById('qrimg').style.opacity='.3'; return; }
    setTimeout(function(){ document.getElementById('qrimg').src='/wa-agent/qr?t='+Date.now(); check(); }, 4000);
  }catch(e){ setTimeout(check, 5000); }
}
setTimeout(check, 2000);
</script>
</body></html>`);
});

// Pagina amigavel pra escanear QR
app.get("/wa", async (req, res) => {
  res.send(`<!doctype html><html><head><meta charset="utf-8"><title>Conectar WhatsApp</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font-family:-apple-system,sans-serif;background:#0a0a0a;color:#e8e6e1;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:20px;text-align:center}
.box{max-width:520px;background:#141312;border:1px solid #262421;border-radius:14px;padding:28px}
h1{color:#C8A84B;margin:0 0 8px;font-size:22px}
.qr{background:#fff;padding:14px;border-radius:10px;margin:18px auto;max-width:300px;display:block}
.qr img{width:100%;display:block}
.steps{text-align:left;font-size:13px;color:#8a8580;margin-top:16px;line-height:1.6}
.status{font-size:12px;color:#8a8580;margin-top:14px}
.status.on{color:#10b981}
.btn{display:inline-block;margin-top:14px;padding:8px 18px;background:#C8A84B;color:#111;border-radius:8px;text-decoration:none;font-weight:700}
</style></head><body>
<div class="box">
<h1>📱 Conectar WhatsApp</h1>
<div style="font-size:13px;color:#8a8580">Escaneia o QR no seu celular</div>
<div class="qr"><img src="/wa/qr?t=${Date.now()}" id="qrimg" onerror="this.parentElement.innerHTML='<div style=\\'color:#666;padding:30px\\'>QR carregando ou ja autenticado...</div>'"></div>
<div class="steps">
<strong>Como escanear:</strong><br>
1. Abre WhatsApp no celular<br>
2. ⋮ menu &rarr; Aparelhos conectados<br>
3. <strong>Conectar um aparelho</strong><br>
4. Aponta camera pro QR acima
</div>
<div class="status" id="st">Aguardando conexao...</div>
<a class="btn" href="/app">&larr; Voltar pro CRM</a>
</div>
<script>
async function check(){
  try{
    var r = await fetch('/api/status/speakers-crm');
    var d = await r.json();
    var conn = d.state === 'connected' || (d.instance && d.instance.isReady);
    var st = document.getElementById('st');
    if(conn){ st.className='status on'; st.innerHTML='✅ Conectado! Pode fechar essa pagina.'; document.getElementById('qrimg').style.opacity='.3'; return; }
    setTimeout(function(){ document.getElementById('qrimg').src='/wa/qr?t='+Date.now(); check(); }, 4000);
  }catch(e){ setTimeout(check, 5000); }
}
setTimeout(check, 2000);
</script>
</body></html>`);
});

// Enviar mensagem via Bravos
app.post("/api/send-message", async (req, res) => {
  try {
    const { phone, message } = req.body;
    if (!phone || !message) return res.status(400).json({ error: "phone e message sao obrigatorios" });
    const clean = String(phone).replace(/\D/g, "");

    // v4.34: detecta @lid (formato interno de grupo do WhatsApp - >13 digitos)
    // WhatsApp NAO permite mensagem direta pra LID, so via grupo original
    if (clean.length > 14) {
      return res.status(400).json({
        ok: false,
        source: "validation",
        error: "Esse contato eh um identificador interno de grupo (@lid), nao um numero WhatsApp real. Mensagens diretas pra LIDs nao sao permitidas pelo WhatsApp. Acessa via grupo original ou pede o numero direto pro contato.",
        isLid: true,
        clean
      });
    }

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
const AGENT_URL = (process.env.AGENT_URL || "").replace(/\/$/, "");

async function forwardToAgent(inner) {
  if (!AGENT_URL) return;
  if (!inner || inner.fromMe) return;
  const phone = String(inner.from_id || (inner.chat_id || "").split("@")[0] || "").replace(/\D/g, "");
  const message = String(inner.body || "").trim();
  if (!phone || !message) return;
  try {
    await fetch(`${AGENT_URL}/inbox`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone, message, name: inner.pushname || null, chatId: inner.chat_id || null })
    });
  } catch (e) {
    console.error("[agent-fanout]", e?.message);
  }
}

// v4.34: Proxy endpoints pra UI acessar o agent (autenticado pelo CRM)
app.get("/api/agent/healthz", async (_req, res) => {
  if (!AGENT_URL) return res.status(503).json({ ok: false, error: "AGENT_URL nao configurado" });
  try {
    const r = await fetch(`${AGENT_URL}/healthz`);
    const d = await r.json();
    res.json(d);
  } catch (e) { res.status(502).json({ ok: false, error: e?.message }); }
});

app.get("/api/agent/outbox", async (req, res) => {
  if (!AGENT_URL) return res.status(503).json({ ok: false, error: "AGENT_URL nao configurado" });
  try {
    const status = req.query.status || "pending";
    const limit = req.query.limit || 100;
    const r = await fetch(`${AGENT_URL}/outbox?status=${encodeURIComponent(status)}&limit=${limit}`);
    const d = await r.json();
    res.json(d);
  } catch (e) { res.status(502).json({ ok: false, error: e?.message }); }
});

app.post("/api/agent/outbox/:id/decide", async (req, res) => {
  if (!AGENT_URL) return res.status(503).json({ ok: false, error: "AGENT_URL nao configurado" });
  try {
    const r = await fetch(`${AGENT_URL}/outbox/${encodeURIComponent(req.params.id)}/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body || {})
    });
    const d = await r.json();
    res.status(r.status).json(d);
  } catch (e) { res.status(502).json({ ok: false, error: e?.message }); }
});

app.post("/api/agent/mode", async (req, res) => {
  // helper: muda mode via tool set_mode chamando /inbox? nao, melhor expor /mode
  // mas agent atual /mode eh GET. Vou usar /inbox com msg auto-enviada da Vanessa
  if (!AGENT_URL) return res.status(503).json({ ok: false, error: "AGENT_URL nao configurado" });
  const mode = req.body && req.body.mode;
  if (!["treino", "review", "producao"].includes(mode)) return res.status(400).json({ ok: false, error: "mode invalido" });
  try {
    const r = await fetch(`${AGENT_URL}/mode`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode })
    });
    const d = await r.json();
    res.status(r.status).json(d);
  } catch (e) { res.status(502).json({ ok: false, error: e?.message }); }
});

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
      if (innerType === "message_in") {
        forwardToAgent(inner);
      }
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
// v4.32: aceita ambos os nomes (GREENN_TOKEN preferido). Vazio = modo aberto.
const GREENN_TOKEN = process.env.GREENN_TOKEN || process.env.GREENN_WEBHOOK_TOKEN || "";
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
    // Auth opcional via token simples
    if (GREENN_TOKEN) {
      const sent = req.headers["x-webhook-token"] || req.headers["authorization"]?.replace(/^Bearer\s+/i, "") || req.query.token;
      if (sent !== GREENN_TOKEN) {
        return res.status(401).json({ ok: false, error: "token invalido" });
      }
    }
    // v4.32: HMAC opt-in (setar GREENN_HMAC_SECRET no .env)
    if (process.env.GREENN_HMAC_SECRET && !verifyHmacOptional(req, process.env.GREENN_HMAC_SECRET, ['x-greenn-signature','x-webhook-signature','x-hub-signature-256'])) {
      return res.status(401).json({ ok: false, error: "hmac invalido" });
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

// v4.32: Tags persistentes cross-platform (server-side, indexadas por phone)
const CONTACT_TAGS_FILE = process.env.CONTACT_TAGS_FILE || path.join(__dirname, "data", "contact-tags.json");
function contactTagsLoad() {
  try { return JSON.parse(require('fs').readFileSync(CONTACT_TAGS_FILE, 'utf8')); } catch { return {}; }
}
function contactTagsSave(map) {
  try { require('fs').writeFileSync(CONTACT_TAGS_FILE, JSON.stringify(map || {}, null, 2)); }
  catch (e) { console.error('[contact-tags]', e?.message); }
}

// v4.32: HMAC verification opcional pra webhooks. Suporta multiplos formatos comuns.
// Ativa setando XXX_HMAC_SECRET no .env (ex: GREENN_HMAC_SECRET, EDUZZ_HMAC_SECRET, etc)
function verifyHmacOptional(req, secret, headerNames) {
  if (!secret) return true; // opt-in: se secret vazio, libera (compat)
  const crypto = require('crypto');
  let signature = '';
  for (const h of headerNames) {
    const v = req.headers[h.toLowerCase()];
    if (v) { signature = String(v).replace(/^sha256=/i, '').replace(/^Bearer\s+/i, ''); break; }
  }
  if (!signature) return false;
  // req.rawBody precisa estar disponivel - middleware adicionado abaixo
  const raw = req.rawBody || JSON.stringify(req.body || {});
  const expected = crypto.createHmac('sha256', secret).update(raw).digest('hex');
  // const-time compare
  try {
    const a = Buffer.from(signature, 'hex');
    const b = Buffer.from(expected, 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch { return false; }
}

// Helper: agrega contatos unicos cross-plataforma (v4.32: aceita {from,to} em ms)
function aggregateContacts(opts) {
  const fsLib = require('fs');
  function tryLoad(file) { try { return JSON.parse(fsLib.readFileSync(file, 'utf8')); } catch { return []; } }
  const fromTs = Number(opts && opts.from) || 0;
  const toTs   = Number(opts && opts.to)   || (Date.now() + 1);
  const sources = [
    ['greenn', GREENN_FILE], ['eduzz', EDUZZ_FILE], ['hotmart', HOTMART_FILE],
    ['kiwify', KIWIFY_FILE], ['generic', GENERIC_FILE]
  ];
  const byPhone = {};
  sources.forEach(([source, f]) => {
    tryLoad(f).forEach(ev => {
      if (!ev.phone) return;
      if (fromTs && ev.receivedAt < fromTs) return;
      if (toTs   && ev.receivedAt > toTs)   return;
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
  const all = aggregateContacts({ from: req.query.from, to: req.query.to });
  const search = String(req.query.search || '').toLowerCase().trim();
  const filtered = search
    ? all.filter(c => [c.name, c.phone, c.email].join(' ').toLowerCase().includes(search))
    : all;
  // v4.32: tags persistentes
  const tagsMap = contactTagsLoad();
  filtered.forEach(c => { c.tags = tagsMap[c.phone] || []; });
  const limit = Math.min(Number(req.query.limit) || 100, 1000);
  res.json({ ok: true, total: all.length, count: filtered.length, items: filtered.slice(0, limit), filter: { from: req.query.from || null, to: req.query.to || null, search: search || null } });
});

// v4.32: Tags persistentes cross-platform (server-side)
app.get("/api/contacts/:phone/tags", (req, res) => {
  const phone = String(req.params.phone || '').replace(/\D/g, '');
  if (!phone) return res.status(400).json({ ok: false, error: "phone invalido" });
  const map = contactTagsLoad();
  res.json({ ok: true, phone, tags: map[phone] || [] });
});
app.put("/api/contacts/:phone/tags", (req, res) => {
  const phone = String(req.params.phone || '').replace(/\D/g, '');
  if (!phone) return res.status(400).json({ ok: false, error: "phone invalido" });
  let tags = req.body && req.body.tags;
  if (typeof tags === 'string') tags = tags.split(',').map(s => s.trim()).filter(Boolean);
  if (!Array.isArray(tags)) return res.status(400).json({ ok: false, error: "tags deve ser array ou string CSV" });
  // sanitiza: max 20 tags, lowercase, alfanumerico+hifen+espaco, max 30 chars cada
  tags = Array.from(new Set(tags.map(t => String(t).toLowerCase().replace(/[^a-z0-9\u00c0-\u017f\- ]/g, '').trim()).filter(t => t.length > 0 && t.length <= 30))).slice(0, 20);
  const map = contactTagsLoad();
  if (tags.length === 0) delete map[phone]; else map[phone] = tags;
  contactTagsSave(map);
  res.json({ ok: true, phone, tags });
});
// v4.32: Sync convs PC<->celular (server-side persistence opt-in)
// Persiste o "estado da UI" (convs, flags, tags locais, templates, prefs) por bucket
// Estrategia: last-write-wins simples (cada device manda updatedAt; merge no cliente)
const CONV_SYNC_FILE = process.env.CONV_SYNC_FILE || path.join(__dirname, "data", "conv-sync.json");
const CONV_SYNC_MAX_BYTES = 5 * 1024 * 1024; // 5MB cap
function convSyncLoad() {
  try { return JSON.parse(require('fs').readFileSync(CONV_SYNC_FILE, 'utf8')); }
  catch { return { updatedAt: 0, payload: {} }; }
}
function convSyncSave(state) {
  try {
    const s = JSON.stringify(state || {});
    if (s.length > CONV_SYNC_MAX_BYTES) throw new Error('payload muito grande (max 5MB)');
    require('fs').writeFileSync(CONV_SYNC_FILE, s);
  } catch (e) { console.error('[conv-sync]', e?.message); throw e; }
}
app.get("/api/conv/sync", (_req, res) => {
  const s = convSyncLoad();
  res.json({ ok: true, updatedAt: s.updatedAt, payload: s.payload });
});
app.post("/api/conv/sync", (req, res) => {
  try {
    const incoming = req.body || {};
    const incomingAt = Number(incoming.updatedAt) || Date.now();
    const current = convSyncLoad();
    // Last-write-wins por bucket key (convs/flags/tags/templates/prefs)
    const merged = { updatedAt: Math.max(current.updatedAt || 0, incomingAt), payload: { ...current.payload } };
    if (incoming.payload && typeof incoming.payload === 'object') {
      Object.entries(incoming.payload).forEach(([k, v]) => {
        // se cliente esta mais novo, sobrescreve; senao mantem
        if (incomingAt >= (current.updatedAt || 0)) merged.payload[k] = v;
      });
    }
    convSyncSave(merged);
    res.json({ ok: true, updatedAt: merged.updatedAt, bucketCount: Object.keys(merged.payload).length });
  } catch (e) { res.status(500).json({ ok: false, error: e?.message }); }
});

// v4.32: status do DNS watch (cron na VPS docker-exec escreve flag em /app/data/)
app.get("/api/dns-status", (_req, res) => {
  const flag = process.env.DNS_FLAG_FILE || path.join(__dirname, "data", "dns-propagated.flag");
  try {
    const data = JSON.parse(require('fs').readFileSync(flag, 'utf8'));
    res.json({ ok: true, ...data });
  } catch {
    res.json({ ok: true, propagated: false, propagatedAt: null, hint: "DNS ainda nao propagou. Cron na VPS checa a cada hora (xx:23)." });
  }
});

// v4.34: registra lead via Sofia/agent (cria/atualiza tags + nota)
app.post("/api/contacts/:phone/lead", (req, res) => {
  const phone = String(req.params.phone || '').replace(/\D/g, '');
  if (!phone) return res.status(400).json({ ok: false, error: "phone invalido" });
  const tags = Array.isArray(req.body?.tags) ? req.body.tags : (req.body?.tags ? [req.body.tags] : ["lead"]);
  const note = String(req.body?.note || "").slice(0, 500);
  const map = contactTagsLoad();
  if (!map[phone]) map[phone] = [];
  tags.forEach(t => {
    const clean = String(t).toLowerCase().replace(/[^a-z0-9\u00c0-\u017f\- ]/g, '').trim().slice(0, 30);
    if (clean && !map[phone].includes(clean)) map[phone].push(clean);
  });
  contactTagsSave(map);
  // log no audit (reusa estrutura existente do scheduled? ou simples log)
  console.log(`[lead] ${phone} tags=[${map[phone].join(',')}] note="${note}"`);
  broadcastSSE({ type: "lead_registered", data: { phone, tags: map[phone], note } });
  res.json({ ok: true, phone, tags: map[phone], note });
});

app.get("/api/contacts/tags/all", (_req, res) => {
  const map = contactTagsLoad();
  const counts = {};
  Object.values(map).forEach(arr => arr.forEach(t => { counts[t] = (counts[t] || 0) + 1; }));
  res.json({ ok: true, total: Object.keys(map).length, tags: Object.entries(counts).sort((a,b)=>b[1]-a[1]).map(([tag, count]) => ({ tag, count })) });
});

app.get("/api/contacts.csv", (req, res) => {
  const all = aggregateContacts({ from: req.query.from, to: req.query.to });
  const tagsMap = contactTagsLoad();
  const flat = all.map(c => ({
    phone: c.phone, name: c.name, email: c.email,
    events: c.events, paid: c.paid, totalValue: c.totalValue,
    sources: Object.keys(c.sources).join('|'),
    tags: (tagsMap[c.phone] || []).join('|'),
    topProduct: Object.keys(c.products).sort((a,b)=>c.products[b]-c.products[a])[0] || '',
    firstSeenAt: c.firstSeenAt ? new Date(c.firstSeenAt).toISOString() : '',
    lastSeenAt: c.lastSeenAt ? new Date(c.lastSeenAt).toISOString() : ''
  }));
  const csv = platformUtils.eventsToCSV(flat, ['phone','name','email','events','paid','totalValue','sources','tags','topProduct','firstSeenAt','lastSeenAt']);
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
    let { recipients, contacts, message, dryRun } = req.body || {};
    // v4.32: aceita tambem "contacts:[{phone,name}]" da UI nova (alem de "recipients:[phone,...]")
    if (!recipients && Array.isArray(contacts)) {
      recipients = contacts.map(c => (c && (c.phone || c)) || '').filter(Boolean);
    }
    if (!Array.isArray(recipients) || recipients.length === 0) return res.status(400).json({ ok: false, error: "recipients[] (ou contacts[]) obrigatorio" });
    if (!message) return res.status(400).json({ ok: false, error: "message obrigatorio" });
    // v4.32: expande {nome} pelo contact name quando disponivel
    const nameByPhone = {};
    if (Array.isArray(contacts)) contacts.forEach(c => { if (c && c.phone) nameByPhone[String(c.phone).replace(/\D/g, '')] = c.name || ''; });

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
      // v4.32: expande {nome}/{telefone}/{hora}/{dia} pra cada destinatario
      const nm = (nameByPhone[cleanPhone] || '').split(' ')[0] || '';
      const now = new Date();
      const hora = String(now.getHours()).padStart(2,'0') + ':' + String(now.getMinutes()).padStart(2,'0');
      const dia = String(now.getDate()).padStart(2,'0') + '/' + String(now.getMonth()+1).padStart(2,'0');
      const expanded = String(message)
        .replace(/\{nome\}/g, nm)
        .replace(/\{telefone\}/g, cleanPhone)
        .replace(/\{hora\}/g, hora)
        .replace(/\{dia\}/g, dia);
      const item = {
        id: schedNewId(),
        phone: cleanPhone,
        message: expanded,
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
    // v4.32: alias "scheduled" pra compatibilidade com UI nova que esperava esse campo
    res.json({ ok: true, scheduled: ids.length, scheduledCount: ids.length, scheduledIds: ids, spreadOverMin: Math.ceil(recipients.length * BULK_DELAY_SEC / 60), remainingToday: remaining - ids.length });
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
    if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ ok: false, error: "ANTHROPIC_API_KEY nao configurada", hint: "no painel do CRM va em Integracoes pra configurar" });
    // v4.32: aceita "context" da UI nova (alias pra productHint)
    const { status, platform, productHint, context, tone } = req.body || {};
    const ctx = productHint || context || '';
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const prompt = `Voce eh assistente da Vanessa Labastie da Speakers Play Academy (formacao em oratoria, NeuroHeart). Gere UM template curto de WhatsApp pra responder automaticamente quando:
- Plataforma: ${platform || "qualquer"}
- Status do evento: ${status || "qualquer"}
${ctx ? '- Contexto produto/oferta: ' + ctx : ''}
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

// v4.34: Dashboard unificado - agrega receita+inscritos de TODAS as fontes
app.get("/api/insights/unified", async (_req, res) => {
  try {
    const tryLoad = f => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return []; } };
    const platforms = [
      { id: "greenn", file: GREENN_FILE, color: "#10b981", icon: "🌱" },
      { id: "eduzz", file: EDUZZ_FILE, color: "#3b82f6", icon: "📘" },
      { id: "hotmart", file: HOTMART_FILE, color: "#ef5f1e", icon: "🔥" },
      { id: "kiwify", file: KIWIFY_FILE, color: "#a3e635", icon: "🥝" }
    ];
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const startOfDay = d => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x.getTime(); };
    const today = startOfDay(now);
    const week = now - 7 * day;
    const month = now - 30 * day;
    const paidStatuses = new Set(["paid", "approved", "complete"]);
    const summary = { hoje: { total: 0, count: 0 }, ultimos7: { total: 0, count: 0 }, ultimos30: { total: 0, count: 0 } };
    const byPlat = [];
    platforms.forEach(p => {
      const evs = tryLoad(p.file);
      const paidEvs = evs.filter(e => paidStatuses.has(String(e.status || "").toLowerCase()));
      const inWindow = (cutoff) => paidEvs.filter(e => (e.receivedAt || 0) >= cutoff);
      const sum = arr => arr.reduce((s, e) => s + (Number(e.total) || 0), 0);
      const t7 = inWindow(week), t30 = inWindow(month), tt = inWindow(today);
      const platTotal = sum(t30);
      byPlat.push({
        id: p.id, color: p.color, icon: p.icon,
        eventsTotal: evs.length, paidTotal: paidEvs.length,
        receitaHoje: Math.round(sum(tt) * 100) / 100,
        receita7: Math.round(sum(t7) * 100) / 100,
        receita30: Math.round(platTotal * 100) / 100,
        countHoje: tt.length, count7: t7.length, count30: t30.length
      });
      summary.hoje.total += sum(tt); summary.hoje.count += tt.length;
      summary.ultimos7.total += sum(t7); summary.ultimos7.count += t7.length;
      summary.ultimos30.total += sum(t30); summary.ultimos30.count += t30.length;
    });
    Object.values(summary).forEach(s => { s.total = Math.round(s.total * 100) / 100; });

    // Eventos manager (nao-monetizado se preço=0)
    const events = tryLoad(EVENTS_FILE);
    const tickets = tryLoad(TICKETS_FILE);
    const eventsAgg = {
      totalEvents: events.length,
      published: events.filter(e => e.status === "published").length,
      totalTickets: tickets.length,
      checkedIn: tickets.filter(t => t.status === "used").length,
      receita30: Math.round(tickets.filter(t => t.createdAt >= month).reduce((s, t) => s + (Number(t.price) || 0), 0) * 100) / 100,
      ticketsHoje: tickets.filter(t => t.createdAt >= today).length
    };

    // Serie 7 dias (vendas paid + inscritos)
    const days7 = [];
    for (let i = 6; i >= 0; i--) {
      const dStart = startOfDay(now - i * day);
      const dEnd = dStart + day;
      let receita = 0, vendas = 0, inscritos = 0;
      platforms.forEach(p => {
        tryLoad(p.file).forEach(e => {
          if (e.receivedAt >= dStart && e.receivedAt < dEnd && paidStatuses.has(String(e.status || "").toLowerCase())) {
            receita += Number(e.total) || 0;
            vendas++;
          }
        });
      });
      tickets.forEach(t => { if (t.createdAt >= dStart && t.createdAt < dEnd) inscritos++; });
      days7.push({
        date: new Date(dStart).toISOString().slice(0, 10),
        label: new Date(dStart).toLocaleDateString("pt-BR", { weekday: "short", day: "2-digit" }),
        receita: Math.round(receita * 100) / 100,
        vendas, inscritos
      });
    }

    res.json({ ok: true, summary, platforms: byPlat, events: eventsAgg, days7, generatedAt: now });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message });
  }
});

// v4.34: Resumo diario formatado pra WhatsApp (Sofia ou direto)
function dailySummaryText() {
  const tryLoad = f => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return []; } };
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const startOfDay = d => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x.getTime(); };
  const yesterday = startOfDay(now - day);
  const yesterdayEnd = startOfDay(now);
  const today = startOfDay(now);
  const tomorrow = today + day;
  const paidStatuses = new Set(["paid", "approved", "complete"]);
  const fmtBRL = n => "R$ " + (Number(n) || 0).toFixed(2).replace(".", ",");

  const platforms = [
    { id: "Greenn", file: GREENN_FILE, icon: "🌱" },
    { id: "Eduzz", file: EDUZZ_FILE, icon: "📘" },
    { id: "Hotmart", file: HOTMART_FILE, icon: "🔥" },
    { id: "Kiwify", file: KIWIFY_FILE, icon: "🥝" }
  ];
  let totalReceita = 0, totalVendas = 0, totalAbandonadas = 0;
  const platLines = [];
  platforms.forEach(p => {
    const evs = tryLoad(p.file).filter(e => (e.receivedAt || 0) >= yesterday && (e.receivedAt || 0) < yesterdayEnd);
    const paid = evs.filter(e => paidStatuses.has(String(e.status || "").toLowerCase()));
    const aband = evs.filter(e => ["abandoned", "checkoutabandoned"].includes(String(e.status || "").toLowerCase()));
    const receita = paid.reduce((s, e) => s + (Number(e.total) || 0), 0);
    if (paid.length || aband.length) {
      platLines.push(`${p.icon} ${p.id}: ${paid.length} venda${paid.length === 1 ? '' : 's'} ${fmtBRL(receita)}${aband.length ? ` (${aband.length} abandonado${aband.length === 1 ? '' : 's'})` : ''}`);
    }
    totalReceita += receita;
    totalVendas += paid.length;
    totalAbandonadas += aband.length;
  });

  const eventosManager = tryLoad(EVENTS_FILE);
  const tickets = tryLoad(TICKETS_FILE);
  const inscritosOntem = tickets.filter(t => t.createdAt >= yesterday && t.createdAt < yesterdayEnd).length;
  const eventosProximos = eventosManager.filter(e => e.status === "published" && e.startAt && e.startAt >= today && e.startAt < tomorrow + 7 * day).slice(0, 3);

  const sched = (typeof schedLoad === "function" ? schedLoad() : []).filter(s => s.status === "pending");
  const dataIso = new Date(yesterday).toLocaleDateString("pt-BR");
  const partes = [`☀️ *Bom dia!* Resumo de ontem (${dataIso})`, ""];

  if (totalVendas > 0) {
    partes.push(`💰 *Receita: ${fmtBRL(totalReceita)}* (${totalVendas} venda${totalVendas === 1 ? '' : 's'})`);
    platLines.forEach(l => partes.push(`  • ${l}`));
  } else if (totalAbandonadas > 0) {
    partes.push(`💰 Sem vendas. ${totalAbandonadas} carrinho${totalAbandonadas === 1 ? '' : 's'} abandonado${totalAbandonadas === 1 ? '' : 's'} 😬`);
  } else {
    partes.push(`💰 Sem movimento ontem.`);
  }
  partes.push("");

  if (inscritosOntem > 0) {
    partes.push(`🎟️ ${inscritosOntem} inscrição${inscritosOntem === 1 ? '' : 'ões'} novas em eventos`);
  }
  if (eventosProximos.length > 0) {
    partes.push(`📅 *Próximos 7 dias:*`);
    eventosProximos.forEach(e => {
      const d = new Date(e.startAt).toLocaleDateString("pt-BR", { weekday: "short", day: "2-digit", month: "2-digit" });
      partes.push(`  • ${d} — ${e.title}`);
    });
  }
  partes.push("");

  if (sched.length > 0) {
    partes.push(`📤 ${sched.length} mensagem${sched.length === 1 ? '' : 's'} agendada${sched.length === 1 ? '' : 's'} pra hoje`);
  }
  partes.push(`👀 Veja tudo: https://crm.institutoideoficial.com.br/app`);

  return partes.join("\n");
}

app.get("/api/insights/daily-summary", (_req, res) => {
  res.json({ ok: true, text: dailySummaryText() });
});

app.post("/api/insights/daily-summary/send", async (req, res) => {
  try {
    const phone = req.body?.phone || process.env.DAILY_SUMMARY_PHONE || "5512982933600";
    const text = dailySummaryText();
    const r = await fetch(`http://127.0.0.1:${PORT}/api/send-message`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": req.headers.authorization || "" },
      body: JSON.stringify({ phone, message: text })
    });
    const d = await r.json();
    res.json({ ok: r.ok, sent: d, text });
  } catch (e) { res.status(500).json({ ok: false, error: e?.message }); }
});

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
    // v4.32: filtros opcionais ?from=ms&to=ms&source=greenn&status=paid
    const fromTs = Number(req.query.from) || 0;
    const toTs   = Number(req.query.to)   || (Date.now() + 1);
    const srcFilter = String(req.query.source || '').toLowerCase().trim();
    const stFilter  = String(req.query.status || '').toLowerCase().trim();
    let filtered = all.filter(e => {
      if (fromTs && (e.receivedAt || 0) < fromTs) return false;
      if (toTs && (e.receivedAt || 0) > toTs) return false;
      if (srcFilter && e.source !== srcFilter) return false;
      if (stFilter && String(e.status || '').toLowerCase() !== stFilter) return false;
      return true;
    });
    filtered.sort((a, b) => (b.receivedAt || 0) - (a.receivedAt || 0));
    const csv = platformUtils.eventsToCSV(filtered, ['receivedAt', 'source', 'event', 'status', 'statusLabel', 'name', 'phone', 'email', 'productName', 'total', 'currency', 'transactionId', 'paymentType', 'installments']);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="imperador-all-events-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
  } catch (e) { res.status(500).json({ ok: false, error: e?.message }); }
});

// ============================================================
// v4.34: INTEGRACAO INSTAGRAM DMs (Meta Graph API)
// ============================================================
// Reusa GOOGLE_CLIENT_ID/SECRET da Meta App (Imperador CRM)? NAO - Meta tem seu proprio
const META_APP_ID = process.env.META_APP_ID || "";
const META_APP_SECRET = process.env.META_APP_SECRET || "";
const META_API_VERSION = process.env.META_API_VERSION || "v22.0";
const IG_VERIFY_TOKEN = process.env.IG_VERIFY_TOKEN || "imperador-ig-verify-2026";
const IG_TOKENS_FILE = process.env.IG_TOKENS_FILE || path.join(__dirname, "data", "instagram-tokens.json");
const IG_EVENTS_FILE = process.env.IG_EVENTS_FILE || path.join(__dirname, "data", "instagram-events.json");
const IG_EVENTS_MAX = 200;
// AGENT_URL ja declarado em cima (linha 642)

function igTokensLoad() { try { return JSON.parse(require("fs").readFileSync(IG_TOKENS_FILE, "utf8")); } catch { return null; } }
function igTokensSave(t) { try { require("fs").writeFileSync(IG_TOKENS_FILE, JSON.stringify(t || null, null, 2)); } catch (e) { console.error("[ig tokens]", e?.message); } }
function igEventsLoad() { try { return JSON.parse(require("fs").readFileSync(IG_EVENTS_FILE, "utf8")); } catch { return []; } }
function igEventsSave(arr) { try { require("fs").writeFileSync(IG_EVENTS_FILE, JSON.stringify((arr||[]).slice(-IG_EVENTS_MAX), null, 2)); } catch (e) { console.error("[ig events]", e?.message); } }
function igConfigured() { return !!(META_APP_ID && META_APP_SECRET); }
function igRedirectUri(req) { return process.env.IG_REDIRECT_URI || `${req.protocol}://${req.get("host")}/oauth/instagram/callback`; }

// Inicia OAuth Facebook Login - precisa Page + IG Business
app.get("/oauth/instagram/authorize", (req, res) => {
  if (!igConfigured()) {
    return res.status(400).send(`<h2>Instagram nao configurado</h2>
      <p>Setar META_APP_ID e META_APP_SECRET no .env (mesmas credenciais do app Meta Developers).</p>
      <p>Veja docs em /docs/INSTAGRAM_SETUP.md</p>`);
  }
  const state = crypto.randomBytes(16).toString("hex");
  const params = new URLSearchParams({
    client_id: META_APP_ID,
    redirect_uri: igRedirectUri(req),
    state,
    response_type: "code",
    scope: [
      "instagram_basic",
      "instagram_manage_messages",
      "pages_show_list",
      "pages_messaging",
      "pages_manage_metadata",
      "business_management"
    ].join(",")
  });
  res.redirect(`https://www.facebook.com/${META_API_VERSION}/dialog/oauth?${params}`);
});

app.get("/oauth/instagram/callback", async (req, res) => {
  try {
    if (!igConfigured()) return res.status(400).send("Meta App nao configurado");
    const { code, error } = req.query;
    if (error) return res.status(400).send(`<h3>Erro OAuth:</h3><pre>${error}</pre><a href="/app">voltar</a>`);
    if (!code) return res.status(400).send("Sem code");
    const tokenUrl = `https://graph.facebook.com/${META_API_VERSION}/oauth/access_token?` + new URLSearchParams({
      client_id: META_APP_ID,
      client_secret: META_APP_SECRET,
      redirect_uri: igRedirectUri(req),
      code: String(code)
    });
    const r = await fetch(tokenUrl);
    const td = await r.json();
    if (!r.ok || !td.access_token) {
      return res.status(500).send(`<h3>Falha token:</h3><pre>${JSON.stringify(td, null, 2)}</pre>`);
    }
    // Troca por long-lived token (60 dias)
    const llUrl = `https://graph.facebook.com/${META_API_VERSION}/oauth/access_token?` + new URLSearchParams({
      grant_type: "fb_exchange_token",
      client_id: META_APP_ID,
      client_secret: META_APP_SECRET,
      fb_exchange_token: td.access_token
    });
    const r2 = await fetch(llUrl);
    const ll = await r2.json();
    const userToken = ll.access_token || td.access_token;
    // Lista paginas do user pra achar a IG conectada
    const pagesR = await fetch(`https://graph.facebook.com/${META_API_VERSION}/me/accounts?` + new URLSearchParams({ access_token: userToken, fields: "id,name,access_token,instagram_business_account{id,username}" }));
    const pagesD = await pagesR.json();
    const pageWithIG = (pagesD.data || []).find(p => p.instagram_business_account);
    if (!pageWithIG) {
      return res.status(400).send(`<h3>Nenhuma Pagina Facebook com Instagram Business conectado.</h3>
        <p>Vincula seu Insta Business a uma Pagina Facebook em facebook.com/settings/?tab=linked_profiles e tenta de novo.</p>
        <pre>${JSON.stringify(pagesD, null, 2)}</pre>`);
    }
    const tokens = {
      userAccessToken: userToken,
      pageId: pageWithIG.id,
      pageName: pageWithIG.name,
      pageAccessToken: pageWithIG.access_token,
      igUserId: pageWithIG.instagram_business_account.id,
      igUsername: pageWithIG.instagram_business_account.username,
      connectedAt: Date.now(),
      expiresAt: Date.now() + 55 * 24 * 60 * 60 * 1000  // ~55d safe
    };
    igTokensSave(tokens);
    // Subscribe nos eventos da page (necessario pra receber DMs)
    try {
      await fetch(`https://graph.facebook.com/${META_API_VERSION}/${pageWithIG.id}/subscribed_apps`, {
        method: "POST",
        body: new URLSearchParams({ subscribed_fields: "messages,messaging_postbacks", access_token: pageWithIG.access_token })
      });
    } catch (e) { console.error("[ig subscribe]", e?.message); }
    res.send(`<h2>Instagram conectado!</h2>
      <p><strong>@${tokens.igUsername}</strong> via Pagina <strong>${tokens.pageName}</strong></p>
      <p>Token long-lived expira em ~55d (renova auto antes disso).</p>
      <a href="/app">Voltar pro CRM</a>`);
  } catch (e) {
    console.error("[ig callback]", e?.message);
    res.status(500).send(`<pre>${e?.message}</pre>`);
  }
});

// Status conexao
app.get("/api/integrations/instagram/status", (req, res) => {
  const t = igTokensLoad();
  const events = igEventsLoad();
  res.json({
    ok: true,
    configured: igConfigured(),
    connected: !!(t && t.pageAccessToken),
    pageName: t?.pageName || null,
    igUsername: t?.igUsername || null,
    igUserId: t?.igUserId || null,
    connectedAt: t?.connectedAt || null,
    expiresAt: t?.expiresAt || null,
    expiresInDays: t?.expiresAt ? Math.round((t.expiresAt - Date.now()) / (24*60*60*1000)) : null,
    eventsCount: events.length,
    webhookUrl: `${req.protocol}://${req.get("host")}/api/webhook/instagram`,
    verifyToken: IG_VERIFY_TOKEN,
    appId: META_APP_ID || null
  });
});

app.post("/api/integrations/instagram/disconnect", (_req, res) => {
  igTokensSave(null);
  res.json({ ok: true });
});

app.get("/api/integrations/instagram/events", (req, res) => {
  const all = igEventsLoad().slice().reverse();
  const limit = Math.min(Number(req.query.limit) || 30, 200);
  res.json({ ok: true, total: all.length, items: all.slice(0, limit) });
});

// Webhook IG: GET pra handshake + POST pra receber events
app.get("/api/webhook/instagram", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === IG_VERIFY_TOKEN) {
    console.log("[ig webhook] verificado");
    return res.status(200).send(challenge);
  }
  return res.status(403).send("Forbidden");
});

app.post("/api/webhook/instagram", async (req, res) => {
  try {
    res.json({ ok: true });  // ack imediato pro Meta
    const body = req.body || {};
    if (body.object !== "instagram") return;
    const arr = igEventsLoad();
    for (const entry of (body.entry || [])) {
      for (const msg of (entry.messaging || [])) {
        // skip echo da pagina
        if (msg.message?.is_echo) continue;
        const senderId = msg.sender?.id;
        const text = msg.message?.text || "[midia/sticker]";
        const messageId = msg.message?.mid;
        const evt = {
          type: "message_in",
          receivedAt: Date.now(),
          from: senderId,
          text,
          messageId,
          igUserId: entry.id,
          raw: msg
        };
        arr.push(evt);
        // Broadcast SSE pro CRM UI
        broadcastSSE({ type: "instagram_event", data: evt });
        // Fan-out pro Sofia
        try {
          const phoneSurrogate = `ig_${senderId}`;
          await fetch(`${AGENT_URL}/inbox`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ phone: phoneSurrogate, message: text, name: `IG:${senderId}` })
          });
        } catch (e) { console.error("[ig->agent]", e?.message); }
      }
    }
    igEventsSave(arr);
  } catch (e) {
    console.error("[ig webhook]", e?.message);
  }
});

// Envio de DM via IG Graph API
async function igSendMessage(recipientIgUserId, text) {
  const t = igTokensLoad();
  if (!t || !t.pageAccessToken) throw new Error("Instagram nao conectado");
  const url = `https://graph.facebook.com/${META_API_VERSION}/${t.igUserId}/messages?access_token=${t.pageAccessToken}`;
  const body = {
    recipient: { id: String(recipientIgUserId).replace(/^ig_/, "") },
    message: { text: String(text) },
    messaging_type: "RESPONSE"
  };
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error?.message || `HTTP ${r.status}`);
  return d;
}

app.post("/api/integrations/instagram/send", async (req, res) => {
  try {
    const { recipient, message } = req.body || {};
    if (!recipient || !message) return res.status(400).json({ ok: false, error: "recipient e message obrigatorios" });
    const r = await igSendMessage(recipient, message);
    res.json({ ok: true, ...r });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message });
  }
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
  "https://www.googleapis.com/auth/userinfo.profile",
  // v4.32: drive.file = acesso APENAS aos arquivos criados por essa app (escopo restrito, seguro)
  "https://www.googleapis.com/auth/drive.file"
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
// v4.32: BACKUP PRO GOOGLE DRIVE (drive.file scope)
// ============================================================
const BACKUP_DRIVE_FOLDER_NAME = process.env.BACKUP_DRIVE_FOLDER_NAME || "Imperador CRM Backups";
const BACKUP_DRIVE_RETENTION = Number(process.env.BACKUP_DRIVE_RETENTION || 30); // mantem 30 backups mais recentes
const BACKUP_FOLDER_ID_FILE = path.join(__dirname, "data", "drive-backup-folder-id.txt");

async function driveFindOrCreateFolder() {
  // Cache do folderId em arquivo (evita query toda vez)
  try {
    const cached = require("fs").readFileSync(BACKUP_FOLDER_ID_FILE, "utf8").trim();
    if (cached) return cached;
  } catch {}
  // Procura folder existente
  const q = `name='${BACKUP_DRIVE_FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const r1 = await googleApiFetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)`);
  const d1 = await r1.json();
  if (d1.files && d1.files.length > 0) {
    require("fs").writeFileSync(BACKUP_FOLDER_ID_FILE, d1.files[0].id);
    return d1.files[0].id;
  }
  // Cria folder
  const r2 = await googleApiFetch("https://www.googleapis.com/drive/v3/files", {
    method: "POST",
    body: JSON.stringify({ name: BACKUP_DRIVE_FOLDER_NAME, mimeType: "application/vnd.google-apps.folder" })
  });
  const d2 = await r2.json();
  if (!r2.ok) throw new Error("create folder: " + (d2.error?.message || r2.status));
  require("fs").writeFileSync(BACKUP_FOLDER_ID_FILE, d2.id);
  return d2.id;
}

async function driveUploadFile(localPath, remoteName, parentFolderId) {
  const fsLib = require("fs");
  const stat = fsLib.statSync(localPath);
  const fileBuf = fsLib.readFileSync(localPath);
  // Multipart upload: metadata + content
  const boundary = "imp_boundary_" + Date.now();
  const metadata = JSON.stringify({ name: remoteName, parents: [parentFolderId] });
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`),
    fileBuf,
    Buffer.from(`\r\n--${boundary}--`)
  ]);
  const r = await googleApiFetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart", {
    method: "POST",
    headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
    body
  });
  const d = await r.json();
  if (!r.ok) throw new Error("upload: " + (d.error?.message || r.status));
  return { id: d.id, name: d.name, size: stat.size };
}

async function driveDeleteOldBackups(folderId, keepN) {
  const r = await googleApiFetch(`https://www.googleapis.com/drive/v3/files?q='${folderId}'+in+parents+and+trashed=false&orderBy=createdTime+desc&fields=files(id,name,createdTime)&pageSize=200`);
  const d = await r.json();
  const files = d.files || [];
  const toDelete = files.slice(keepN);
  const deleted = [];
  for (const f of toDelete) {
    try {
      await googleApiFetch(`https://www.googleapis.com/drive/v3/files/${f.id}`, { method: "DELETE" });
      deleted.push(f.name);
    } catch (e) { console.error("[backup-drive] delete fail", f.name, e?.message); }
  }
  return { kept: files.length - deleted.length, deleted };
}

// POST /api/backup/drive/upload - sobe ultimos backups locais pro Drive
// Body opcional: { sourceDir: "/opt/backups", pattern: "tar.gz" } - default le do volume mount
app.post("/api/backup/drive/upload", async (req, res) => {
  try {
    if (!googleConfigured()) return res.status(503).json({ ok: false, error: "Google nao configurado" });
    if (!googleLoadTokens()?.access_token) return res.status(503).json({ ok: false, error: "Google nao conectado - va em Integracoes -> Google -> Conectar" });
    const fsLib = require("fs");
    const sourceDir = req.body?.sourceDir || process.env.BACKUP_SOURCE_DIR || "/opt/backups";
    if (!fsLib.existsSync(sourceDir)) return res.status(404).json({ ok: false, error: `sourceDir ${sourceDir} nao existe (precisa volume mount)` });
    const files = fsLib.readdirSync(sourceDir).filter(f => f.endsWith(".tar.gz"));
    if (files.length === 0) return res.json({ ok: true, uploaded: [], message: "nenhum .tar.gz encontrado" });
    // Pega os arquivos do dia mais recente (data dentro do nome YYYYMMDD-HHMM)
    files.sort();
    const latestDate = files[files.length - 1].match(/(\d{8}-\d{4})/)?.[1];
    const todayFiles = latestDate ? files.filter(f => f.includes(latestDate)) : files.slice(-4);
    const folderId = await driveFindOrCreateFolder();
    const uploaded = [];
    for (const f of todayFiles) {
      try {
        const r = await driveUploadFile(path.join(sourceDir, f), f, folderId);
        uploaded.push(r);
        console.log(`[backup-drive] uploaded ${f} (${r.size} bytes) id=${r.id}`);
      } catch (e) { console.error(`[backup-drive] fail ${f}:`, e?.message); }
    }
    const cleanup = await driveDeleteOldBackups(folderId, BACKUP_DRIVE_RETENTION);
    res.json({ ok: true, folderId, uploaded, cleanup });
  } catch (e) {
    console.error("[backup-drive]", e?.message);
    res.status(500).json({ ok: false, error: e?.message });
  }
});

// GET /api/backup/drive/status - lista backups no Drive
app.get("/api/backup/drive/status", async (_req, res) => {
  try {
    if (!googleLoadTokens()?.access_token) return res.json({ ok: true, connected: false, hint: "Conectar Google em Integracoes" });
    const folderId = await driveFindOrCreateFolder();
    const r = await googleApiFetch(`https://www.googleapis.com/drive/v3/files?q='${folderId}'+in+parents+and+trashed=false&orderBy=createdTime+desc&fields=files(id,name,size,createdTime)&pageSize=50`);
    const d = await r.json();
    res.json({ ok: true, connected: true, folderId, folderName: BACKUP_DRIVE_FOLDER_NAME, retention: BACKUP_DRIVE_RETENTION, total: (d.files||[]).length, files: (d.files||[]).map(f => ({ name: f.name, size: Number(f.size||0), createdAt: f.createdTime })) });
  } catch (e) { res.status(500).json({ ok: false, error: e?.message }); }
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
    // v4.32: HMAC opt-in (setar KIWIFY_HMAC_SECRET no .env)
    if (process.env.KIWIFY_HMAC_SECRET && !verifyHmacOptional(req, process.env.KIWIFY_HMAC_SECRET, ['x-kiwify-signature','x-webhook-signature','x-hub-signature-256'])) {
      return res.status(401).json({ ok: false, error: "hmac invalido" });
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
  // 2. Se HOTMART_HMAC_SECRET setado, verifica header x-hotmart-hmac-sha256 (v4.32: usa rawBody)
  if (HOTMART_HMAC_SECRET) {
    const sig = String(req.headers["x-hotmart-hmac-sha256"] || req.headers["x-signature"] || "").replace(/^sha256=/i, '');
    if (!sig) return false;
    const body = req.rawBody || JSON.stringify(req.body || {});
    const expected = crypto.createHmac("sha256", HOTMART_HMAC_SECRET).update(body).digest("hex");
    try {
      const a = Buffer.from(sig, "hex"), b = Buffer.from(expected, "hex");
      if (a.length !== b.length) return false;
      return crypto.timingSafeEqual(a, b);
    } catch { return false; }
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
  const sig = String(req.headers["x-signature"] || req.headers["x-eduzz-signature"] || "").replace(/^sha256=/i, '');
  if (!sig) return false;
  // v4.32: usa rawBody pra HMAC determinstico
  const body = req.rawBody || JSON.stringify(req.body || {});
  const expected = crypto.createHmac("sha256", EDUZZ_HMAC_SECRET).update(body).digest("hex");
  try {
    const a = Buffer.from(sig, "hex"), b = Buffer.from(expected, "hex");
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch { return false; }
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
    // v4.32: Auth fix. Logica: se ALGUM secret esta setado, EXIGE pelo menos um valido.
    // Antes: se ORIGIN_SECRET nao setado, eduzzVerifyOrigin retornava true -> bypassava HMAC.
    const hmacEnabled = !!EDUZZ_HMAC_SECRET;
    const originEnabled = !!EDUZZ_ORIGIN_SECRET;
    if (hmacEnabled || originEnabled) {
      const okHmac = hmacEnabled ? eduzzVerifyHmac(req) : false;
      const okOrigin = originEnabled ? (req.body && req.body.origin_secret === EDUZZ_ORIGIN_SECRET) : false;
      if (!okHmac && !okOrigin) {
        return res.status(401).json({ ok: false, error: "assinatura invalida" });
      }
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

// v4.34: Auto-followup pre-evento (24h antes) - dispara lembrete WhatsApp
const EVENT_REMINDERS_FILE = path.join(__dirname, "data", "event-reminders-sent.json");
function eventRemindersLoad() { try { return JSON.parse(fs.readFileSync(EVENT_REMINDERS_FILE, "utf8")); } catch { return {}; } }
function eventRemindersSave(map) { try { fs.writeFileSync(EVENT_REMINDERS_FILE, JSON.stringify(map, null, 2)); } catch (e) {} }

async function eventReminderTick() {
  try {
    const events = eventsLoad().filter(e => e.status === "published" && e.startAt);
    if (events.length === 0) return;
    const tickets = ticketsLoad();
    const sent = eventRemindersLoad();
    const now = Date.now();
    const win24h = 24 * 60 * 60 * 1000;
    const tolerance = 60 * 60 * 1000; // janela de 1h pra disparo
    for (const ev of events) {
      const timeUntil = ev.startAt - now;
      // Dispara entre 24h-1h e 24h+1h antes do evento
      if (timeUntil < win24h - tolerance || timeUntil > win24h + tolerance) continue;
      const evTickets = tickets.filter(t => t.eventId === ev.id && t.status === "valid");
      const fmtP = (s, e) => {
        if (!s) return ""; const sd = new Date(s);
        const sStr = sd.toLocaleString("pt-BR", { dateStyle: "long", timeStyle: "short" });
        if (!e) return sStr;
        const ed = new Date(e);
        return sd.toDateString() === ed.toDateString()
          ? sStr + " → " + ed.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })
          : sStr + " → " + ed.toLocaleString("pt-BR", { dateStyle: "long", timeStyle: "short" });
      };
      for (const tk of evTickets) {
        const key = `${ev.id}_${tk.id}_24h`;
        if (sent[key]) continue;
        if (!tk.attendeePhone) continue;
        const local = ev.type === "online" ? "🌐 Online" : `📍 ${ev.location?.venue || "Local a definir"}`;
        const msg = `🔔 Lembrete: amanhã!\n\n*${ev.title}*\n📅 ${fmtP(ev.startAt, ev.endAt)}\n${local}\n\nSeu ingresso: https://crm.institutoideoficial.com.br/t/${tk.id}\n\nTá nos vendo? Qualquer duvida me chama. 💛`;
        try {
          const r = await fetch(`http://127.0.0.1:${PORT}/api/send-message`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ phone: tk.attendeePhone, message: msg })
          });
          const d = await r.json().catch(() => ({}));
          if (d.ok) {
            sent[key] = { sentAt: now, eventId: ev.id, ticketId: tk.id };
            console.log(`[event-reminder] enviado pra ${tk.attendeeName} (${tk.attendeePhone}) - ${ev.title}`);
          }
        } catch (e) { console.error("[event-reminder]", e?.message); }
      }
    }
    eventRemindersSave(sent);
  } catch (e) { console.error("[event-reminder-tick]", e?.message); }
}
setInterval(eventReminderTick, 30 * 60 * 1000); // 30 min
setTimeout(eventReminderTick, 60 * 1000); // primeira vez 1min apos boot

// v4.34: Cron resumo diario WhatsApp (manda 7h da manha hora SP)
async function dailySummaryTick() {
  try {
    if (!process.env.DAILY_SUMMARY_PHONE && !process.env.DAILY_SUMMARY_AUTO) return;
    const now = new Date();
    const sp = new Date(now.toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
    const hour = sp.getHours();
    const minute = sp.getMinutes();
    if (hour !== 7 || minute >= 30) return; // dispara entre 07:00 e 07:29 SP
    const flag = path.join(__dirname, "data", "last-daily-summary.txt");
    const today = sp.toISOString().slice(0, 10);
    try {
      const last = fs.readFileSync(flag, "utf8").trim();
      if (last === today) return; // ja mandou hoje
    } catch {}
    const phone = process.env.DAILY_SUMMARY_PHONE || "5512982933600";
    const msg = dailySummaryText();
    await fetch(`http://127.0.0.1:${PORT}/api/send-message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone, message: msg })
    });
    fs.writeFileSync(flag, today);
    console.log("[daily-summary] enviado pra " + phone);
  } catch (e) { console.error("[daily-summary]", e?.message); }
}
setInterval(dailySummaryTick, 5 * 60 * 1000); // checa a cada 5min

// ============================================================
// v4.34: GERENCIADOR DE EVENTOS (Sympla-like MVP)
// ============================================================
// Helper local pra escapar HTML nos templates publicos
function esc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;"); }

const EVENTS_FILE = process.env.EVENTS_FILE || path.join(__dirname, "data", "events.json");
const TICKETS_FILE = process.env.TICKETS_FILE || path.join(__dirname, "data", "tickets.json");

function eventsLoad() { try { return JSON.parse(fs.readFileSync(EVENTS_FILE, "utf8")); } catch { return []; } }
function eventsSave(arr) { try { fs.writeFileSync(EVENTS_FILE, JSON.stringify(arr || [], null, 2)); } catch (e) { console.error("[events]", e?.message); } }
function ticketsLoad() { try { return JSON.parse(fs.readFileSync(TICKETS_FILE, "utf8")); } catch { return []; } }
function ticketsSave(arr) { try { fs.writeFileSync(TICKETS_FILE, JSON.stringify(arr || [], null, 2)); } catch (e) { console.error("[tickets]", e?.message); } }

function eventNewId() { return "ev_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function ticketNewId() { return "tk_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10); }
function slugify(s) {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "evento";
}

// === Endpoints publicos (landing + ingresso + check-in publico) ===
app.get("/e/:slug", (req, res) => {
  const ev = eventsLoad().find(e => e.slug === req.params.slug);
  if (!ev) return res.status(404).send("<h1>Evento nao encontrado</h1>");
  if (ev.status === "draft") return res.status(404).send("<h1>Evento nao publicado</h1>");
  // Render landing simples (suporta multi-dia)
  function fmtPeriodoEvent(start, end) {
    if (!start) return "";
    const s = new Date(start);
    const sStr = s.toLocaleString("pt-BR", { dateStyle: "long", timeStyle: "short" });
    if (!end) return sStr;
    const e = new Date(end);
    const sameDay = s.toDateString() === e.toDateString();
    return sameDay
      ? sStr + " → " + e.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })
      : sStr + " → " + e.toLocaleString("pt-BR", { dateStyle: "long", timeStyle: "short" });
  }
  const dateStr = fmtPeriodoEvent(ev.startAt, ev.endAt);
  const locationStr = ev.type === "online" ? "🌐 Online" : `📍 ${ev.location?.venue || "Local a definir"}, ${ev.location?.city || ""}`;
  const ticketTypes = (ev.ticketTypes || []).filter(t => t.quantity == null || (t.sold || 0) < t.quantity);
  res.send(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(ev.title)} — ${esc(ev.organizer?.name || "Speakers Play")}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;background:#fafaf8;color:#1a1a1a;line-height:1.6}
.hero{background:linear-gradient(135deg,#C8A84B 0%,#a08538 100%);color:#111;padding:60px 20px;text-align:center}
.hero h1{font-size:36px;font-weight:800;margin-bottom:8px}
.hero .meta{font-size:15px;font-weight:600;opacity:.9}
.box{max-width:720px;margin:-30px auto 40px;background:#fff;padding:30px;border-radius:14px;box-shadow:0 10px 40px rgba(0,0,0,.08)}
.box h2{font-size:18px;color:#C8A84B;margin-bottom:10px;text-transform:uppercase;letter-spacing:1px}
.desc{margin:14px 0 24px;color:#444;white-space:pre-wrap}
.tt{border:2px solid #ececec;padding:18px;border-radius:10px;margin-bottom:10px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px}
.tt .name{font-weight:700;font-size:16px}
.tt .price{font-size:20px;font-weight:800;color:#C8A84B}
.tt .free{color:#10b981}
.cta{display:block;width:100%;background:#C8A84B;color:#111;padding:14px;border:none;border-radius:10px;font-size:16px;font-weight:700;cursor:pointer;margin-top:8px;text-decoration:none;text-align:center}
.cta:hover{background:#a08538}
form{margin-top:24px;display:none}
form.open{display:block}
form input{width:100%;padding:12px;border:2px solid #ddd;border-radius:8px;margin-bottom:10px;font-size:14px;font-family:inherit}
form input:focus{outline:none;border-color:#C8A84B}
.footer{text-align:center;padding:20px;color:#999;font-size:12px}
.success{background:#d1fae5;color:#065f46;padding:18px;border-radius:10px;margin-top:14px;text-align:center}
</style></head><body>
<div class="hero">
  <h1>${esc(ev.title)}</h1>
  <div class="meta">${esc(dateStr)} &middot; ${esc(locationStr)}</div>
</div>
<div class="box">
  <h2>Sobre</h2>
  <div class="desc">${esc(ev.description || "")}</div>
  <h2>Ingressos</h2>
  ${ticketTypes.length === 0 ? '<div style="color:#999;text-align:center;padding:20px">Nenhum ingresso disponível.</div>' : ticketTypes.map(t => `
  <div class="tt">
    <div>
      <div class="name">${esc(t.name)}</div>
      <div style="font-size:12px;color:#666">${esc(t.description || "")}</div>
    </div>
    <div class="price ${t.price === 0 ? 'free' : ''}">${t.price === 0 ? 'GRÁTIS' : 'R$ ' + Number(t.price).toFixed(2).replace('.', ',')}</div>
  </div>`).join("")}
  ${ticketTypes.length > 0 ? `<button class="cta" onclick="document.getElementById('f').classList.add('open');this.style.display='none'">Quero participar</button>
  <form id="f" onsubmit="return inscrever(event)">
    <input id="nm" placeholder="Seu nome completo" required>
    <input id="em" type="email" placeholder="Email" required>
    <input id="ph" type="tel" placeholder="WhatsApp (com DDD)" required>
    <button class="cta" type="submit">Confirmar inscrição</button>
    <div id="msg"></div>
  </form>` : ''}
</div>
<div class="footer">${esc(ev.organizer?.name || "Speakers Play")} &middot; <a href="/" style="color:#999">CRM Imperador</a></div>
<script>
async function inscrever(e){
  e.preventDefault();
  var btn = e.target.querySelector('button[type=submit]');
  btn.disabled = true; btn.textContent = 'Processando...';
  try {
    var r = await fetch('/api/public/events/${esc(ev.slug)}/order', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({
        name: document.getElementById('nm').value,
        email: document.getElementById('em').value,
        phone: document.getElementById('ph').value,
        ticketTypeId: '${ticketTypes[0]?.id || ""}'
      })
    });
    var d = await r.json();
    if (d.ok) {
      document.getElementById('msg').innerHTML = '<div class="success">✅ Inscrição confirmada!<br><a href="/t/'+d.ticket.id+'" style="color:#065f46;font-weight:700">Ver ingresso (QR Code)</a></div>';
      e.target.querySelectorAll('input').forEach(i=>i.disabled=true);
      btn.style.display='none';
    } else {
      document.getElementById('msg').innerHTML = '<div style="color:#ef4444;padding:10px;text-align:center">'+ (d.error || 'Erro') +'</div>';
      btn.disabled = false; btn.textContent = 'Confirmar inscrição';
    }
  } catch(e){
    document.getElementById('msg').innerHTML = '<div style="color:#ef4444">Erro: '+e.message+'</div>';
    btn.disabled = false; btn.textContent = 'Confirmar inscrição';
  }
  return false;
}
</script>
</body></html>`);
});

app.get("/t/:id", (req, res) => {
  const tk = ticketsLoad().find(t => t.id === req.params.id);
  if (!tk) return res.status(404).send("<h1>Ingresso nao encontrado</h1>");
  const ev = eventsLoad().find(e => e.id === tk.eventId);
  if (!ev) return res.status(404).send("<h1>Evento nao encontrado</h1>");
  function fmtP(start, end) {
    if (!start) return "";
    const s = new Date(start);
    const sStr = s.toLocaleString("pt-BR", { dateStyle: "long", timeStyle: "short" });
    if (!end) return sStr;
    const e = new Date(end);
    const sameDay = s.toDateString() === e.toDateString();
    return sameDay ? sStr + " → " + e.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) : sStr + " → " + e.toLocaleString("pt-BR", { dateStyle: "long", timeStyle: "short" });
  }
  const dateStr = fmtP(ev.startAt, ev.endAt);
  const ticketType = (ev.ticketTypes || []).find(t => t.id === tk.ticketTypeId);
  // QR code via API publica do qrserver (sem dep externa)
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(tk.id)}`;
  const statusBadge = tk.status === "used" ? '<span style="background:#fee2e2;color:#991b1b;padding:4px 12px;border-radius:8px;font-size:12px;font-weight:700">JÁ USADO</span>' : '<span style="background:#d1fae5;color:#065f46;padding:4px 12px;border-radius:8px;font-size:12px;font-weight:700">VÁLIDO</span>';
  res.send(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Ingresso — ${esc(ev.title)}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,sans-serif;background:#1a1612;color:#e8e6e1;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
.ticket{background:#fff;color:#1a1a1a;border-radius:14px;max-width:420px;width:100%;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.4)}
.head{background:linear-gradient(135deg,#C8A84B 0%,#a08538 100%);color:#111;padding:24px;text-align:center}
.head h1{font-size:20px;margin-bottom:6px}
.head .meta{font-size:13px;opacity:.85}
.body{padding:24px}
.qr{text-align:center;padding:20px;background:#fafaf8;border-radius:10px;margin:14px 0}
.qr img{display:block;margin:0 auto;border-radius:8px}
.attendee{margin-top:16px;padding:14px;background:#fafaf8;border-radius:10px}
.attendee .label{font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#999;margin-bottom:4px}
.attendee .val{font-size:14px;font-weight:600}
.footer{padding:14px;text-align:center;font-size:11px;color:#999;background:#fafaf8;border-top:2px dashed #e5e5e5}
</style></head><body>
<div class="ticket">
  <div class="head">
    <h1>${esc(ev.title)}</h1>
    <div class="meta">${esc(dateStr)}</div>
    <div style="margin-top:10px">${statusBadge}</div>
  </div>
  <div class="body">
    <div class="qr"><img src="${qrUrl}" alt="QR Code"></div>
    <div style="text-align:center;font-family:monospace;font-size:11px;color:#999;letter-spacing:1px">${esc(tk.id)}</div>
    <div class="attendee">
      <div class="label">Participante</div>
      <div class="val">${esc(tk.attendeeName)}</div>
      <div class="label" style="margin-top:8px">Tipo de ingresso</div>
      <div class="val">${esc(ticketType?.name || "?")}</div>
    </div>
  </div>
  <div class="footer">${esc(ev.organizer?.name || "Speakers Play")} &middot; Apresente esse QR no check-in</div>
</div>
</body></html>`);
});

// Cria pedido + emite ticket (publico)
app.post("/api/public/events/:slug/order", async (req, res) => {
  try {
    const events = eventsLoad();
    const ev = events.find(e => e.slug === req.params.slug);
    if (!ev) return res.status(404).json({ ok: false, error: "Evento nao encontrado" });
    if (ev.status === "draft") return res.status(403).json({ ok: false, error: "Evento nao publicado" });
    const { name, email, phone, ticketTypeId } = req.body || {};
    if (!name || !email || !phone) return res.status(400).json({ ok: false, error: "name, email e phone obrigatorios" });
    const tt = (ev.ticketTypes || []).find(t => t.id === ticketTypeId) || ev.ticketTypes?.[0];
    if (!tt) return res.status(400).json({ ok: false, error: "Sem tipos de ingresso" });
    if (tt.quantity != null && (tt.sold || 0) >= tt.quantity) return res.status(400).json({ ok: false, error: "Lote esgotado" });
    const tickets = ticketsLoad();
    const cleanPhone = String(phone).replace(/\D/g, "");
    const tk = {
      id: ticketNewId(),
      eventId: ev.id,
      ticketTypeId: tt.id,
      attendeeName: String(name).trim(),
      attendeeEmail: String(email).trim().toLowerCase(),
      attendeePhone: cleanPhone,
      price: tt.price,
      status: "valid",
      createdAt: Date.now(),
      checkedInAt: null
    };
    tickets.push(tk);
    ticketsSave(tickets);
    // Incrementa sold
    tt.sold = (tt.sold || 0) + 1;
    eventsSave(events);
    // Auto-create contact tag e dispara WhatsApp confirma se Bravos online
    try {
      const tagsMap = contactTagsLoad();
      if (!tagsMap[cleanPhone]) tagsMap[cleanPhone] = [];
      const tag = "evento:" + ev.slug;
      if (!tagsMap[cleanPhone].includes(tag)) tagsMap[cleanPhone].push(tag);
      contactTagsSave(tagsMap);
    } catch (e) {}
    // Manda confirmacao via WhatsApp se possivel
    try {
      const fmtP = (s, e) => {
        if (!s) return "";
        const sd = new Date(s);
        const sStr = sd.toLocaleString("pt-BR", { dateStyle: "long", timeStyle: "short" });
        if (!e) return sStr;
        const ed = new Date(e);
        return sd.toDateString() === ed.toDateString()
          ? sStr + " → " + ed.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })
          : sStr + " → " + ed.toLocaleString("pt-BR", { dateStyle: "long", timeStyle: "short" });
      };
      const msg = `🎟️ Inscricao confirmada!\n\n*${ev.title}*\n📅 ${fmtP(ev.startAt, ev.endAt)}\n${ev.type === "online" ? "🌐 Online" : "📍 " + (ev.location?.venue || "Local a definir")}\n\nSeu ingresso (com QR pra check-in):\nhttps://crm.institutoideoficial.com.br/t/${tk.id}`;
      fetch(`http://127.0.0.1:${PORT}/api/send-message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: cleanPhone, message: msg })
      }).catch(() => {});
    } catch (e) {}
    broadcastSSE({ type: "event_order_created", data: { eventId: ev.id, eventSlug: ev.slug, ticketId: tk.id, attendee: tk.attendeeName } });
    res.json({ ok: true, ticket: { id: tk.id, attendeeName: tk.attendeeName }, ticketUrl: `/t/${tk.id}` });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message });
  }
});

// === Endpoints painel organizador (auth required) ===
app.get("/api/events", (_req, res) => {
  res.json({ ok: true, items: eventsLoad() });
});
app.get("/api/events/:id", (req, res) => {
  const ev = eventsLoad().find(e => e.id === req.params.id || e.slug === req.params.id);
  if (!ev) return res.status(404).json({ ok: false, error: "evento nao encontrado" });
  const tickets = ticketsLoad().filter(t => t.eventId === ev.id);
  res.json({ ok: true, event: ev, ticketsCount: tickets.length, ticketsCheckedIn: tickets.filter(t => t.status === "used").length });
});
app.post("/api/events", (req, res) => {
  try {
    const b = req.body || {};
    if (!b.title) return res.status(400).json({ ok: false, error: "title obrigatorio" });
    const events = eventsLoad();
    const ev = {
      id: eventNewId(),
      slug: b.slug || slugify(b.title) + "-" + Date.now().toString(36).slice(-4),
      title: String(b.title),
      description: String(b.description || ""),
      type: b.type || "online",
      startAt: b.startAt || null,
      endAt: b.endAt || null,
      location: b.location || {},
      organizer: b.organizer || { name: "Speakers Play Academy" },
      status: b.status || "draft",
      capacity: b.capacity || null,
      ticketTypes: (b.ticketTypes || [{ id: "tt_default_" + Date.now().toString(36).slice(-4), name: "Inscrição grátis", price: 0, quantity: null, sold: 0 }]).map(t => ({
        id: t.id || "tt_" + Math.random().toString(36).slice(2, 10),
        name: t.name || "Ingresso",
        price: Number(t.price) || 0,
        quantity: t.quantity || null,
        sold: 0,
        description: t.description || ""
      })),
      createdAt: Date.now(),
      publishedAt: b.status === "published" ? Date.now() : null
    };
    events.push(ev);
    eventsSave(events);
    res.json({ ok: true, event: ev, publicUrl: `/e/${ev.slug}` });
  } catch (e) { res.status(500).json({ ok: false, error: e?.message }); }
});
app.put("/api/events/:id", (req, res) => {
  const events = eventsLoad();
  const idx = events.findIndex(e => e.id === req.params.id);
  if (idx < 0) return res.status(404).json({ ok: false, error: "evento nao encontrado" });
  const ev = events[idx];
  Object.assign(ev, req.body || {});
  if (req.body?.status === "published" && !ev.publishedAt) ev.publishedAt = Date.now();
  events[idx] = ev;
  eventsSave(events);
  res.json({ ok: true, event: ev });
});
app.delete("/api/events/:id", (req, res) => {
  const events = eventsLoad().filter(e => e.id !== req.params.id);
  eventsSave(events);
  res.json({ ok: true });
});
app.get("/api/events/:id/tickets", (req, res) => {
  const tickets = ticketsLoad().filter(t => t.eventId === req.params.id);
  res.json({ ok: true, count: tickets.length, items: tickets });
});
app.post("/api/events/:id/checkin/:ticketId", (req, res) => {
  const tickets = ticketsLoad();
  const idx = tickets.findIndex(t => t.id === req.params.ticketId && t.eventId === req.params.id);
  if (idx < 0) return res.status(404).json({ ok: false, error: "ingresso nao encontrado" });
  const tk = tickets[idx];
  if (tk.status === "used") return res.status(400).json({ ok: false, error: "ja usado", checkedInAt: tk.checkedInAt });
  tk.status = "used";
  tk.checkedInAt = Date.now();
  tk.checkedInBy = req.body?.by || "manual";
  tickets[idx] = tk;
  ticketsSave(tickets);
  broadcastSSE({ type: "event_checkin", data: { ticketId: tk.id, eventId: tk.eventId, attendee: tk.attendeeName } });
  res.json({ ok: true, ticket: tk });
});
app.get("/api/events/:id/export.csv", (req, res) => {
  const ev = eventsLoad().find(e => e.id === req.params.id);
  if (!ev) return res.status(404).send("evento nao encontrado");
  const tickets = ticketsLoad().filter(t => t.eventId === req.params.id);
  const ttById = Object.fromEntries((ev.ticketTypes || []).map(t => [t.id, t]));
  const rows = [["id", "name", "email", "phone", "ticketType", "price", "status", "createdAt", "checkedInAt"].join(",")];
  tickets.forEach(t => {
    rows.push([t.id, t.attendeeName, t.attendeeEmail, t.attendeePhone, ttById[t.ticketTypeId]?.name || "", t.price, t.status, new Date(t.createdAt).toISOString(), t.checkedInAt ? new Date(t.checkedInAt).toISOString() : ""].map(v => `"${String(v).replace(/"/g, '""')}"`).join(","));
  });
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="evento-${ev.slug}-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send("\uFEFF" + rows.join("\n"));
});

app.listen(PORT, () => {
  console.log(`[speakers-crm] rodando na porta ${PORT}`);
  console.log(`[speakers-crm] Bravos URL: ${BRAVOS_URL}`);
  console.log(`[speakers-crm] Scheduled storage: ${SCHED_FILE}`);
});
