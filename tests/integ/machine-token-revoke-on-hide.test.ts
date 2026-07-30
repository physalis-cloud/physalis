// §2.15 — Masquer un membre (`hidden = true`) EST le geste de retrait d'accès
// projet : il n'existe pas de DELETE sur ProjectMember. Le retrait d'ORG révoque
// déjà les MachineTokens du partant (§2.7) ; le masquage projet, lui, ne touchait
// AUCUN token. Or `validateToken` ne teste que `revokedAt`, jamais l'appartenance
// du créateur → un `curl -H 'Authorization: Bearer sv_…' /api/secrets/<proj>/<env>`
// continuait de lire les secrets alors que toutes les surfaces web renvoyaient 403.
//
// Fix : le PATCH members/[userId] révoque, quand `hidden` passe à true, les
// MachineTokens que la cible a créés sur CE projet. Révocation PERMANENTE.
//
// Scénario :
//   1. Alice (OrgMEMBER, ProjectMember EDITOR NON masquée) a émis un MachineToken.
//   2. Sanity : le token lit les secrets (200). Un token de l'admin aussi.
//   3. L'admin masque Alice (PATCH hidden=true).
//   4. Le token d'Alice → 401 (révoqué) ; sa ligne MachineToken porte revokedAt.
//   5. Le token de l'admin → toujours 200 (révocation scopée au créateur masqué).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes, createHash } from "node:crypto";
import {
  Session,
  adminSession,
  patchJson,
  BASE_URL,
  ADMIN_EMAIL,
  TENANT_SLUG,
  TENANT_SCHEMA,
} from "./helpers/api";
import { execSql } from "./helpers/db";

const SUFFIX = `${Date.now()}`;
const ORG_SLUG = `mtrh-org-${SUFFIX}`;
const PROJECT_SLUG = `mtrh-proj-${SUFFIX}`;
const ALICE_EMAIL = `alice-mtrh-${SUFFIX}@test.local`;
const ENV_NAME = "production";

const cuid = () => "ck" + randomBytes(11).toString("hex");
const rawToken = () => "sv_" + randomBytes(32).toString("hex");
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

// Token brut d'Alice (celui qui doit mourir) et de l'admin (témoin, doit vivre).
const ALICE_TOKEN = rawToken();
const ADMIN_TOKEN = rawToken();

let admin: Session;
let adminUserId = "";
let aliceUserId = "";
let orgId = "";
let projectId = "";
let envId = "";
let aliceTokenId = "";

/** Émet un MachineToken (ligne tenant + entrée admin.token_index) pour `creatorId`. */
async function seedMachineToken(
  creatorId: string,
  raw: string,
  name: string,
): Promise<string> {
  const id = cuid();
  const hash = sha256(raw);
  await execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."MachineToken"
       (id, name, "tokenHash", "projectId", "environmentId", "createdById", "createdAt")
     VALUES ('${id}', '${name}', '${hash}', '${projectId}', '${envId}', '${creatorId}', NOW())`,
  );
  await execSql(
    `INSERT INTO admin.token_index (token_hash, tenant_slug, kind, created_at)
     VALUES ('${hash}', '${TENANT_SLUG}', 'MACHINE', NOW())`,
  );
  return id;
}

function fetchSecrets(raw: string): Promise<Response> {
  return fetch(`${BASE_URL}/api/secrets/${PROJECT_SLUG}/${ENV_NAME}`, {
    headers: { authorization: `Bearer ${raw}` },
  });
}

beforeAll(async () => {
  admin = await adminSession();
  adminUserId = (
    await execSql(`SELECT id FROM "${TENANT_SCHEMA}"."User" WHERE email = '${ADMIN_EMAIL}'`)
  ).trim();
  if (!adminUserId) throw new Error("Admin user not found");

  // Org avec l'admin en OWNER (→ OWNER implicite sur le projet, autorise le PATCH).
  orgId = cuid();
  await execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."Organization" (id, name, slug, "createdAt")
     VALUES ('${orgId}', '${ORG_SLUG}', '${ORG_SLUG}', NOW())`,
  );
  await execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."OrgMember" (id, "userId", "organizationId", role, "createdAt")
     VALUES ('${cuid()}', '${adminUserId}', '${orgId}', 'OWNER', NOW())`,
  );

  // Alice : OrgMEMBER, sans privilège transversal (son accès projet vient de la
  // seule ligne ProjectMember → `hidden` la coupe vraiment).
  aliceUserId = cuid();
  await execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."User" (id, email, "createdAt")
     VALUES ('${aliceUserId}', '${ALICE_EMAIL}', NOW())`,
  );
  await execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."OrgMember" (id, "userId", "organizationId", role, "createdAt")
     VALUES ('${cuid()}', '${aliceUserId}', '${orgId}', 'MEMBER', NOW())`,
  );

  projectId = cuid();
  await execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."Project" (id, name, slug, "organizationId", "createdAt")
     VALUES ('${projectId}', '${PROJECT_SLUG}', '${PROJECT_SLUG}', '${orgId}', NOW())`,
  );
  envId = cuid();
  await execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."Environment" (id, name, "projectId")
     VALUES ('${envId}', '${ENV_NAME}', '${projectId}')`,
  );
  // Alice EDITOR NON masquée : elle a un accès projet réel au moment de l'émission.
  await execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."ProjectMember" (id, "userId", "projectId", role, hidden)
     VALUES ('${cuid()}', '${aliceUserId}', '${projectId}', 'EDITOR', false)`,
  );

  aliceTokenId = await seedMachineToken(aliceUserId, ALICE_TOKEN, `alice-${SUFFIX}`);
  await seedMachineToken(adminUserId, ADMIN_TOKEN, `admin-${SUFFIX}`);
});

