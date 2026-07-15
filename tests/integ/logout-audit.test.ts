// Test : la déconnexion est tracée dans l'audit (AccessAction LOGOUT).
//
// Couvre le trou « logout non tracé » relevé dans l'audit de couverture
// (proposal Audit Log — actions d'authentification). Avant ce lot, l'enum
// AccessAction n'avait pas de valeur LOGOUT et signOut n'était pas loggué.
//
// Flux : login (adminSession) → POST /api/auth/signout (csrf) → l'event
// NextAuth `signOut` écrit une ligne AccessLog action=LOGOUT pour l'user.

import { describe, it, expect, beforeAll } from "vitest";
import {
  Session,
  adminSession,
  ADMIN_EMAIL,
  TENANT_SCHEMA,
} from "./helpers/api";
import { execSql } from "./helpers/db";

let admin: Session;

async function logoutCount(email: string): Promise<number> {
  return parseInt(
    (
      await execSql(
        `SELECT COUNT(*) FROM "${TENANT_SCHEMA}"."AccessLog"
         WHERE action = 'LOGOUT' AND "actorUserEmail" = '${email}'`,
      )
    ).trim(),
    10,
  );
}

/** L'event est fire-and-forget → on attend ~3s l'apparition de la ligne. */
async function waitLogoutCountAbove(email: string, baseline: number): Promise<number> {
  for (let i = 0; i < 12; i++) {
    const c = await logoutCount(email);
    if (c > baseline) return c;
    await new Promise((r) => setTimeout(r, 250));
  }
  return await logoutCount(email);
}

beforeAll(async () => {
  admin = await adminSession();
});

describe("Audit de la déconnexion (Audit Log — LOGOUT)", () => {
  it("POST /api/auth/signout écrit une entrée AccessLog action=LOGOUT", async () => {
    const before = await logoutCount(ADMIN_EMAIL);

    const csrfRes = await admin.fetch("/api/auth/csrf");
    const { csrfToken } = (await csrfRes.json()) as { csrfToken: string };
    const res = await admin.fetch("/api/auth/signout", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrfToken }).toString(),
    });
    expect([200, 302]).toContain(res.status);

    const after = await waitLogoutCountAbove(ADMIN_EMAIL, before);
    expect(after).toBeGreaterThan(before);
  });
});
