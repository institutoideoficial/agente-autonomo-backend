const express=require('express'),axios=require('axios'),cors=require('cors'),path=require('path'),app=express();
app.use(cors());
app.use(express.json({limit:'10mb'}));
app.use(express.static(path.join(__dirname,'public'),{setHeaders:(res,p)=>{if(p.endsWith('.html'))res.setHeader('Content-Type','text/html; charset=utf-8');}}));
const EVO=(process.env.EVOLUTION_URL||'https://evolution-api-production-a3c7.up.railway.app').replace(/\/+$/,'');
const EVO_KEY=process.env.EVOLUTION_KEY||'agentecreator123';
const SERVER_URL=(process.env.SERVER_URL||'https://agente-autonomo-production-cb49.up.railway.app').replace(/\/+$/,'');
const ANTHROPIC_KEY=process.env.ANTHROPIC_API_KEY;
const sseClients=[];
app.post('/webhook/whatsapp',async(req,res)=>{
  try{const body=req.body,event=body.event||body.type,data=body.data||body;
  if(event==='messages.upsert'||event==='MESSAGES_UPSERT'){
    const msg=data.messages?.[0]||data.message||data;
    const from=msg.key?.remoteJid||msg.from||'';
    const text=msg.message?.conversation||msg.message?.extendedTextMessage?.text||msg.text||'';
    if(!msg.key?.fromMe&&from&&text)broadcastEvent('new_message',{from,text,timestamp:new Date().toISOString(),instance:data.instance||'default'});
  }
  res.json({status:'ok'});}catch(e){res.status(500).json({error:e.message});}
});
app.get('/events',(req,res)=>{
  res.setHeader('Content-Type','text/event-stream');
  res.setHeader('Cache-Control','no-cache');
  res.setHeader('Connection','keep-alive');
  res.setHeader('Access-Control-Allow-Origin','*');
  res.write('data: {"type":"connected"}\n\n');
  const c={res};sseClients.push(c);
  req.on('close',()=>{const i=sseClients.indexOf(c);if(i!==-1)sseClients.splice(i,1);});
});
function broadcastEvent(type,data){const p=JSON.stringify({type,data});sseClients.forEach(c=>{try{c.res.write('data: '+p+'\n\n');}catch(e){}});}
app.post('/api/send',async(req,res)=>{
  try{const{instance,phone,message}=req.body;
  const r=await axios.post(EVO+'/message/sendText/'+instance,{number:phone,textMessage:{text:message}},{headers:{apikey:EVO_KEY}});
  res.json({ok:true,result:r.data});}catch(e){res.status(500).json({error:e.message});}
});
app.post('/api/pairing-code',async(req,res)=>{
  try{const{phone,instance}=req.body,inst=instance||'speakers-crm';
  try{await axios.post(EVO+'/instance/create',{instanceName:inst,qrcode:false,integration:'WHATSAPP-BAILEYS'},{headers:{apikey:EVO_KEY}});}catch(e){}
  try{await axios.post(EVO+'/webhook/set/'+inst,{webhook:{enabled:true,url:SERVER_URL+'/webhook/whatsapp',events:['MESSAGES_UPSERT']}},{headers:{apikey:EVO_KEY}});}catch(e){}
  const r=await axios.post(EVO+'/instance/pairingCode/'+inst,{number:phone.replace(/\D/g,'')},{headers:{apikey:EVO_KEY}});
  res.json({ok:true,code:r.data.code||r.data.pairingCode});}catch(e){res.status(500).json({error:e.response?.data?.message||e.message});}
});
app.get('/api/status/:instance',async(req,res)=>{
  try{const r=await axios.get(EVO+'/instance/connectionState/'+req.params.instance,{headers:{apikey:EVO_KEY}});res.json(r.data);}catch(e){res.status(500).json({error:e.message});}
});
app.post('/api/bot',async(req,res)=>{
  try{const{messages,context}=req.body;
  const r=await axios.post('https://api.anthropic.com/v1/messages',{model:'claude-haiku-4-5-20251001',max_tokens:300,system:'Atendente do '+(context||'Speakers Play')+'. Breve e profissional em portugues.',messages},{headers:{'x-api-key':ANTHROPIC_KEY,'anthropic-version':'2023-06-01'}});
  res.json({reply:r.data.content[0].text});}catch(e){res.status(500).json({error:e.message});}
});
app.get('/health',(req,res)=>res.json({ok:true,uptime:process.uptime()}));
const PORT=process.env.PORT||3000;app.listen(PORT,()=>console.log('SPEAKERS CRM porta '+PORT));
