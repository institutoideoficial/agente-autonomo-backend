#!/usr/bin/env bash
# smoke-test.sh - valida que a stack esta respondendo corretamente apos deploy.
# Rodar DE DENTRO da VPS (ou de qualquer lugar, se os dominios resolvem):
#   ./smoke-test.sh               # usa DOMAIN_CRM do .env
#   ./smoke-test.sh https://crm.exemplo.com
set -euo pipefail

BASE="${1:-}"
if [ -z "$BASE" ]; then
  if [ -f .env ]; then
    # shellcheck disable=SC1091
    . .env
    BASE="https://${DOMAIN_CRM}"
  else
    echo "Uso: $0 <URL_BASE> (ex: https://crm.exemplo.com)"
    exit 1
  fi
fi

echo "==> smoke-test contra $BASE"
pass=0; fail=0
check() {
  local label="$1"; shift
  if "$@"; then echo "  PASS: $label"; pass=$((pass+1))
  else echo "  FAIL: $label"; fail=$((fail+1)); fi
}

# 1. /health responde {ok:true}
check "/health retorna ok:true" bash -c "
  r=\$(curl -sS --max-time 10 '$BASE/health') && [ \"\$r\" = '{\"ok\":true,\"service\":\"speakers-crm-backend\"}' ]
"

# 2. /api/status/speakers-crm responde com status
check "/api/status retorna JSON com 'state'" bash -c "
  r=\$(curl -sS --max-time 10 '$BASE/api/status/speakers-crm') && echo \"\$r\" | grep -q 'state'
"

# 3. GET / serve welcome.html
check "GET / tem 'SPEAKERS CRM'" bash -c "
  curl -sS --max-time 10 '$BASE/' | grep -q 'SPEAKERS CRM'
"

# 4. GET /app serve patch v4.1
check "/app tem patch v4.1" bash -c "
  curl -sS --max-time 10 '$BASE/app' | grep -q 'IMPERADOR REAL-TIME PATCH v4.1'
"

# 5. SSE /events responde com content-type correto
check "/events eh text/event-stream" bash -c "
  ct=\$(curl -sSI --max-time 10 '$BASE/events' | grep -i '^content-type' | tr -d '\r') &&
  echo \"\$ct\" | grep -qi 'text/event-stream'
"

# 6. POST /api/send-message sem phone -> 400
check "/api/send-message sem phone -> 400" bash -c "
  code=\$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 -X POST '$BASE/api/send-message' -H 'Content-Type: application/json' -d '{\"message\":\"x\"}') &&
  [ \"\$code\" = '400' ]
"

# 7. GET /api/history sem chatId -> 400
check "/api/history sem chatId -> 400" bash -c "
  code=\$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 '$BASE/api/history') &&
  [ \"\$code\" = '400' ]
"

# 8. /api/bot sem ANTHROPIC_API_KEY -> 500
check "/api/bot sem chave -> 500 (ou 200 se configurou)" bash -c "
  code=\$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 -X POST '$BASE/api/bot' -H 'Content-Type: application/json' -d '{\"messages\":[{\"role\":\"user\",\"content\":\"oi\"}]}') &&
  [ \"\$code\" = '500' ] || [ \"\$code\" = '200' ]
"

# 9. TLS certificado valido (so se usar HTTPS)
if [[ "$BASE" == https://* ]]; then
  check "HTTPS com cert valido" bash -c "
    curl -sSI --max-time 10 '$BASE/health' > /dev/null
  "
fi

echo ""
echo "==> $pass pass, $fail fail"
[ "$fail" -eq 0 ]
