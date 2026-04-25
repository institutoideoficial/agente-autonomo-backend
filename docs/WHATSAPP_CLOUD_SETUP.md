# WhatsApp Cloud API (Meta) — Setup oficial

Migra do whatsapp-web.js (não-oficial, com risco de ban) pra **WhatsApp Business Cloud API** da Meta.
Vantagens: oficial, sem risco de banimento, gratuito até 1000 conversas/mês iniciadas pela empresa.

## Pré-requisitos
- Conta Facebook (pessoal serve)
- Acesso a um número de telefone (NOVO ou pode migrar o seu — vide passo 4)
- Receber SMS/voz pra verificar o número

## Passo 1 — Meta Business Manager (5 min)

1. Acesse https://business.facebook.com/
2. Clique **Criar conta** (ou use existente)
3. Preencha nome do negócio, seu nome, email
4. Confirme email

## Passo 2 — Criar App em Meta for Developers (3 min)

1. Acesse https://developers.facebook.com/apps
2. **Criar App** → tipo **Business**
3. Nome: `Speakers CRM`
4. Selecione a Meta Business Account criada no passo 1
5. Em **Adicionar produto**, escolha **WhatsApp** → **Configurar**

## Passo 3 — Configuração WhatsApp (10 min)

1. No menu lateral: **WhatsApp → API Setup**
2. Você verá:
   - **App ID**, **App Secret**
   - **Temporary access token** (válido 24h — útil pra teste)
   - **Test number** (número grátis US, +1...) com 5 destinatários permitidos
3. **Anote** Phone Number ID e Token

## Passo 4 — Adicionar SEU número (produção)

**Opção A — Número novo dedicado** (RECOMENDADO):
1. Compre/use um chip novo
2. Em WhatsApp → **API Setup** → **Add phone number** → siga o fluxo

**Opção B — Migrar seu número atual**:
⚠️ Você **PERDE** o WhatsApp normal nesse número.
1. Mesmo fluxo "Add phone number"
2. Verifica via SMS

## Passo 5 — Permanent Access Token (importante)

O temporary token vale 24h. Pra produção precisa permanente:

1. Vá em **Business Settings** (`business.facebook.com/settings`)
2. **Users → System Users** → **Add**
3. Nome: `crm-api-user` · Role: **Admin**
4. Em **Generate New Token**:
   - App: o seu Speakers CRM
   - Token expiration: **Never**
   - Permissions: **whatsapp_business_messaging**, **whatsapp_business_management**
5. **Generate** → COPIE o token (começa com `EAA...`) — só aparece uma vez

## Passo 6 — Configurar no servidor CRM

SSH na VPS, edite o `.env`:
```bash
cd /opt/speakers-crm/agente-autonomo-backend/infra
nano .env
```

Adicione:
```bash
WA_CLOUD_TOKEN=EAA...seu_token_permanente_aqui
WA_CLOUD_PHONE_ID=123456789012345
WA_CLOUD_VERIFY_TOKEN=imperador-verify-2026
WA_CLOUD_API_VERSION=v20.0
```

Restart:
```bash
docker compose restart crm
```

## Passo 7 — Configurar Webhook no Meta

1. No painel Meta: **WhatsApp → Configuration → Webhook**
2. **Edit** ao lado de "Callback URL":
   - **Callback URL**: `http://185.2.101.99/api/webhook/wa-cloud`
   - **Verify token**: `imperador-verify-2026` (ou o valor que você setou)
3. Clique **Verify and save**
4. Em **Webhook fields**, marque: `messages` (mensagens recebidas), `message_status` (entregue/lido)

## Passo 8 — Testar

No CRM, abra Integrações → WhatsApp Cloud → Botão **Enviar teste** com seu número.
Ou via API:
```bash
curl -X POST http://185.2.101.99/api/integrations/wa-cloud/test \
  -H 'Content-Type: application/json' \
  -d '{"phone":"5511999990000","message":"Teste do CRM"}'
```

## Limitações importantes

- **Janela 24h**: você só pode mandar mensagem livre dentro de 24h da última mensagem do cliente. Fora disso, precisa **template message** aprovado.
- **Templates** são pré-aprovados pelo Meta (1-3 dias). Use pra primeira abordagem, follow-up.
- **Display name**: o nome que aparece no WhatsApp dos clientes. Submete em **WhatsApp → Phone numbers** → 2-3 dias aprovação.
- **Quality rating**: começa **GREEN**. Se receber muitos blocks/reports, vai pra YELLOW/RED. Em RED, número é bloqueado.

## Custos

- **Conversas iniciadas pelo cliente**: gratuitas até 1000/mês (depois ~$0.005-0.07 por conversa, depende do país)
- **Conversas iniciadas por você (template)**: cobradas conforme tabela Meta
- **Verificação de número**: gratuito

## FAQ

**Posso usar com whatsapp-web.js (Bravos) ao mesmo tempo?**
Não no mesmo número. Mas o CRM auto-detecta: se WA_CLOUD_TOKEN setado, usa Cloud API; senão Bravos.

**E se quiser voltar pro Bravos?**
Comenta as linhas WA_CLOUD_* no .env e restart.

**O número do Cloud API funciona no app WhatsApp normal?**
NÃO. Quando você adiciona o número ao Cloud API, ele sai do app. Por isso recomendo número dedicado.
