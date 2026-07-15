// Test idempotence d'un PATCH (changement de rôle membre).
//
// Couvre proposal Qualité & Robustesse #5 — appeler deux fois la même
// modification PUT/PATCH sans effet double.
//
// PATCH /api/orgs/[slug]/members/[userId] { role } répété avec la même valeur
// doit rester 200 et laisser l'état stable (rôle inchangé, pas de duplication
// de la ligne OrgMember).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  Session,
  adminSession,
  patchJson,
  BASE_URL,
  ADMIN_EMAIL,
  TENANT_SCHEMA,
  TENANT_HOST,
} from "./helpers/api";
import { execSql } from "./helpers/db";
import { provisionOrg, seedInvitation } from "./helpers/org";

const SUFFIX = `${Date.now()}`;
const BOB_EMAIL = `bob-idem-${SUFFIX}@test.local`;
const BOB_PASSWORD = "bobtestpassword12";
const ORG_SLUG = `idem-${SUFFIX}`;

let admin: Session;
let orgId = "";
let adminUserId = "";
let bobUserId = "";

async function roleOf(userId: string): Promise<string> {
  return (
    await execSql(
      `SELECT role FROM "${TENANT_SCHEMA}"."OrgMember"
       WHERE "userId" = '${userId}' AND "organizationId" = '${orgId}'`,
    )
  ).trim();
}

async function memberRowCount(userId: string): Promise<string> {
  return (
    await execSql(
      `SELECT COUNT(*) FROM "${TENANT_SCHEMA}"."OrgMember"
       WHERE "userId" = '${userId}' AND "organizationId" = '${orgId}'`,
    )
  ).trim();
}

beforeAll(async () => {
  admin = await adminSession();
  adminUserId = (
    await execSql(`SELECT id FROM "${TENANT_SCHEMA}"."User" WHERE email = '${ADMIN_EMAIL}'`)
  ).trim();
  if (!adminUserId) throw new Error("Admin user not found");

  orgId = await provisionOrg(ORG_SLUG, adminUserId);
  const token = await seedInvitation(orgId, BOB_EMAIL, "MEMBER", adminUserId);
  const res = await fetch(
    `${BASE_URL}/api/invitations/${token}/register-and-accept`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-host": TENANT_HOST,
        "x-forwarded-for": "203.0.113.202",
      },
      body: JSON.stringify({ password: BOB_PASSWORD }),
    },
  );
  if (!res.ok) throw new Error(`register-and-accept failed: HTTP ${res.status}`);
  bobUserId = (
    await execSql(`SELECT id FROM "${TENANT_SCHEMA}"."User" WHERE email = '${BOB_EMAIL}'`)
  ).trim();
});

afterAll(async () => {
  await execSql(`DELETE FROM "${TENANT_SCHEMA}"."User" WHERE email = '${BOB_EMAIL}'`);
  await execSql(`DELETE FROM "${TENANT_SCHEMA}"."Organization" WHERE slug = '${ORG_SLUG}'`);
});

describe("Idempotence PATCH (Qualité & Robustesse #5)", () => {
  it("Sanity : Bob démarre MEMBER (1 seule ligne)", async () => {
    expect(await roleOf(bobUserId)).toBe("MEMBER");
    expect(await memberRowCount(bobUserId)).toBe("1");
  });

  it("PATCH role=ADMIN deux fois → 200 à chaque fois, état identique", async () => {
    const first = await patchJson(
      admin,
      `/api/orgs/${ORG_SLUG}/members/${bobUserId}`,
      { role: "ADMIN" },
    );
    expect(first.status).toBe(200);
    expect(await roleOf(bobUserId)).toBe("ADMIN");

    const second = await patchJson(
      admin,
      `/api/orgs/${ORG_SLUG}/members/${bobUserId}`,
      { role: "ADMIN" },
    );
    expect(second.status).toBe(200);
    expect(await roleOf(bobUserId)).toBe("ADMIN"); // inchangé
    expect(await memberRowCount(bobUserId)).toBe("1"); // pas de duplication
  });

  it("PATCH avec le rôle déjà courant → 200 (no-op), état stable", async () => {
    const res = await patchJson(
      admin,
      `/api/orgs/${ORG_SLUG}/members/${bobUserId}`,
      { role: "ADMIN" },
    );
    expect(res.status).toBe(200);
    expect(await roleOf(bobUserId)).toBe("ADMIN");
    expect(await memberRowCount(bobUserId)).toBe("1");
  });
});
