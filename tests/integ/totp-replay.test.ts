// §2.17 — anti-rejeu TOTP end-to-end sur POST /api/plugin/auth (surface d'exploit
// du finding : un code TOTP capturé rejoué en curl → bearer sv_plugin_* de 8 h).
//
// Scénario : on active la 2FA sur le compte admin (via setup+verify), on remet la
// base anti-rejeu (lastTotpTimeStep) à 1 pour qu'un code courant passe une 1re fois,
// puis on POST /api/plugin/auth DEUX fois avec LE MÊME code. Attendu : 1er = 200
// (bearer), 2e = 401 (rejeu bloqué par afterTimeStep + le CAS atomique).
//
// checkPluginOrigin accepte l'absence d'en-tête Origin (Chrome le strippe pour les
// fetch sans preflight) → on POST sans Origin, comme le ferait un curl d'attaquant.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { generate } from "otplib";
import {
  Session,
  adminSession,
  postJson,
  BASE_URL,
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  TENANT_SLUG,
  TENANT_SCHEMA,
} from "./helpers/api";
import { execSql } from "./helpers/db";

let admin: Session;
let secret = "";

function pluginAuth(totp: string): Promise<Response> {
  // Pas d'en-tête Origin (cas curl / Chrome strippé) + pas de cookie de session.
  return fetch(`${BASE_URL}/api/plugin/auth`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
      totp,
      tenantSlug: TENANT_SLUG,
    }),
  });
}

beforeAll(async () => {
  admin = await adminSession();

  // 1) Setup 2FA → récupère le secret en clair.
  const setup = await postJson(admin, "/api/me/2fa/setup", {});
  expect(setup.status).toBe(200);
  secret = ((await setup.json()) as { secret: string }).secret;

  // 2) Active la 2FA avec un premier code.
  const verify = await postJson(admin, "/api/me/2fa/verify", {
    code: await generate({ secret }),
  });
  expect(verify.status).toBe(200);

  // 3) Remet la base anti-rejeu à 1 : un code courant (timeStep ~5.9e7 >> 1) passera
  //    la 1re fois, sans dépendre du pas consommé à l'activation (évite d'attendre
  //    le prochain créneau de 30 s).
  await execSql(
    `UPDATE "${TENANT_SCHEMA}"."User" SET "lastTotpTimeStep" = 1 WHERE email = '${ADMIN_EMAIL}'`,
  );
});

afterAll(async () => {
  // Purge les PluginToken créés + désactive la 2FA de l'admin jetable.
  await execSql(
    `DELETE FROM "${TENANT_SCHEMA}"."PluginToken" WHERE "userId" IN (SELECT id FROM "${TENANT_SCHEMA}"."User" WHERE email = '${ADMIN_EMAIL}')`,
  ).catch(() => {});
  await execSql(
    `UPDATE "${TENANT_SCHEMA}"."User" SET "twoFactorEnabled" = false, "twoFactorSecret" = NULL, "twoFactorIv" = NULL, "twoFactorTag" = NULL, "backupCodes" = '{}', "lastTotpTimeStep" = NULL WHERE email = '${ADMIN_EMAIL}'`,
  ).catch(() => {});
});

describe("§2.17 — un code TOTP n'est utilisable qu'UNE fois (plugin/auth)", () => {
  it("1er usage accepté (200), rejeu du MÊME code refusé (401)", async () => {
    const code = await generate({ secret });

    const first = await pluginAuth(code);
    expect(first.status).toBe(200);

    // Rejeu immédiat du même code : bloqué par l'anti-rejeu (afterTimeStep).
    const replay = await pluginAuth(code);
    expect(replay.status).toBe(401);
  });
});
