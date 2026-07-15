#!/bin/bash
# physalis-purge-accounts.sh — déclenche la purge quotidienne des comptes
# (DROP SCHEMA des comptes dont la fenêtre de récup 30j est écoulée).
#
# Tourne sur le VPS `argostaging` (déjà sur le tailnet), PAS sur GitHub Actions :
# l'endpoint /api/cron/purge-accounts est restreint au réseau privé (Phase 2,
# `CRON_PRIVATE_ONLY`). `vault.physalis.cloud` résout vers l'IP tailnet de Ginko
# via /etc/hosts sur argostaging → l'appel part par le tailnet (pas Cloudflare),
# donc pas de `CF-Connecting-IP` → autorisé par requirePrivateOrigin.
#
# Le token CRON_SECRET_ADMIN est passé à curl via --config (stdin) pour NE PAS
# apparaître dans `ps`.
#
# Env (cron.d) : CRON_SECRET_ADMIN (requis), VAULT_URL (déf vault.physalis.cloud).
# Installation : sudo install -m700 -oroot -groot physalis-purge-accounts.sh /usr/local/bin/

set -euo pipefail

VAULT_URL="${VAULT_URL:-https://vault.physalis.cloud}"
TOKEN="${CRON_SECRET_ADMIN:-}"
LOG="${PURGE_LOG:-/var/log/physalis-purge.log}"

log() { echo "$(date -Iseconds) [purge] $*" | tee -a "$LOG" >&2; }

[ -n "$TOKEN" ] || { log "FAILURE: CRON_SECRET_ADMIN manquant"; exit 1; }

BODY_FILE="$(mktemp)"
trap 'rm -f "$BODY_FILE"' EXIT

# Header d'auth via --config (stdin) → hors argv/ps.
STATUS=$(printf 'header = "Authorization: Bearer %s"\n' "$TOKEN" \
  | curl -sS -m 30 --retry 2 -o "$BODY_FILE" -w "%{http_code}" \
      -X POST -H "Content-Type: application/json" \
      --config - "$VAULT_URL/api/cron/purge-accounts")

BODY="$(cat "$BODY_FILE" 2>/dev/null || true)"

if [ "$STATUS" = "200" ]; then
  log "OK: $BODY"
else
  log "FAILURE: HTTP $STATUS — $BODY"
  exit 1
fi
