# Harness de performance (bucket B — Perf)

Tests de charge **hors suite Vitest**, lancés à la demande contre une stack live
(local `:3006` ou staging). Couvre les items « Performance & Charge » du
catalogue (`docs/steps-docs/todo/proposition de test.md`).

## Pré-requis
- Stack live (`docker compose up -d`) joignable sur `PERF_BASE_URL` (def `http://localhost:3006`).
- Conteneur DB accessible via `docker exec` (`PERF_DB_CONTAINER`, def `physalis-db`).
- [`k6`](https://k6.io) installé (`which k6`).
- Tenant `test` existant (schéma `client_test`).

## Lancement rapide
```bash
perf/run.sh            # seed → latence + spike → teardown (garanti via trap)
perf/run.sh latency    # un seul scénario
PERF_SECRETS=200 perf/run.sh   # fixture plus grosse
```

Le seed crée un admin jetable + org + projet + N secrets + un token machine, et
écrit `perf/.fixture.json`. Le teardown supprime tout (projet en cascade, org,
admin, AccessLog). `.fixture.json` n'est **pas** versionné.

## Scénarios

| Fichier | Item catalogue | Mesure / seuil |
|---------|----------------|----------------|
| `secrets-latency.js` | **#1** réponse < 200 ms | `GET /api/secrets/<slug>/<env>` (Bearer), 10 VUs / 30 s → **p95 < 200 ms**, 0 erreur |
| `secrets-spike.js` | **#4** pool exhaustion · **#6** spike | montée 0→`PERF_PEAK_VUS` (def 100) → **taux d'erreur < 1 %**, p99 < 2 s (le serveur tient) |
| `crypto.bench.ts` | **#3** overhead chiffrement | `npx vitest bench --run perf/crypto.bench.ts` → débit encrypt/decrypt (garde-fou régression) |

### #2 — Pas de N+1
La hot path `GET /api/secrets/<slug>/<env>` exécute **une seule** requête
(`tx.secret.findMany`) puis déchiffre en mémoire (boucle sans requête) — pas de
N+1 par construction (cf. `app/api/secrets/[slug]/[env]/route.ts`). Le scénario
latence sert de garde-fou : la p95 reste plate quand on augmente `PERF_SECRETS`,
ce qui ne serait pas le cas avec une requête par secret.

### #5 — Fuite mémoire (longue durée)
Hors de ce harness : nécessite un soak test prolongé (heures) + suivi du RSS du
conteneur. À traiter via monitoring (Grafana/cAdvisor) plutôt qu'un run k6 ponctuel.

## Réglages (env)
`PERF_BASE_URL`, `PERF_TENANT`, `PERF_SECRETS`, `PERF_VUS`, `PERF_DURATION`,
`PERF_P95_MS`, `PERF_PEAK_VUS`, `PERF_DB_CONTAINER`.
