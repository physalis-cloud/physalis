// Test changement de rôle d'un membre d'organisation.
//
// Couvre proposal Orgs & Users #5 — changement de rôle + audit.
//
// Route : PATCH /api/orgs/[slug]/members/[userId] { role }
//   - requireOrgMember(slug, "ADMIN") (un MEMBER ne peut pas)
//   - rôle ∈ {OWNER, ADMIN, ADMIN_DEV, DEV, MEMBER}, sinon 400
//   - seul un OWNER peut accorder OWNER, sinon 403
//   - interdiction de rétrograder le dernier OWNER (409)
//   - log AccessLog MEMBER_ROLE_CHANGE (fromRole/toRole)
//
// Scénario séquentiel (vitest integ = sequence.concurrent:false) :
//   admin = OWNER de orgA ; Bob = MEMBER de orgA.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import {
  Session,
  adminSession,
  loginAs,
  patchJson,
  BASE_URL,
  ADMIN_EMAIL,
  TENANT_SCHEMA,
  TENANT_HOST,
} from "./helpers/api";
import { execSql } from "./helpers/db";

const SUFFIX = `${Date.now()}`;
const BOB_EMAIL = `bob-role-${SUFFIX}@test.local`;
const BOB_PASSWORD = "bobtestpassword12";
const ORG_SLUG = `role-${SUFFIX}`;

let admin: Session;
let bob: Session;
let orgId = "";
let bobUserId = "";
let adminUserId = "";

async function provisionOrg(slug: string, ownerId: string): Promise<string> {
  const id = "ck" + randomBytes(11).toString("hex");
  await execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."Organization" (id, name, slug, "createdAt")
     VALUES ('${id}', '${slug}', '${slug}', NOW())`,
  );
  const memberId = "ck" + randomBytes(11).toString("hex");
  await execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."OrgMember" (id, "userId", "organizationId", role, "createdAt")
     VALUES ('${memberId}', '${ownerId}', '${id}', 'OWNER', NOW())`,
  );
  return id;
}

