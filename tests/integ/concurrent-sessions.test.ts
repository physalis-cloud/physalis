// Test d'intégration : sessions concurrentes multi-appareils (Auth #7).
//
// Stratégie de session = JWT stateless (lib/auth.config.ts) : se connecter
// depuis un 2e appareil n'invalide PAS le 1er — les deux JWT coexistent et
// restent valides jusqu'à leur expiration (8h) ou une invalidation explicite.
// Ce test documente ce comportement attendu et vérifie le corollaire de
// sécurité : une révocation globale (bump `sessionsValidFrom`, posé au reset
// password / 2FA disable) coupe TOUS les appareils d'un coup, pas seulement
// celui qui a déclenché l'action.
//
// Pré-requis : stack live + migration session_invalidation (auto-apply boot).
// Deux `Session` avec des IP simulées distinctes = deux « appareils ».
// Sonde : GET /api/me/2fa (route authentifiée via requireUser).

import { describe, it, expect, afterAll } from "vitest";
import {
  loginAs,
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  TENANT_SCHEMA,
} from "./helpers/api";
import { execSql } from "./helpers/db";

const PROBE = "/api/me/2fa";

async function setValidFrom(value: string): Promise<void> {
  await execSql(
    `UPDATE ${TENANT_SCHEMA}."User" SET "sessionsValidFrom" = ${value} WHERE email = '${ADMIN_EMAIL}'`,
  );
}

// L'état partagé (admin) doit repartir propre pour les autres suites.
afterAll(async () => {
  await setValidFrom("NULL");
});

describe("Auth #7 — sessions concurrentes (multi-appareils)", () => {
  it("deux appareils connectés simultanément → les deux accèdent (200)", async () => {
    const deviceA = await loginAs(ADMIN_EMAIL, ADMIN_PASSWORD, "203.0.113.41");
    const deviceB = await loginAs(ADMIN_EMAIL, ADMIN_PASSWORD, "203.0.113.42");

    // Le login B n'a pas évincé A : les deux JWT sont indépendants.
    expect((await deviceA.fetch(PROBE)).status).toBe(200);
    expect((await deviceB.fetch(PROBE)).status).toBe(200);
  });

  it("révocation globale (sessionsValidFrom) → coupe TOUS les appareils", async () => {
    const deviceA = await loginAs(ADMIN_EMAIL, ADMIN_PASSWORD, "203.0.113.43");
    const deviceB = await loginAs(ADMIN_EMAIL, ADMIN_PASSWORD, "203.0.113.44");
    expect((await deviceA.fetch(PROBE)).status).toBe(200);
    expect((await deviceB.fetch(PROBE)).status).toBe(200);

    // Reset password / 2FA disable sur un appareil → invalide la borne.
    await setValidFrom("NOW()");

    expect((await deviceA.fetch(PROBE)).status).toBe(401);
    expect((await deviceB.fetch(PROBE)).status).toBe(401);
  });

  it("après révocation, une reconnexion rétablit l'accès (nouveau JWT)", async () => {
    await setValidFrom("NOW()");
    await new Promise((r) => setTimeout(r, 1100)); // loginAt > borne (précision ms)

    const device = await loginAs(ADMIN_EMAIL, ADMIN_PASSWORD, "203.0.113.45");
    expect((await device.fetch(PROBE)).status).toBe(200);
  });
});
