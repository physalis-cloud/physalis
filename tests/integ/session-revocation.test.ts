// §2.9 — `User.sessionsValidFrom` (posé au reset de mot de passe et à la
// désactivation de la 2FA) n'était appliqué QUE dans `requireUser` : toutes les
// surfaces consommant `auth()` en direct (famille /api/billing, /api/account/*,
// pages du dashboard) laissaient vivre une session pourtant révoquée.
//
// Le check a été CENTRALISÉ dans le callback `jwt` de lib/auth.ts, et retiré de
// `requireUser`. Ce test est donc la garantie que la centralisation fonctionne :
// si le callback ne faisait pas son travail, l'API répondrait encore 200 —
// puisque `requireUser` ne vérifie plus rien lui-même.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes, createHash } from "node:crypto";
import bcrypt from "bcryptjs";
import {
  Session,
  adminSession,
  loginAs,
  BASE_URL,
  TENANT_SCHEMA,
  TENANT_HOST,
} from "./helpers/api";
import { execSql } from "./helpers/db";

const SUFFIX = `${Date.now()}`;
const ORG_SLUG = `revoc-org-${SUFFIX}`;
const USER_EMAIL = `revoc-${SUFFIX}@test.local`;
const USER_PASSWORD = "revocationtestpass12";

let victim: Session;
let orgId = "";
let userId = "";

const cuid = () => "ck" + randomBytes(11).toString("hex");

/** Simule un reset de mot de passe / 2FA-disable : pose la borne à maintenant. */
async function revokeSessions() {
  await execSql(
    `UPDATE "${TENANT_SCHEMA}"."User" SET "sessionsValidFrom" = NOW() WHERE id = '${userId}'`,
  );
}

beforeAll(async () => {
  await adminSession(); // vérifie que la stack répond
  const adminUserId = (
    await execSql(
      `SELECT id FROM "${TENANT_SCHEMA}"."User" ORDER BY "createdAt" ASC LIMIT 1`,
    )
  ).trim();

  orgId = cuid();
  await execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."Organization" (id, name, slug, "createdAt")
     VALUES ('${orgId}', '${ORG_SLUG}', '${ORG_SLUG}', NOW())`,
  );
  await execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."OrgMember" (id, "userId", "organizationId", role, "createdAt")
     VALUES ('${cuid()}', '${adminUserId}', '${orgId}', 'OWNER', NOW())`,
  );

  // Victime : compte avec mot de passe, membre de l'org, sans 2FA.
  userId = cuid();
  const hash = await bcrypt.hash(USER_PASSWORD, 10);
  await execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."User" (id, email, password, role, "createdAt")
     VALUES ('${userId}', '${USER_EMAIL}', '${hash}', 'MEMBER', NOW())`,
  );
  await execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."OrgMember" (id, "userId", "organizationId", role, "createdAt")
     VALUES ('${cuid()}', '${userId}', '${orgId}', 'MEMBER', NOW())`,
  );

  victim = await loginAs(USER_EMAIL, USER_PASSWORD);
});

afterAll(async () => {
  const S = TENANT_SCHEMA;
  await execSql(`DELETE FROM "${S}"."OrgMember" WHERE "organizationId" = '${orgId}'`).catch(() => {});
  await execSql(`DELETE FROM "${S}"."Organization" WHERE id = '${orgId}'`).catch(() => {});
  await execSql(`DELETE FROM "${S}"."User" WHERE id = '${userId}'`).catch(() => {});
});

describe("§2.9 — révocation de session centralisée", () => {
  it("sanity : la session fraîche accède à une route requireUser", async () => {
    const res = await victim.fetch("/api/orgs");
    expect(res.status).toBe(200);
  });

  it("après pose de sessionsValidFrom, la MÊME session est refusée (401)", async () => {
    await revokeSessions();
    const res = await victim.fetch("/api/orgs");
    // C'est LA preuve de la centralisation : `requireUser` ne vérifie plus la
    // borne lui-même — seul le callback `jwt` peut produire ce 401.
    expect(res.status).toBe(401);
  });

  it("une route qui n'utilise PAS requireUser est aussi couverte", async () => {
    // /api/billing/* s'authentifie via auth() en direct : c'était précisément la
    // famille qui échappait à la borne avant la centralisation.
    const res = await victim.fetch("/api/billing/portal", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("une session neuve refonctionne après la révocation (pas de blocage définitif)", async () => {
    // Le reset coupe les sessions ANTÉRIEURES ; se reconnecter doit remarcher.
    const fresh = await loginAs(USER_EMAIL, USER_PASSWORD);
    const res = await fresh.fetch("/api/orgs");
    expect(res.status).toBe(200);
  });
});