afterAll(async () => {
  const S = TENANT_SCHEMA;
  await execSql(`DELETE FROM admin.token_index WHERE token_hash IN ('${sha256(ALICE_TOKEN)}', '${sha256(ADMIN_TOKEN)}')`).catch(() => {});
  await execSql(`DELETE FROM "${S}"."MachineToken" WHERE "projectId" = '${projectId}'`).catch(() => {});
  await execSql(`DELETE FROM "${S}"."Environment" WHERE "projectId" = '${projectId}'`).catch(() => {});
  await execSql(`DELETE FROM "${S}"."ProjectMember" WHERE "projectId" = '${projectId}'`).catch(() => {});
  await execSql(`DELETE FROM "${S}"."Project" WHERE id = '${projectId}'`).catch(() => {});
  await execSql(`DELETE FROM "${S}"."OrgMember" WHERE "organizationId" = '${orgId}'`).catch(() => {});
  await execSql(`DELETE FROM "${S}"."Organization" WHERE id = '${orgId}'`).catch(() => {});
  await execSql(`DELETE FROM "${S}"."User" WHERE id = '${aliceUserId}'`).catch(() => {});
});

describe("§2.15 — masquer un membre révoque ses MachineTokens", () => {
  // Séquentiel : le PATCH du milieu conditionne les assertions suivantes.
  it("sanity : avant masquage, le token d'Alice lit les secrets (200)", async () => {
    const res = await fetchSecrets(ALICE_TOKEN);
    expect(res.status).toBe(200);
  });

  it("sanity : le token de l'admin lit aussi les secrets (200)", async () => {
    const res = await fetchSecrets(ADMIN_TOKEN);
    expect(res.status).toBe(200);
  });

  it("l'admin masque Alice (PATCH hidden=true) → 200", async () => {
    const res = await patchJson(
      admin,
      `/api/projects/${PROJECT_SLUG}/members/${aliceUserId}`,
      { hidden: true },
    );
    expect(res.status).toBe(200);
  });

  it("le token d'Alice est désormais refusé (401) — le trou fermé", async () => {
    const res = await fetchSecrets(ALICE_TOKEN);
    expect(res.status).toBe(401);
  });

  it("DB : la ligne MachineToken d'Alice porte un revokedAt", async () => {
    const revoked = await execSql(
      `SELECT ("revokedAt" IS NOT NULL) FROM "${TENANT_SCHEMA}"."MachineToken" WHERE id = '${aliceTokenId}'`,
    );
    expect(revoked.trim()).toBe("t");
  });

  it("le token de l'admin fonctionne toujours (200) — révocation scopée au créateur masqué", async () => {
    const res = await fetchSecrets(ADMIN_TOKEN);
    expect(res.status).toBe(200);
  });
});
