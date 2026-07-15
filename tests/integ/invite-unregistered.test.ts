// Test invitation d'un email NON ENREGISTRÉ → flux de création de compte.
//
// Couvre proposal Orgs & Users #4 — inviter quelqu'un sans compte, vérifier
// le flow de création.
//
// 1. L'API d'invitation (POST /api/orgs/[slug]/members) crée une Invitation
//    pending pour un email sans compte (inviteeUserId/acceptedAt null), sans
//    créer de User. Ré-inviter le même email → 409 (conflit pending).
// 2. register-and-accept crée le compte + la membership avec le rôle invité.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  Session,
  adminSession,
  postJson,
  BASE_URL,
  ADMIN_EMAIL,
  TENANT_SCHEMA,
  TENANT_HOST,
} from "./helpers/api";
import { execSql } from "./helpers/db";
import { provisionOrg, seedInvitation } from "./helpers/org";

const SUFFIX = `${Date.now()}`;
const NEW_API = `unreg-api-${SUFFIX}@test.local`; // invité via l'API (pending)
const NEW_FLOW = `unreg-flow-${SUFFIX}@test.local`; // invité + register-and-accept
const NEW_PASSWORD = "newusertestpw123";
const ORG_SLUG = `unreg-${SUFFIX}`;

let admin: Session;
let orgId = "";
let adminUserId = "";

async function userExists(email: string): Promise<boolean> {
  const c = await execSql(
    `SELECT COUNT(*) FROM "${TENANT_SCHEMA}"."User" WHERE email = '${email}'`,
  );
  return c.trim() === "1";
}

beforeAll(async () => {
  admin = await adminSession();
  adminUserId = (
    await execSql(`SELECT id FROM "${TENANT_SCHEMA}"."User" WHERE email = '${ADMIN_EMAIL}'`)
  ).trim();
  if (!adminUserId) throw new Error("Admin user not found");
  orgId = await provisionOrg(ORG_SLUG, adminUserId);
});

afterAll(async () => {
  await execSql(
    `DELETE FROM "${TENANT_SCHEMA}"."User" WHERE email IN ('${NEW_API}', '${NEW_FLOW}')`,
  );
  await execSql(`DELETE FROM "${TENANT_SCHEMA}"."Organization" WHERE slug = '${ORG_SLUG}'`);
});

describe("Invitation d'un email non enregistré (Orgs & Users #4)", () => {
  it("Sanity : aucun compte n'existe pour ces emails", async () => {
    expect(await userExists(NEW_API)).toBe(false);
    expect(await userExists(NEW_FLOW)).toBe(false);
  });

  it("POST /members {email non enregistré} → 201 + Invitation pending, sans créer de User", async () => {
    const res = await postJson(admin, `/api/orgs/${ORG_SLUG}/members`, {
      email: NEW_API,
      role: "DEV",
    });
    expect(res.status).toBe(201);

    // Invitation email-based : pending, pas in-app, pas encore acceptée.
    const row = await execSql(
      `SELECT role, "inviteeUserId" IS NULL, "acceptedAt" IS NULL
       FROM "${TENANT_SCHEMA}"."Invitation"
       WHERE email = '${NEW_API}' AND "organizationId" = '${orgId}'`,
    );
    expect(row.trim()).toBe("DEV|t|t");

    // Toujours aucun compte créé tant que l'invité n'a pas accepté.
    expect(await userExists(NEW_API)).toBe(false);
  });

  it("Ré-inviter le même email → 409 (invitation déjà pending)", async () => {
    const res = await postJson(admin, `/api/orgs/${ORG_SLUG}/members`, {
      email: NEW_API,
      role: "DEV",
    });
    expect(res.status).toBe(409);
  });

  it("register-and-accept crée le compte + la membership avec le rôle invité", async () => {
    const token = await seedInvitation(orgId, NEW_FLOW, "DEV", adminUserId);
    expect(await userExists(NEW_FLOW)).toBe(false);

    const res = await fetch(
      `${BASE_URL}/api/invitations/${token}/register-and-accept`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-host": TENANT_HOST,
          "x-forwarded-for": "203.0.113.201",
        },
        body: JSON.stringify({ password: NEW_PASSWORD }),
      },
    );
    expect(res.ok).toBe(true);

    // Compte créé.
    expect(await userExists(NEW_FLOW)).toBe(true);

    // Membership dans l'org invitante, avec le rôle de l'invitation (DEV).
    const memberRole = await execSql(
      `SELECT m.role FROM "${TENANT_SCHEMA}"."OrgMember" m
       JOIN "${TENANT_SCHEMA}"."User" u ON u.id = m."userId"
       WHERE u.email = '${NEW_FLOW}' AND m."organizationId" = '${orgId}'`,
    );
    expect(memberRole.trim()).toBe("DEV");
  });
});
