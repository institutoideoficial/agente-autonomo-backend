// Testes da logica pura do patch v4.1 (frontend). Sem DOM.

// --- COPIA FIEL das helpers do patch ---
function chatIdToKey(chatId){ return "w" + String(chatId || "").replace(/[^0-9]/g, ""); }
function tsToHM(raw){
  if(!raw) return "";
  var d;
  if(typeof raw === "number") d = new Date(raw < 1e12 ? raw * 1000 : raw);
  else d = new Date(raw);
  if(isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit", timeZone: "America/Sao_Paulo"});
}
function extractName(row, chatId){
  return row.pushname || row.notifyName || row.notify_name ||
         (chatId ? String(chatId).replace(/@[a-z.]+$/i, "") : "Desconhecido");
}
function isFromMe(row){
  return row.from_me === 1 || row.from_me === true ||
         row.fromMe === true || row.sent === 1 || row.sent === true ||
         row.direction === "out";
}
function bodyOrMedia(row){
  var text = row.body || row.text || row.message || "";
  if(!text && (row.has_media || row.hasMedia)) text = "[midia]";
  return text;
}

// Simula loadHistory transformation
function transformHistoryList(list){
  if(!Array.isArray(list) || list.length === 0) return [];
  list = list.slice().reverse();
  return list.map(function(m){
    var ts = tsToHM(m.timestamp) || m.time || m.ts || "";
    var fromMe = isFromMe(m);
    return { r: fromMe ? "out" : "u", t: bodyOrMedia(m), ts: ts };
  }).filter(function(m){ return m.t; });
}

// Simula dispatcher SSE
function dispatchSSE(evt, handlers){
  if(!evt || !evt.type) return null;
  if(evt.type === "whatsapp_ready"){ handlers.checkConnection(); return "whatsapp_ready"; }
  if(evt.type === "whatsapp_disconnected"){ handlers.checkConnection(); handlers.toast("WhatsApp desconectou"); return "whatsapp_disconnected"; }
  if(evt.type === "message_in"){ handlers.handleRealRow(evt.data, false); return "message_in"; }
  if(evt.type === "message_out"){ handlers.handleRealRow(evt.data, true); return "message_out"; }
  if(evt.type === "new_message" && evt.data){
    var outer = evt.data;
    var innerType = outer && outer.type;
    var real = outer && outer.data;
    if(innerType === "message_in" && real){ handlers.handleRealRow(real, false); return "new_message->in"; }
    if(innerType === "message_out" && real){ handlers.handleRealRow(real, true); return "new_message->out"; }
    var chatId = outer.chatId || outer.from || outer.chat_id;
    if(chatId){
      handlers.handleRealRow({
        chat_id: chatId,
        body: outer.body || outer.text || "",
        pushname: outer.notifyName || outer.pushname,
        from_me: outer.fromMe === true ? 1 : 0,
        timestamp: outer.timestamp
      }, outer.fromMe === true);
      return "new_message->raw";
    }
  }
  return "ignored";
}

// --- TESTES ---
let pass = 0, fail = 0;
function expect(cond, label){
  if(cond){ pass++; console.log("  PASS:", label); }
  else    { fail++; console.log("  FAIL:", label); }
}
function deepEq(a,b){ return JSON.stringify(a) === JSON.stringify(b); }

console.log("\n== chatIdToKey ==");
expect(chatIdToKey("5511999999999@c.us") === "w5511999999999", "strip @c.us");
expect(chatIdToKey("+55 11 99999-9999@c.us") === "w5511999999999", "strip nao-digitos");
expect(chatIdToKey("5511999@s.whatsapp.net") === "w5511999", "strip @s.whatsapp.net");
expect(chatIdToKey(null) === "w", "null tolerado");
expect(chatIdToKey(undefined) === "w", "undefined tolerado");
expect(chatIdToKey("") === "w", "string vazia tolerada");

console.log("\n== tsToHM ==");
expect(tsToHM(0) === "", "zero retorna vazio");
expect(tsToHM(null) === "", "null retorna vazio");
expect(tsToHM("") === "", "string vazia retorna vazio");
expect(tsToHM("invalid date") === "", "data invalida retorna vazio");
expect(/^\d{2}:\d{2}$/.test(tsToHM("2025-04-21T12:00:00.000Z")), "ISO string vira HH:MM");
expect(/^\d{2}:\d{2}$/.test(tsToHM(1713700800000)), "unix ms vira HH:MM");
expect(/^\d{2}:\d{2}$/.test(tsToHM(1713700800)), "unix s (< 1e12) vira HH:MM");

console.log("\n== extractName ==");
expect(extractName({pushname:"Ana"}, "5511@c.us") === "Ana", "usa pushname");
expect(extractName({notifyName:"Bob"}, "5511@c.us") === "Bob", "usa notifyName");
expect(extractName({}, "5511999@c.us") === "5511999", "fallback strip @c.us");
expect(extractName({}, "5511@s.whatsapp.net") === "5511", "fallback strip @s.whatsapp.net");
expect(extractName({}, null) === "Desconhecido", "fallback final");

console.log("\n== isFromMe ==");
expect(isFromMe({from_me: 1}) === true, "from_me number 1");
expect(isFromMe({from_me: 0}) === false, "from_me number 0");
expect(isFromMe({from_me: true}) === true, "from_me bool");
expect(isFromMe({fromMe: true}) === true, "fromMe camelCase bool");
expect(isFromMe({sent: 1}) === true, "sent number 1");
expect(isFromMe({direction: "out"}) === true, "direction out");
expect(isFromMe({direction: "in"}) === false, "direction in");
expect(isFromMe({}) === false, "default false");

console.log("\n== bodyOrMedia ==");
expect(bodyOrMedia({body: "ola"}) === "ola", "body presente");
expect(bodyOrMedia({text: "oi"}) === "oi", "text fallback");
expect(bodyOrMedia({message: "hi"}) === "hi", "message fallback");
expect(bodyOrMedia({body: "", has_media: 1}) === "[midia]", "midia SQL");
expect(bodyOrMedia({body: "", hasMedia: true}) === "[midia]", "midia camelCase");
expect(bodyOrMedia({}) === "", "vazio sem media");

console.log("\n== transformHistoryList (DESC -> ASC, mapping) ==");
{
  // DB retorna DESC (mais recente primeiro)
  const historyDesc = [
    { body: "msg 3", from_me: 1, timestamp: "2025-04-21T12:03:00.000Z" },
    { body: "msg 2", from_me: 0, timestamp: "2025-04-21T12:02:00.000Z" },
    { body: "msg 1", from_me: 0, timestamp: "2025-04-21T12:01:00.000Z" }
  ];
  const out = transformHistoryList(historyDesc);
  expect(out.length === 3, "3 msgs transformadas");
  expect(out[0].t === "msg 1", "ordem cronologica ASC (mais antiga primeiro)");
  expect(out[2].t === "msg 3", "ultima e a mais recente");
  expect(out[0].r === "u", "recebida = u");
  expect(out[2].r === "out", "enviada = out");
  expect(/^\d{2}:\d{2}$/.test(out[0].ts), "ts HH:MM");
}

console.log("\n== transformHistoryList com midia sem texto ==");
{
  const hist = [
    { body: "", has_media: 1, from_me: 0, timestamp: "2025-04-21T12:00:00.000Z" },
    { body: "texto", from_me: 1, timestamp: "2025-04-21T12:01:00.000Z" }
  ];
  const out = transformHistoryList(hist);
  expect(out.length === 2, "ambas incluidas");
  expect(out.find(m => m.t === "[midia]"), "midia virou [midia]");
}

console.log("\n== transformHistoryList vazio ==");
{
  expect(deepEq(transformHistoryList([]), []), "array vazio");
  expect(deepEq(transformHistoryList(null), []), "null");
  expect(deepEq(transformHistoryList(undefined), []), "undefined");
}

console.log("\n== dispatchSSE ==");
{
  let calls = [];
  const handlers = {
    checkConnection: () => calls.push("checkConnection"),
    toast: (t) => calls.push("toast:" + t),
    handleRealRow: (row, fromMe) => calls.push("row:" + (row && row.body) + "/" + fromMe)
  };

  calls = [];
  expect(dispatchSSE({type:"whatsapp_ready"}, handlers) === "whatsapp_ready", "ready dispatched");
  expect(calls[0] === "checkConnection", "ready chamou checkConnection");

  calls = [];
  expect(dispatchSSE({type:"whatsapp_disconnected"}, handlers) === "whatsapp_disconnected", "disconnected dispatched");
  expect(calls.includes("checkConnection"), "disconnected chamou checkConnection");
  expect(calls.some(c => c.startsWith("toast:")), "disconnected toasted");

  calls = [];
  expect(dispatchSSE({type:"message_in", data:{body:"oi", chat_id:"5511@c.us"}}, handlers) === "message_in", "message_in dispatched");
  expect(calls[0] === "row:oi/false", "message_in chamou handleRealRow com fromMe=false");

  calls = [];
  expect(dispatchSSE({type:"message_out", data:{body:"tchau", chat_id:"5511@c.us"}}, handlers) === "message_out", "message_out dispatched");
  expect(calls[0] === "row:tchau/true", "message_out chamou handleRealRow com fromMe=true");

  // fallback legado
  calls = [];
  expect(dispatchSSE({type:"new_message", data:{type:"message_in", data:{body:"legado", chat_id:"5511@c.us"}}}, handlers) === "new_message->in", "legado->in dispatched");
  expect(calls[0] === "row:legado/false", "legado->in handleRealRow correto");

  calls = [];
  expect(dispatchSSE({type:"new_message", data:{type:"message_out", data:{body:"legado-out", chat_id:"5511@c.us"}}}, handlers) === "new_message->out", "legado->out dispatched");
  expect(calls[0] === "row:legado-out/true", "legado->out handleRealRow correto");

  // payload bruto legado (sem innerType)
  calls = [];
  expect(dispatchSSE({type:"new_message", data:{chatId:"5511@c.us", body:"raw", fromMe:false}}, handlers) === "new_message->raw", "raw legado dispatched");
  expect(calls[0] === "row:raw/false", "raw legado handleRealRow correto");

  // ignored
  calls = [];
  expect(dispatchSSE({type:"desconhecido"}, handlers) === "ignored", "tipo desconhecido ignorado");
  expect(calls.length === 0, "nada foi chamado");
  expect(dispatchSSE(null, handlers) === null, "null evt retorna null");
  expect(dispatchSSE({}, handlers) === null, "evt sem type retorna null");
}

console.log(`\n=== Resultado: ${pass} pass, ${fail} fail ===`);
process.exit(fail === 0 ? 0 : 1);
