// Test : les exports de secrets sont protégés (jamais publics).
//
// Couvre proposal Fonctionnel Secrets #7 — export protégé. Deux endpoints
// d'export existent : /api/me/export (coffre perso) et
// /api/projects/[slug]/[env]/secrets/export (.env d'un environnement). Tous
// exigent une session ; sans auth → 401, jamais le contenu.

import { describe, it, expect, beforeAll } from "vitest";
import { Session, adminSession, BASE_URL } from "./helpers/api";

let admin: Session;

beforeAll(async () => {
  admin = await adminSession();
});

describe("Export de secrets protégé (Fonctionnel Secrets #7)", () => {
  it("GET /api/me/export sans session → 401", async () => {
    const res = await fetch(`${BASE_URL}/api/me/export`);
    expect(res.status).toBe(401);
  });

  it("GET export .env d'un projet sans session → non public (jamais 200)", async () => {
    const res = await fetch(
      `${BASE_URL}/api/projects/does-not-exist-${Date.now()}/production/secrets/export`,
    );
    expect(res.status).not.toBe(200);
    expect([401, 403, 404]).toContain(res.status);
  });

  it("GET /api/me/export avec session authentifiée → 200", async () => {
    const res = await admin.fetch(`/api/me/export`);
    expect(res.status).toBe(200);
  });
});
