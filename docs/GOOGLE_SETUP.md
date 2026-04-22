# Configurar Google Calendar + Meet no CRM

Para usar a integração Google você precisa criar um projeto no **Google Cloud Console** (grátis, ~5 min, faz uma vez só).

## Passo 1 — Criar projeto Google Cloud

1. Acesse https://console.cloud.google.com/ e faça login com a conta Google que quer integrar
2. No canto superior esquerdo, clique no seletor de projeto → **Novo projeto**
3. Nome: `Speakers CRM` (ou qualquer outro) → Criar
4. Aguarde a criação e selecione o projeto criado

## Passo 2 — Ativar a Google Calendar API

1. Menu lateral → **APIs e Serviços** → **Biblioteca**
2. Busque por `Google Calendar API`
3. Clique no card → botão **Ativar**

## Passo 3 — Configurar a tela de consentimento OAuth

1. Menu lateral → **APIs e Serviços** → **Tela de consentimento OAuth**
2. Tipo de usuário: **Externo** → Criar
3. Preencha:
   - **Nome do app:** `Speakers CRM`
   - **Email de suporte do usuário:** seu email
   - **Email do desenvolvedor:** seu email
4. Próximo → Escopos (pode pular, adicionamos pela URL)
5. Próximo → Usuários de teste → adicione seu próprio email → Próximo
6. Finalizar

## Passo 4 — Criar credenciais OAuth

1. Menu lateral → **APIs e Serviços** → **Credenciais**
2. Botão **+ Criar credenciais** → **ID do cliente OAuth**
3. Tipo de aplicativo: **Aplicativo da Web**
4. Nome: `CRM Web`
5. **URIs de redirecionamento autorizados** → **+ Adicionar URI**
   Cole aqui o URI que aparece na tela Integrações > Google do CRM. Vai ser algo como:
   - Local: `http://localhost:3000/oauth/google/callback`
   - Produção: `https://crm.seudominio.com/oauth/google/callback`

   Pode adicionar os dois se usar ambos.
6. Criar
7. Copie o **Client ID** e **Client Secret** (um modal vai mostrar os dois)

## Passo 5 — Configurar no servidor CRM

Adicione estas variáveis de ambiente no servidor onde o CRM roda:

```bash
GOOGLE_CLIENT_ID=1234567890-xxxxxxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-xxxxxxxxxxxx
# Opcional — se vazio, usa protocol+host da request
GOOGLE_REDIRECT_URI=http://localhost:3000/oauth/google/callback
```

Se estiver rodando em **Railway/VPS**, adicione nas variáveis do serviço.

**Reinicie o servidor.**

## Passo 6 — Conectar sua conta

1. Abra o CRM → 🔌 Integrações → aba 📅 Google
2. Clique em **Conectar Google** → abre popup
3. Escolha a conta Google que quer usar
4. Permita acesso ao Google Calendar quando pedir
5. Feche a janela quando aparecer "✅ Conectado!"
6. A página recarrega e mostra sua conta conectada + próximos eventos

## O que você pode fazer depois de conectado

- **Criar evento com Meet link automático** direto do CRM
- **Listar os próximos 30 dias** de eventos da agenda principal
- **Convidar alunos por email** (cai na agenda deles automaticamente)
- **Excluir eventos** (envia cancelamento pros convidados)
- **Vincular evento a uma conversa** do CRM (metadata salva chatId)

## Trocar de conta / desconectar

Página Integrações → Google → botão **Desconectar**. Próxima conexão abre o fluxo novamente.

## Dúvidas comuns

**"App não verificado"** aparece no popup do Google?
É esperado — seu app está em modo desenvolvimento. Clique em *Avançado* → *Ir para Speakers CRM (não seguro)*. Quando quiser remover esse aviso, publique o app no Google Cloud (não precisa pra uso pessoal).

**Quantas contas Google posso conectar?**
No momento, 1 por servidor (fica em `data/google-tokens.json`). Se precisar múltiplas, pode separar via multi-tenancy depois.

**É seguro?**
Os tokens ficam só no servidor, em `data/google-tokens.json` (com `.gitignore`). Não são expostos ao frontend. O escopo é limitado a Calendar + info básica do usuário.
