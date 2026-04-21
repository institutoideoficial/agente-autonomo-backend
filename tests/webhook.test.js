// Testes unitarios da logica do webhook /api/webhook/bravos
// Sem deps externas. Executar com: node test-webhook.js

// --- COPIA FIEL da logica em index.js (webhook handler) ---
function buildSSEPayload(msgRaw) {
  const msg = msgRaw || {};
  const innerType = msg.type;
  const inner = msg.data;
  if (innerType === "message_in" || innerType === "message_out") {
    return {
      type: innerType,
      data: inner,
      clientId: msg.clientId,
      timestamp: msg.timestamp
    };
  } else if (innerType === "ready") {
    return { type: "whatsapp_ready", timestamp: msg.timestamp };
  } else if (innerType === "disconnected") {
    return { type: "whatsapp_disconnected", data: inner, timestamp: msg.timestamp };
  } else {
    return { type: "new_message", data: msg };
  }
}

// --- FIXTURES ---
const fixtures = {
  messageIn: {
    type: "message_in",
    data: {
      message_id: "ABC_123",
      chat_id: "5511999999999@c.us",
      from_id: "5511999999999@c.us",
      to_id: "5511888888888@c.us",
      direction: "in",
      body: "Ola!",
      type: "chat",
      has_media: 0,
      from_me: 0,
      timestamp: "2025-04-21T12:00:00.000Z"
    },
    clientId: "speakers-crm",
    timestamp: 1713700800000
  },
  messageOut: {
    type: "message_out",
    data: {
      message_id: "XYZ_456",
      chat_id: "5511999999999@c.us",
      from_id: "5511888888888@c.us",
      to_id: "5511999999999@c.us",
      direction: "out",
      body: "Oi, tudo bem?",
      type: "chat",
      has_media: 0,
      from_me: 1,
      timestamp: "2025-04-21T12:01:00.000Z"
    },
    clientId: "speakers-crm",
    timestamp: 1713700860000
  },
  ready: {
    type: "ready",
    data: { ok: true },
    clientId: "speakers-crm",
    timestamp: 1713700700000
  },
  disconnected: {
    type: "disconnected",
    data: { reason: "LOGOUT" },
    clientId: "speakers-crm",
    timestamp: 1713700900000
  },
  unknown: {
    type: "some_future_event",
    data: { foo: "bar" },
    clientId: "speakers-crm",
    timestamp: 1713700999000
  },
  empty: null
};

// --- TESTES ---
let pass = 0;
let fail = 0;
function expect(cond, label) {
  if (cond) { pass++; console.log("  PASS:", label); }
  else      { fail++; console.log("  FAIL:", label); }
}

console.log("\n== Teste 1: message_in ==");
{
  const out = buildSSEPayload(fixtures.messageIn);
  expect(out.type === "message_in", "type preservado");
  expect(out.data && out.data.chat_id === "5511999999999@c.us", "chat_id preservado");
  expect(out.data.body === "Ola!", "body preservado");
  expect(out.clientId === "speakers-crm", "clientId preservado");
  expect(out.timestamp === 1713700800000, "timestamp preservado");
}

console.log("\n== Teste 2: message_out ==");
{
  const out = buildSSEPayload(fixtures.messageOut);
  expect(out.type === "message_out", "type preservado");
  expect(out.data && out.data.from_me === 1, "from_me preservado");
  expect(out.data.direction === "out", "direction preservado");
}

console.log("\n== Teste 3: ready ==");
{
  const out = buildSSEPayload(fixtures.ready);
  expect(out.type === "whatsapp_ready", "type mapeado pra whatsapp_ready");
  expect(!out.data, "data nao enviado (ready eh ping)");
  expect(out.timestamp === 1713700700000, "timestamp preservado");
}

console.log("\n== Teste 4: disconnected ==");
{
  const out = buildSSEPayload(fixtures.disconnected);
  expect(out.type === "whatsapp_disconnected", "type mapeado pra whatsapp_disconnected");
  expect(out.data && out.data.reason === "LOGOUT", "reason preservado");
}

console.log("\n== Teste 5: evento desconhecido ==");
{
  const out = buildSSEPayload(fixtures.unknown);
  expect(out.type === "new_message", "fallback para new_message");
  expect(out.data && out.data.type === "some_future_event", "payload bruto preservado");
}

console.log("\n== Teste 6: payload vazio ==");
{
  const out = buildSSEPayload(fixtures.empty);
  expect(out.type === "new_message", "fallback tolerante a null");
  expect(out.data && Object.keys(out.data).length === 0, "data vira {}");
}

console.log("\n== Teste 7: payload legado (sem type) ==");
{
  const out = buildSSEPayload({ from: "5511999@c.us", body: "teste", timestamp: 123 });
  expect(out.type === "new_message", "fallback para new_message");
  expect(out.data && out.data.from === "5511999@c.us", "payload preservado");
}

console.log(`\n=== Resultado: ${pass} pass, ${fail} fail ===`);
process.exit(fail === 0 ? 0 : 1);
