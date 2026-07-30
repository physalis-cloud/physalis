// §2.20c — consommation des backup codes non atomique (read-modify-write :
// splice + réécriture du tableau complet). Deux logins concurrents avec des codes
// DIFFÉRENTS écrivaient chacun le tableau moins SON code → le dernier update
// gagnait, le code de l'autre restait valide. Fix : `array_remove` SQL atomique.
//
// Prouve aussi (implicitement) que le $executeRaw brut dans une tx tenant
// (getTenantPrisma ?schema) vise bien `client_test.User` : sinon les codes ne
// seraient pas consommés.

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
let backupCodes: string[] = [];

function pluginAuth(code: string): Promise<Response> {
  return fetch(`${BASE_URL}/api/plugin/auth`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: ADMIN_EMAIL,
      // Constante du helper (qui porte le repli), et NON
      // `process.env.TEST_ADMIN_PASSWORD` en direct : sans la variable
      // exportée, le mot de passe partait `undefined` → 400 au lieu de 200, et
      // le fichier échouait même isolément. Seul test du dépôt à contourner le
      // helper.
      password: ADMIN_PASSWORD,
      totp: code,
      tenantSlug: TENANT_SLUG,
    }),
  });
}

async function remainingBackupCount(): Promise<number> {
  const r = await execSql(
    `SELECT cardinality("backupCodes") FROM "${TENANT_SCHEMA}"."User" WHERE email = '${ADMIN_EMAIL}'`,
  );
  return Number(r.trim());
}

beforeAll(async () => {
  admin = await adminSession();
  const setup = await postJson(admin, "/api/me/2fa/setup", {});
  const { secret } = (await setup.json()) as { secret: string };
  const verify = await postJson(admin, "/api/me/2fa/verify", {
    code: await generate({ secret }),
  });
  expect(verify.status).toBe(200);
  backupCodes = ((await verify.json()) as { backupCodes: string[] }).backupCodes;
  expect(backupCodes.length).toBe(8);
});

afterAll(async () => {
  await execSql(
    `UPDATE "${TENANT_SCHEMA}"."User" SET "twoFactorEnabled"=false, "twoFactorSecret"=NULL, "twoFactorIv"=NULL, "twoFactorTag"=NULL, "backupCodes"='{}', "lastTotpTimeStep"=NULL WHERE email='${ADMIN_EMAIL}'`,
  ).catch(() => {});
  await execSql(
    `DELETE FROM "${TENANT_SCHEMA}"."PluginToken" WHERE "userId" IN (SELECT id FROM "${TENANT_SCHEMA}"."User" WHERE email='${ADMIN_EMAIL}')`,
  ).catch(() => {});
});

describe("§2.20c — consommation atomique des backup codes", () => {
  it("deux logins concurrents avec des codes DIFFÉRENTS consomment BIEN les deux", async () => {
    expect(await remainingBackupCount()).toBe(8);

    // Rafale concurrente : deux codes distincts en même temps.
    const [r0, r1] = await Promise.all([
      pluginAuth(backupCodes[0]!),
      pluginAuth(backupCodes[1]!),
    ]);
    expect(r0.status).toBe(200);
    expect(r1.status).toBe(200);

    // Coeur du fix : les DEUX codes sont consommés (8 → 6). Avec le
    // read-modify-write, l'un des deux survivait (compte = 7). Prouve aussi que
    // l'UPDATE brut a visé client_test.User (sinon compte resté à 8).
    expect(await remainingBackupCount()).toBe(6);
  });

  it("rejouer un code déjà consommé échoue (401)", async () => {
    const res = await pluginAuth(backupCodes[0]!);
    expect(res.status).toBe(401);
  });
});
