// §2.19 — La portée d'un OrgToken de niveau DEV (projets ⊆ memberships non
// masqués) n'est validée QU'À l'émission. Un DEV offboardé — ou masqué d'un
// projet — gardait jusqu'à 90 j un `sv_org_*` lisant les secrets de prod, car
// validateIntegrationToken ne teste que revokedAt/expiresAt.
//
// Fix : à l'offboarding (retrait d'org) et au masquage projet, on révoque les
// OrgToken de FORME DEV (allProjects=false + expiration) créés par la cible —
// sans toucher les tokens INSTITUTIONNELS (allProjects ou sans expiration),
// dont la survie au départ du créateur est le différenciateur voulu.
//
// Cellules de la matrice de révocation (§4bis) : org_token × project_hidden et
// org_token × org_member_removal.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes, createHash } from "node:crypto";
import {
  adminSession,
  patchJson,
  BASE_URL,
  ADMIN_EMAIL,
  TENANT_SLUG,
  TENANT_SCHEMA,
} from "./helpers/api";
import { execSql } from "./helpers/db";

const SUFFIX = `${Date.now()}`;
const ORG_SLUG = `oto-org-${SUFFIX}`;
const PROJ_P = `oto-p-${SUFFIX}`;
const PROJ_Q = `oto-q-${SUFFIX}`;
const BOB_EMAIL = `bob-oto-${SUFFIX}@test.local`;

const cuid = () => "ck" + randomBytes(11).toString("hex");
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

// 3 tokens de Bob : DEV scopé à P, DEV scopé à Q, et un institutionnel.
const T_DEV_P = "sv_org_" + randomBytes(32).toString("hex");
const T_DEV_Q = "sv_org_" + randomBytes(32).toString("hex");
const T_INST = "sv_org_" + randomBytes(32).toString("hex");

let admin: Awaited<ReturnType<typeof adminSession>>;
let adminUserId = "";
let bobUserId = "";
let orgId = "";
let projPId = "";
let projQId = "";

