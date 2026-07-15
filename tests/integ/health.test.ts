// Test de l'endpoint de monitoring /api/health.
//
// Couvre proposal Infrastructure #10 — healthcheck répond 200 + statut DB.
//
// Endpoint public (sans auth), sondé par check-primary.sh / failover /
// healthchecks.io. Retourne 200 si la DB répond, 503 sinon.

import { describe, it, expect } from "vitest";
import { BASE_URL } from "./helpers/api";

describe("Healthcheck /api/health (Infra #10)", () => {
  it("GET /api/health → 200 + { status:'ok', db:'ok' } sans authentification", async () => {
    const res = await fetch(`${BASE_URL}/api/health`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      status?: string;
      db?: string;
      db_latency_ms?: number | null;
      ts?: string;
    };
    expect(body.status).toBe("ok");
    expect(body.db).toBe("ok");
    expect(body.db_latency_ms).not.toBeNull();
    expect(typeof body.ts).toBe("string");
  });

  it("ne nécessite aucun cookie de session (route de monitoring)", async () => {
    // Appel volontairement nu (aucun header d'auth) → doit rester 200.
    const res = await fetch(`${BASE_URL}/api/health`, {
      headers: { "x-forwarded-for": "203.0.113.250" },
    });
    expect(res.status).toBe(200);
  });
});
