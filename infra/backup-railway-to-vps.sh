#!/usr/bin/env bash
# backup-railway-to-vps.sh
# Tenta extrair o SQLite do Bravos no Railway e trazer pra VPS.
# Como os volumes do Railway nao foram anexados corretamente, provavelmente a
# sessao WhatsApp ja foi perdida. Mas se o SQLite tiver mensagens, vale a pena
# preservar pra nao perder o historico.
#
# Rodar NO SEU PC LOCAL (nao na VPS), com Railway CLI instalada:
#   npm i -g @railway/cli
#   railway login
#   railway link     # seleciona projeto surprising-recreation, servico bravos-whatsapp-api
#   ./backup-railway-to-vps.sh deploy@IP_DA_VPS
set -euo pipefail

VPS_USER_HOST="${1:-}"
if [ -z "$VPS_USER_HOST" ]; then
  echo "Uso: $0 deploy@IP_DA_VPS"
  echo "     (o destino precisa ter o docker-compose ja rodando)"
  exit 1
fi

BACKUP_DIR="./railway-backup-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP_DIR"

echo "==> Tentando copiar SQLite do Bravos (Railway)"
# railway run baixa e executa remoto; usamos cat pra stream o arquivo
if railway run --service bravos-whatsapp-api "cat /app/data/whatsapp.db" > "$BACKUP_DIR/whatsapp.db" 2>/dev/null; then
  size=$(wc -c < "$BACKUP_DIR/whatsapp.db")
  if [ "$size" -lt 100 ]; then
    echo "  [aviso] SQLite esta vazio ou corrompido ($size bytes). Provavelmente sem volume persistente."
    rm "$BACKUP_DIR/whatsapp.db"
  else
    echo "  OK: $size bytes salvos em $BACKUP_DIR/whatsapp.db"
  fi
else
  echo "  [aviso] Nao foi possivel ler o SQLite. Pode ser porque o volume nao esta montado."
fi

echo "==> Tentando copiar sessao WhatsApp (.wwebjs_auth)"
if railway run --service bravos-whatsapp-api "tar czf - .wwebjs_auth 2>/dev/null || true" > "$BACKUP_DIR/wwebjs_auth.tar.gz" 2>/dev/null; then
  size=$(wc -c < "$BACKUP_DIR/wwebjs_auth.tar.gz")
  if [ "$size" -lt 1000 ]; then
    echo "  [aviso] Sessao WhatsApp vazia. Vai ter que escanear QR na VPS."
    rm "$BACKUP_DIR/wwebjs_auth.tar.gz"
  else
    echo "  OK: $size bytes salvos"
  fi
fi

if [ -z "$(ls -A "$BACKUP_DIR" 2>/dev/null)" ]; then
  echo ""
  echo "==> Nada util pra restaurar (volumes Railway vazios)."
  echo "    Apenas escaneie o QR na VPS apos docker compose up -d."
  rmdir "$BACKUP_DIR"
  exit 0
fi

echo ""
echo "==> Enviando pra VPS $VPS_USER_HOST"
scp -r "$BACKUP_DIR" "$VPS_USER_HOST:/tmp/railway-backup"

echo ""
echo "==> Restaurando na VPS"
# shellcheck disable=SC2087
ssh "$VPS_USER_HOST" bash <<'REMOTE'
set -e
cd /opt/speakers-crm/agente-autonomo-backend/infra
docker compose stop bravos || true
if [ -f /tmp/railway-backup/*/whatsapp.db ]; then
  docker run --rm -v infra_bravos_data:/data -v /tmp/railway-backup:/backup alpine \
    sh -c "cp /backup/*/whatsapp.db /data/whatsapp.db && chmod 666 /data/whatsapp.db"
  echo "SQLite restaurado."
fi
if [ -f /tmp/railway-backup/*/wwebjs_auth.tar.gz ]; then
  docker run --rm -v infra_bravos_wwebjs:/wwebjs -v /tmp/railway-backup:/backup alpine \
    sh -c "cd /wwebjs && tar xzf /backup/*/wwebjs_auth.tar.gz --strip-components=1 || true"
  echo "Sessao WhatsApp restaurada."
fi
docker compose up -d bravos
rm -rf /tmp/railway-backup
REMOTE

echo ""
echo "==> Backup restaurado. Verifique o QR com:"
echo "    ssh $VPS_USER_HOST 'cd /opt/speakers-crm/agente-autonomo-backend/infra && docker compose logs -f bravos'"