/** Seede un OrgToken (ligne tenant + entrée admin.token_index kind ORG). */
async function seedOrgToken(opts: {
  raw: string;
  allProjects: boolean;
  allowedProjectIds: string[];
  hasExpiry: boolean;
}): Promise<void> {
  const hash = sha256(opts.raw);
  const arr = opts.allowedProjectIds.length
    ? `ARRAY['${opts.allowedProjectIds.join("','")}']::text[]`
    : `ARRAY[]::text[]`;
  const exp = opts.hasExpiry ? `NOW() + interval '30 days'` : `NULL`;
  await execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."OrgToken"
       (id, "organizationId", name, "tokenHash", prefix, "allProjects",
        "allowedProjectIds", "allowedScopes", "expiresAt", "createdById", "createdAt")
     VALUES ('${cuid()}', '${orgId}', 'tok', '${hash}', '${opts.raw.slice(0, 12)}',
        ${opts.allProjects}, ${arr}, ARRAY['SECRETS_READ']::"${TENANT_SCHEMA}"."OrgTokenScope"[],
        ${exp}, '${bobUserId}', NOW())`,
  );
  await execSql(
    `INSERT INTO admin.token_index (token_hash, tenant_slug, kind, created_at)
     VALUES ('${hash}', '${TENANT_SLUG}', 'ORG', NOW())`,
  );
}

/** true si le token porte un revokedAt en base. */
async function isRevoked(raw: string): Promise<boolean> {
  const r = await execSql(
    `SELECT ("revokedAt" IS NOT NULL) FROM "${TENANT_SCHEMA}"."OrgToken" WHERE "tokenHash" = '${sha256(raw)}'`,
  );
  return r.trim() === "t";
}

function credsFetch(raw: string, projectSlug: string): Promise<Response> {
  return fetch(
    `${BASE_URL}/api/integrations/credentials?project=${projectSlug}&env=production&type=secret`,
    { headers: { authorization: `Bearer ${raw}` } },
  );
}

beforeAll(async () => {
  admin = await adminSession();
  adminUserId = (
    await execSql(`SELECT id FROM "${TENANT_SCHEMA}"."User" WHERE email = '${ADMIN_EMAIL}'`)
  ).trim();

  orgId = cuid();
  await execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."Organization" (id, name, slug, "createdAt")
     VALUES ('${orgId}', '${ORG_SLUG}', '${ORG_SLUG}', NOW())`,
  );
  // Admin OWNER (autorise le DELETE membre + le PATCH masquage).
  await execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."OrgMember" (id, "userId", "organizationId", role, "createdAt")
     VALUES ('${cuid()}', '${adminUserId}', '${orgId}', 'OWNER', NOW())`,
  );
  // Bob OrgDEV.
  bobUserId = cuid();
  await execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."User" (id, email, "createdAt") VALUES ('${bobUserId}', '${BOB_EMAIL}', NOW())`,
  );
  await execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."OrgMember" (id, "userId", "organizationId", role, "createdAt")
     VALUES ('${cuid()}', '${bobUserId}', '${orgId}', 'DEV', NOW())`,
  );

  projPId = cuid();
  projQId = cuid();
  for (const [id, slug] of [[projPId, PROJ_P], [projQId, PROJ_Q]] as const) {
    await execSql(
      `INSERT INTO "${TENANT_SCHEMA}"."Project" (id, name, slug, "organizationId", "createdAt")
       VALUES ('${id}', '${slug}', '${slug}', '${orgId}', NOW())`,
    );
    await execSql(
      `INSERT INTO "${TENANT_SCHEMA}"."Environment" (id, name, "projectId")
       VALUES ('${cuid()}', 'production', '${id}')`,
    );
    // Bob ProjectMember EDITOR non masqué (pour pouvoir le masquer ensuite).
    await execSql(
      `INSERT INTO "${TENANT_SCHEMA}"."ProjectMember" (id, "userId", "projectId", role, hidden)
       VALUES ('${cuid()}', '${bobUserId}', '${id}', 'EDITOR', false)`,
    );
  }

  await seedOrgToken({ raw: T_DEV_P, allProjects: false, allowedProjectIds: [projPId], hasExpiry: true });
  await seedOrgToken({ raw: T_DEV_Q, allProjects: false, allowedProjectIds: [projQId], hasExpiry: true });
  // Institutionnel : allProjects + sans expiration.
  await seedOrgToken({ raw: T_INST, allProjects: true, allowedProjectIds: [], hasExpiry: false });
});

afterAll(async () => {
  const S = TENANT_SCHEMA;
  for (const t of [T_DEV_P, T_DEV_Q, T_INST]) {
    await execSql(`DELETE FROM admin.token_index WHERE token_hash = '${sha256(t)}'`).catch(() => {});
  }
  await execSql(`DELETE FROM "${S}"."OrgToken" WHERE "organizationId" = '${orgId}'`).catch(() => {});
  await execSql(`DELETE FROM "${S}"."ProjectMember" WHERE "userId" = '${bobUserId}'`).catch(() => {});
  await execSql(`DELETE FROM "${S}"."Environment" WHERE "projectId" IN ('${projPId}','${projQId}')`).catch(() => {});
  await execSql(`DELETE FROM "${S}"."Project" WHERE "organizationId" = '${orgId}'`).catch(() => {});
  await execSql(`DELETE FROM "${S}"."OrgMember" WHERE "organizationId" = '${orgId}'`).catch(() => {});
  await execSql(`DELETE FROM "${S}"."Organization" WHERE id = '${orgId}'`).catch(() => {});
  await execSql(`DELETE FROM "${S}"."User" WHERE id = '${bobUserId}'`).catch(() => {});
});

describe("§2.19 — révocation des OrgToken DEV à la perte d'accès", () => {
  // Séquentiel : masquage d'abord (Bob reste membre), offboard ensuite.
  it("sanity : le token DEV scopé à P lit les credentials (pas 401)", async () => {
    const res = await credsFetch(T_DEV_P, PROJ_P);
    expect(res.status).not.toBe(401);
  });

  it("masquer Bob de P → son token DEV scopé à P est refusé (401) end-to-end", async () => {
    const res = await patchJson(admin, `/api/projects/${PROJ_P}/members/${bobUserId}`, { hidden: true });
    expect(res.status).toBe(200);
    const used = await credsFetch(T_DEV_P, PROJ_P);
    expect(used.status).toBe(401);
    expect(await isRevoked(T_DEV_P)).toBe(true);
  });

  it("le token DEV scopé à Q (autre projet) survit au masquage de P", async () => {
    expect(await isRevoked(T_DEV_Q)).toBe(false);
  });

  it("le token institutionnel (allProjects, sans expiration) survit au masquage", async () => {
    expect(await isRevoked(T_INST)).toBe(false);
  });

  it("offboarder Bob (retrait d'org) → son token DEV restant (Q) est révoqué", async () => {
    const res = await admin.fetch(`/api/orgs/${ORG_SLUG}/members/${bobUserId}`, { method: "DELETE" });
    expect([200, 204]).toContain(res.status);
    expect(await isRevoked(T_DEV_Q)).toBe(true);
  });

  it("le token institutionnel survit à l'offboarding (différenciateur voulu)", async () => {
    expect(await isRevoked(T_INST)).toBe(false);
  });
});
