# Deploy em VPS (Contabo / DigitalOcean / Hetzner / qualquer Ubuntu 22.04)

Stack: **CRM (Node)** + **Bravos (WhatsApp)** + **Caddy (HTTPS auto)**, tudo em Docker Compose.

## Pre-requisitos
- VPS Ubuntu 22.04+ com IP publico (minimo 2 GB RAM, 2 vCPU).
- (Opcional mas recomendado) Dominio apontado pra VPS via DNS A record.
- SSH key no seu PC (`ssh-keygen -t ed25519` se ainda nao tiver).

## Setup inicial (1 vez so)

### 1. Upload da ssh key pro VPS
```bash
# No seu PC:
ssh-copy-id root@IP_DA_VPS
# Ou manualmente: cat ~/.ssh/id_ed25519.pub | ssh root@IP "cat >> ~/.ssh/authorized_keys"
```

### 2. Setup da VPS
```bash
ssh root@IP_DA_VPS
curl -sL https://raw.githubusercontent.com/Labastie/agente-autonomo-backend/main/infra/setup-vps.sh | bash
```
(Instala Docker, firewall, fail2ban, user `deploy`, clona os repos.)

### 3. Configurar .env
```bash
su - deploy
cd /opt/speakers-crm/agente-autonomo-backend/infra
cp .env.example .env
nano .env
```
Preencha:
- `DOMAIN_CRM` = dominio ou IP
- `API_TOKEN` = gere com `openssl rand -hex 32`
- `ACME_EMAIL` = seu email
- `ANTHROPIC_API_KEY` = opcional (deixa em branco se nao usa bot)

### 4. Subir a stack
```bash
docker compose up -d --build
docker compose logs -f bravos
# Quando aparecer QR no log, escaneie com seu WhatsApp
# (ou abra http://IP_DA_VPS:3001/ se expuser a porta temporariamente)
```

## Updates (apos cada commit no GitHub)
```bash
ssh deploy@IP_DA_VPS
cd /opt/speakers-crm/agente-autonomo-backend/infra
./deploy.sh
```

## Smoke test pos-deploy
Valida que todos os endpoints estao respondendo corretamente:
```bash
./smoke-test.sh                              # usa DOMAIN_CRM do .env
./smoke-test.sh https://crm.seudominio.com   # ou passa URL manual
```
Checa: /health, /api/status, /app serve patch v4.1, /events eh SSE,
validacao de input (400), /api/bot retorna 500 sem chave, TLS valido.

## Migracao de dados do Railway (opcional)
Se havia historico/sessao no Railway que vale a pena preservar:
```bash
# No seu PC local:
npm i -g @railway/cli
railway login
railway link    # seleciona projeto/servico bravos
./backup-railway-to-vps.sh deploy@IP_DA_VPS
```
Provavelmente os volumes do Railway estavam sem persistencia, entao o
script so vai confirmar que nao ha nada util. Nesse caso, so escaneie
o QR na VPS.

## Comandos uteis
```bash
docker compose ps                       # status
docker compose logs -f crm              # logs do CRM
docker compose logs -f bravos           # logs do WhatsApp
docker compose restart bravos           # reinicia so o Bravos
docker compose down && docker compose up -d   # restart completo
docker compose exec bravos sh           # shell dentro do container
```

## Backup
```bash
# Backup do SQLite do Bravos + sessao WhatsApp
docker run --rm -v bravos_data:/data -v bravos_wwebjs:/wwebjs -v $(pwd):/backup alpine \
  tar czf /backup/bravos-backup-$(date +%Y%m%d).tar.gz /data /wwebjs
```

## Troubleshooting

### Caddy nao pega certificado
- Verifique que o dominio aponta pro IP (`dig DOMAIN_CRM +short`)
- Verifique que portas 80 e 443 estao abertas (`sudo ufw status`)
- Logs: `docker compose logs caddy`

### WhatsApp desconecta em loop
- Verifique volume persistente: `docker volume inspect infra_bravos_wwebjs`
- Se perdeu sessao, re-escaneie: `docker compose logs bravos`

### CRM nao conecta no Bravos
- Teste de dentro do container: `docker compose exec crm wget -qO- http://bravos:3001/health`
- Confira `BRAVOS_URL=http://bravos:3001` (nome do service, nao localhost)
