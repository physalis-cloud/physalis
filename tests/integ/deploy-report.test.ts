// Integ — POST /api/deploy/report (C-0051, suivi des déploiements).
//
// Comme pour /api/deploy (cf. tests/integ/policies.test.ts) : le happy path
// exige un jeton OIDC signé par une vraie plateforme, impossible à produire
// contre le serveur live. Il est couvert par tests/lib/deployment.test.ts
// (registre) et tests/lib/oidc-multiprovider.test.ts (identité du run tirée du
// jeton signé), puis validé par un vrai run en Phase 2. Ici : la route existe,
// elle ne répond à rien sans jeton vérifié, et elle ne fuit rien en refusant.

import { describe, it, expect } from "vitest";
import { BASE_URL } from "./helpers/api";

const report = (headers: Record<string, string> = {}) =>
  fetch(`${BASE_URL}/api/deploy/report`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({
      project: "n-importe-lequel",
      environment: "production",
      status: "succeeded",
    }),
  });

// JWT bien formé, signature bidon, issuer GitHub : doit tomber à la vérification.
const forged = [
  { alg: "RS256", typ: "JWT", kid: "x" },
  {
    iss: "https://token.actions.githubusercontent.com",
    aud: "vault.physalis.cloud",
    repository: "acme/app",
    ref: "refs/heads/main",
    job_workflow_ref: "acme/app/.github/workflows/deploy.yml@refs/heads/main",
    run_id: "1",
    exp: Math.floor(Date.now() / 1000) + 300,
  },
]
  .map((part) => Buffer.from(JSON.stringify(part)).toString("base64url"))
  .concat("c2lnbmF0dXJl")
  .join(".");

describe("/api/deploy/report — chemins de refus", () => {
  it("sans Authorization → 401", async () => {
    expect((await report()).status).toBe(401);
  });

  it("Bearer qui n'est pas un JWT → 401", async () => {
    expect((await report({ authorization: "Bearer not-a-jwt" })).status).toBe(401);
  });

  it("JWT forgé (signature invalide) → 401, sans détail", async () => {
    const res = await report({ authorization: `Bearer ${forged}` });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  it("GET n'est pas exposé", async () => {
    const res = await fetch(`${BASE_URL}/api/deploy/report`);
    expect(res.status).toBe(405);
  });
});
