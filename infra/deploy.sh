#!/usr/bin/env bash
# deploy.sh - pull + rebuild. Rodar como user 'deploy' apos cada commit no GitHub.
set -euo pipefail

BASE=/opt/speakers-crm
cd "$BASE/agente-autonomo-backend" && git pull --ff-only
cd "$BASE/bravos-whatsapp-api"     && git pull --ff-only

cd "$BASE/agente-autonomo-backend/infra"
docker compose pull || true
docker compose up -d --build

echo ""
echo "==> Status:"
docker compose ps
echo ""
echo "==> Logs (Ctrl+C pra sair):"
docker compose logs -f --tail=30