async function inviteBobAsMember(orgId: string, invitedById: string) {
  const token = "iv_" + randomBytes(32).toString("hex");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const id = "ck" + randomBytes(11).toString("hex");
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000)
    .toISOString()
    .replace("Z", "+00");
  await execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."Invitation" (id, email, "organizationId", role, "tokenHash", "expiresAt", "invitedById", "createdAt")
     VALUES ('${id}', '${BOB_EMAIL}', '${orgId}', 'MEMBER', '${tokenHash}', '${expiresAt}', '${invitedById}', NOW())`,
  );
  const res = await fetch(
    `${BASE_URL}/api/invitations/${token}/register-and-accept`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-host": TENANT_HOST,
        "x-forwarded-for": `203.0.113.${Math.floor(Math.random() * 254) + 1}`,
      },
      body: JSON.stringify({ password: BOB_PASSWORD }),
    },
  );
  if (!res.ok) {
    throw new Error(`register-and-accept failed: HTTP ${res.status}`);
  }
}

async function roleOf(userId: string): Promise<string> {
  return (
    await execSql(
      `SELECT role FROM "${TENANT_SCHEMA}"."OrgMember"
       WHERE "userId" = '${userId}' AND "organizationId" = '${orgId}'`,
    )
  ).trim();
}

/** Audit = fire-and-forget (logAction non-awaité) : on attend jusqu'à ~2s
 *  l'apparition de la ligne avant de conclure. */
async function auditCount(action: string, targetId: string): Promise<number> {
  for (let i = 0; i < 10; i++) {
    const c = (
      await execSql(
        `SELECT COUNT(*) FROM "${TENANT_SCHEMA}"."AccessLog"
         WHERE action = '${action}' AND "targetId" = '${targetId}'`,
      )
    ).trim();
    if (parseInt(c, 10) > 0) return parseInt(c, 10);
    await new Promise((r) => setTimeout(r, 200));
  }
  return 0;
}

beforeAll(async () => {
  admin = await adminSession();
  adminUserId = (
    await execSql(`SELECT id FROM "${TENANT_SCHEMA}"."User" WHERE email = '${ADMIN_EMAIL}'`)
  ).trim();
  if (!adminUserId) throw new Error("Admin user not found");

  orgId = await provisionOrg(ORG_SLUG, adminUserId);
  await inviteBobAsMember(orgId, adminUserId);
  bobUserId = (
    await execSql(`SELECT id FROM "${TENANT_SCHEMA}"."User" WHERE email = '${BOB_EMAIL}'`)
  ).trim();
  bob = await loginAs(BOB_EMAIL, BOB_PASSWORD);
});

afterAll(async () => {
  await execSql(`DELETE FROM "${TENANT_SCHEMA}"."User" WHERE email = '${BOB_EMAIL}'`);
  await execSql(`DELETE FROM "${TENANT_SCHEMA}"."Organization" WHERE slug = '${ORG_SLUG}'`);
});

describe("Changement de rôle d'un membre (Orgs & Users #5)", () => {
  // Tests séquentiels : l'ordre compte (vitest integ a sequence.concurrent:false).

  it("Sanity : Bob démarre MEMBER", async () => {
    expect(await roleOf(bobUserId)).toBe("MEMBER");
  });

  it("Un MEMBER ne peut pas changer de rôle (403/404)", async () => {
    const res = await patchJson(
      bob,
      `/api/orgs/${ORG_SLUG}/members/${adminUserId}`,
      { role: "MEMBER" },
    );
    expect([403, 404]).toContain(res.status);
    expect(await roleOf(adminUserId)).toBe("OWNER"); // inchangé
  });

  it("Admin (OWNER) promeut Bob MEMBER → ADMIN (200 + DB + audit)", async () => {
    const res = await patchJson(
      admin,
      `/api/orgs/${ORG_SLUG}/members/${bobUserId}`,
      { role: "ADMIN" },
    );
    expect(res.status).toBe(200);
    expect(await roleOf(bobUserId)).toBe("ADMIN");
    expect(await auditCount("MEMBER_ROLE_CHANGE", bobUserId)).toBeGreaterThan(0);
  });

  it("Rôle invalide → 400", async () => {
    const res = await patchJson(
      admin,
      `/api/orgs/${ORG_SLUG}/members/${bobUserId}`,
      { role: "SUPERBOSS" },
    );
    expect(res.status).toBe(400);
  });

  it("Un ADMIN non-OWNER ne peut pas accorder OWNER (403)", async () => {
    // Bob est désormais ADMIN ; il tente de se promouvoir OWNER.
    const res = await patchJson(
      bob,
      `/api/orgs/${ORG_SLUG}/members/${bobUserId}`,
      { role: "OWNER" },
    );
    expect(res.status).toBe(403);
    expect(await roleOf(bobUserId)).toBe("ADMIN"); // inchangé
  });

  it("Impossible de rétrograder le dernier OWNER (409)", async () => {
    // admin est le seul OWNER de orgA.
    const res = await patchJson(
      admin,
      `/api/orgs/${ORG_SLUG}/members/${adminUserId}`,
      { role: "ADMIN" },
    );
    expect(res.status).toBe(409);
    expect(await roleOf(adminUserId)).toBe("OWNER"); // inchangé
  });

  // ADMIN_DEV (rang 3) manquait de VALID_ROLES → 400 « Invalid role » sur TOUTE
  // tentative d'assignation, alors que l'UI le propose et que 8 endpoints le
  // gatent. Rôle mort. Assignable désormais (gate ADMIN, rang < ADMIN → sûr).
  it("Admin (OWNER) peut assigner ADMIN_DEV (etait inassignable)", async () => {
    // Bob est ADMIN à ce stade.
    const res = await patchJson(
      admin,
      `/api/orgs/${ORG_SLUG}/members/${bobUserId}`,
      { role: "ADMIN_DEV" },
    );
    expect(res.status).toBe(200);
    expect(await roleOf(bobUserId)).toBe("ADMIN_DEV");
  });
});
