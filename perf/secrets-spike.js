// k6 — résilience de la hot path sous pic de trafic + saturation du pool
// (Perf #4 pool exhaustion, Perf #6 spike).
//
// Monte brutalement à PERF_PEAK_VUS sur GET /api/secrets/<slug>/<env>, plateau,
// puis redescend. On NE fixe PAS un p95 strict (un pic dégrade la latence par
// nature) : on vérifie que le serveur TIENT — pas d'effondrement (5xx / connexions
// refusées par épuisement du pool DB). Le seuil dur porte donc sur le taux
// d'erreur, pas sur la latence.
//
// Lancement (via perf/run.sh) :
//   k6 run -e BASE_URL=… -e SLUG=… -e ENV=production -e TOKEN=sv_… \
//          perf/secrets-spike.js
//
// Réglables : PERF_PEAK_VUS (def 100).

import http from "k6/http";
import { check } from "k6";

const BASE_URL = __ENV.BASE_URL || "http://localhost:3006";
const SLUG = __ENV.SLUG;
const ENV = __ENV.ENV || "production";
const TOKEN = __ENV.TOKEN;
const PEAK = Number(__ENV.PERF_PEAK_VUS || 100);

export const options = {
  scenarios: {
    spike: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "5s", target: PEAK }, // montée brutale
        { duration: "15s", target: PEAK }, // plateau de charge
        { duration: "5s", target: 0 }, // redescente
      ],
      gracefulRampDown: "5s",
    },
  },
  thresholds: {
    // Le serveur doit ENCAISSER : < 1 % d'erreurs même au pic (pas
    // d'effondrement par épuisement du pool DB / refus de connexion).
    http_req_failed: ["rate<0.01"],
    checks: ["rate>0.99"],
    // p99 < 2 s : dégradation tolérée mais bornée (pas de timeouts en cascade).
    http_req_duration: ["p(99)<2000"],
  },
};

const URL = `${BASE_URL}/api/secrets/${SLUG}/${ENV}`;
const params = { headers: { Authorization: `Bearer ${TOKEN}` } };

export default function () {
  const res = http.get(URL, params);
  check(res, { "status 200": (r) => r.status === 200 });
}
