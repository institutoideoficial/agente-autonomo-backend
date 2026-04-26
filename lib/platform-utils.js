// Helpers compartilhados entre integracoes de plataformas (greenn, eduzz, hotmart, kiwify)
// Reduz ~40% do codigo duplicado em index.js
'use strict';
const fs = require('fs');

/** Le array JSON do disco. Retorna [] se nao existir. */
function loadJsonArray(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return []; }
}

/** Salva array JSON com cap em N items mais recentes. */
function saveJsonArrayCapped(filePath, arr, maxItems = 200) {
  try { fs.writeFileSync(filePath, JSON.stringify((arr || []).slice(-maxItems), null, 2)); }
  catch (e) { console.error(`[storage] ${filePath}`, e?.message); }
}

/** Le rules. Se nao existir, escreve defaults e retorna copia. */
function loadRulesOrDefault(filePath, defaults) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch {
    try { fs.writeFileSync(filePath, JSON.stringify(defaults, null, 2)); } catch (e) {}
    return JSON.parse(JSON.stringify(defaults));
  }
}
function saveRules(filePath, arr) {
  try { fs.writeFileSync(filePath, JSON.stringify(arr || [], null, 2)); }
  catch (e) { console.error(`[rules] ${filePath}`, e?.message); }
}

/** Sanitiza array de regras vindo de PUT (limita campos + delay). */
function sanitizeRules(arr) {
  if (!Array.isArray(arr)) return null;
  return arr.map(r => ({
    status: String(r.status || '').toLowerCase(),
    delayMin: Math.max(0, Math.min(60 * 24, Number(r.delayMin) || 0)),
    enabled: !!r.enabled,
    message: String(r.message || '')
  })).filter(r => r.status && r.message);
}

/**
 * Calcula metrics padronizadas de uma lista de eventos.
 * Cada plataforma pode customizar paidStatuses/abandonedStatuses.
 *
 * @param {Array} all - lista completa de eventos
 * @param {Object} opts
 * @param {string[]} opts.paidStatuses - ex: ['paid','approved']
 * @param {string[]} opts.abandonedStatuses - default ['abandoned']
 * @param {string[]} opts.refusedStatuses - default ['refused','declined','failed']
 * @param {string[]} opts.refundedStatuses - default ['refunded','chargedback']
 * @param {string[]} opts.expiredStatuses - default ['expired']
 */
function computeMetrics(all, opts = {}) {
  const paidS = opts.paidStatuses || ['paid', 'approved'];
  const abandonedS = opts.abandonedStatuses || ['abandoned', 'checkoutabandoned'];
  const refusedS = opts.refusedStatuses || ['refused', 'declined', 'failed'];
  const refundedS = opts.refundedStatuses || ['refunded', 'chargedback'];
  const expiredS = opts.expiredStatuses || ['expired'];

  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x.getTime(); };
  const today = startOfDay(now);
  const week = now - 7 * day;
  const month = now - 30 * day;

  const bucket = (filterFn) => {
    const arr = all.filter(filterFn);
    const paid = arr.filter(x => paidS.includes(x.status));
    const abandoned = arr.filter(x => abandonedS.includes(x.status));
    const refused = arr.filter(x => refusedS.includes(x.status));
    const expired = arr.filter(x => expiredS.includes(x.status));
    const refunded = arr.filter(x => refundedS.includes(x.status));
    const revenue = paid.reduce((s, x) => s + (Number(x.total) || 0), 0);
    return {
      total: arr.length,
      paid: paid.length,
      abandoned: abandoned.length,
      refused: refused.length,
      expired: expired.length,
      refunded: refunded.length,
      revenue: Math.round(revenue * 100) / 100,
      conversionPct: arr.length ? Math.round((paid.length / arr.length) * 1000) / 10 : 0,
      avgTicket: paid.length ? Math.round((revenue / paid.length) * 100) / 100 : 0
    };
  };

  // Top 5 produtos (por receita)
  const paidAll = all.filter(x => paidS.includes(x.status) && x.productName);
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

  // Serie temporal ultimos 7 dias
  const days7 = [];
  for (let i = 6; i >= 0; i--) {
    const dStart = startOfDay(now - i * day);
    const dEnd = dStart + day;
    const dayPaid = all.filter(x => x.receivedAt >= dStart && x.receivedAt < dEnd && paidS.includes(x.status));
    days7.push({
      date: new Date(dStart).toISOString().slice(0, 10),
      vendas: dayPaid.length,
      receita: Math.round(dayPaid.reduce((s, x) => s + (Number(x.total) || 0), 0) * 100) / 100
    });
  }

  return {
    totalEventos: all.length,
    hoje: bucket(x => x.receivedAt >= today),
    ultimos7: bucket(x => x.receivedAt >= week),
    ultimos30: bucket(x => x.receivedAt >= month),
    topProducts,
    days7
  };
}

/** Filtra eventos por status/product/search/from/to (query string padronizada). */
function filterEvents(events, q) {
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
      const hay = [ev.name, ev.phone, ev.email, ev.productName, ev.statusLabel, ev.transactionId, ev.status, ev.event]
        .join(' ').toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });
}

/** Gera CSV (com BOM utf8) de array de eventos. */
function eventsToCSV(events, cols) {
  const esc = v => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [cols.join(',')];
  events.forEach(ev => {
    lines.push(cols.map(c => {
      if (c === 'receivedAt') return ev.receivedAt ? new Date(ev.receivedAt).toISOString() : '';
      return esc(ev[c]);
    }).join(','));
  });
  return '\uFEFF' + lines.join('\n');
}

module.exports = {
  loadJsonArray,
  saveJsonArrayCapped,
  loadRulesOrDefault,
  saveRules,
  sanitizeRules,
  computeMetrics,
  filterEvents,
  eventsToCSV
};
