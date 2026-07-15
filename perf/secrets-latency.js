// k6 — latence de GET /api/secrets/<slug>/<env> (Perf #1 : réponse < 200 ms).
//
// Hot path représentative : validation du token machine + résolution tenant +
// findMany des secrets + déchiffrement AES-GCM de chacun (couvre aussi
// l'overhead crypto, Perf #3). Charge modérée et soutenue → mesure un p95
// stable, pas un pic isolé.
//
// Lancement (via perf/run.sh, qui injecte les variables depuis .fixture.json) :
//   k6 run -e BASE_URL=… -e SLUG=… -e ENV=production -e TOKEN=sv_… \
//          perf/secrets-latency.js
//
// Réglables : PERF_VUS (def 10), PERF_DURATION (def 30s), PERF_P95_MS (def 200).

import http from "k6/http";
import { check } from "k6";

const BASE_URL = __ENV.BASE_URL || "http://localhost:3006";
const SLUG = __ENV.SLUG;
const ENV = __ENV.ENV || "production";
const TOKEN = __ENV.TOKEN;
const P95_MS = Number(__ENV.PERF_P95_MS || 200);

export const options = {
  vus: Number(__ENV.PERF_VUS || 10),
  duration: __ENV.PERF_DURATION || "30s",
  thresholds: {
    // Objectif catalogue : p95 < 200 ms. p99 toléré plus large.
    http_req_duration: [`p(95)<${P95_MS}`, "p(99)<500"],
    // Aucune requête en erreur ne doit passer (token valide, endpoint sain).
    checks: ["rate>0.99"],
    http_req_failed: ["rate<0.01"],
  },
};

const URL = `${BASE_URL}/api/secrets/${SLUG}/${ENV}`;
const params = { headers: { Authorization: `Bearer ${TOKEN}` } };

export default function () {
  const res = http.get(URL, params);
  check(res, {
    "status 200": (r) => r.status === 200,
    "body contient des secrets": (r) => {
      try {
        return Object.keys(JSON.parse(r.body).secrets || {}).length > 0;
      } catch {
        return false;
      }
    },
  });
}
