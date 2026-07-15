#!/usr/bin/env bash
# Orchestrateur du harness de perf : seed → k6 (latence + spike) → teardown.
# Le teardown est garanti même en cas d'échec d'un scénario (trap EXIT).
#
# Usage :
#   perf/run.sh                # latence + spike contre $PERF_BASE_URL (def :3006)
#   PERF_BASE_URL=http://localhost:3006 PERF_SECRETS=100 perf/run.sh
#   perf/run.sh latency        # un seul scénario
#
# Pré-requis : stack live + k6 installé + conteneur DB accessible (docker exec).
set -euo pipefail
cd "$(dirname "$0")/.."

SCENARIO="${1:-all}"
FIXTURE="perf/.fixture.json"

cleanup() { node perf/teardown.mjs || true; }
trap cleanup EXIT

echo "▶ seed"
node perf/seed.mjs

BASE_URL=$(node -e "console.log(require('./$FIXTURE').baseUrl)")
SLUG=$(node -e "console.log(require('./$FIXTURE').slug)")
TOKEN=$(node -e "console.log(require('./$FIXTURE').token)")
COMMON=(-e "BASE_URL=$BASE_URL" -e "SLUG=$SLUG" -e "ENV=production" -e "TOKEN=$TOKEN")

if [[ "$SCENARIO" == "all" || "$SCENARIO" == "latency" ]]; then
  echo "▶ k6 latence (Perf #1)"
  k6 run "${COMMON[@]}" perf/secrets-latency.js
fi

if [[ "$SCENARIO" == "all" || "$SCENARIO" == "spike" ]]; then
  echo "▶ k6 spike / pool exhaustion (Perf #4, #6)"
  k6 run "${COMMON[@]}" perf/secrets-spike.js
fi

echo "✓ perf terminé"
