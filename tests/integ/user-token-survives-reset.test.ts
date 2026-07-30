// §2.20a / matrice §4bis — cellules user_token × password_reset et × twofa_disable.
//
// ARBITRAGE VOULU (pas un bug) : un UserToken (`sv_user_*`) est un PAT, sémantique
// GitHub/GitLab — il SURVIT à un reset de mot de passe / une désactivation 2FA.
// Brancher `sessionsValidFrom` (le kill-switch des JWT web + PluginToken) sur les
// UserToken casserait les intégrations N8n légitimes à chaque rotation.
//
// Ce test ENCODE la décision : si un jour quelqu'un branche isSessionInvalidated
// dans la branche USER de validateIntegrationToken, ce test tombe et force à
// reconsidérer (le vrai fix du finding est la ré-auth à l'ÉMISSION, pas la
// révocation par borne).
//
// (Le contraste — le JWT web MEURT au bump — est prouvé par session-invalidation.)

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes, createHash } from "node:crypto";
import {
  adminSession,
  BASE_URL,
  TENANT_SLUG,
  TENANT_SCHEMA,
} from "./helpers/api";
import { execSql } from "./helpers/db";

const SUFFIX = `${Date.now()}`;
const ORG_SLUG = `uts-org-${SUFFIX}`;
const PROJ_SLUG = `uts-p-${SUFFIX}`;
const BOB_EMAIL = `bob-uts-${SUFFIX}@test.local`;

const cuid = () => "ck" + randomBytes(11).toString("hex");
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const USER_TOKEN = "sv_user_" + randomBytes(32).toString("hex");

let bobUserId = "";
let orgId = "";
let projId = "";

function credsFetch(): Promise<Response> {
  return fetch(
    `${BASE_URL}/api/integrations/credentials?project=${PROJ_SLUG}&type=service`,
    { headers: { authorization: `Bearer ${USER_TOKEN}` } },
  );
}

async function bumpBobSessionsValidFrom(): Promise<void> {
  await execSql(
    `UPDATE "${TENANT_SCHEMA}"."User" SET "sessionsValidFrom" = NOW() WHERE id = '${bobUserId}'`,
  );
}

beforeAll(async () => {
  await adminSession(); // vérifie la stack
  orgId = cuid();
  await execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."Organization" (id, name, slug, "createdAt")
     VALUES ('${orgId}', '${ORG_SLUG}', '${ORG_SLUG}', NOW())`,
  );
  bobUserId = cuid();
  await execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."User" (id, email, "createdAt") VALUES ('${bobUserId}', '${BOB_EMAIL}', NOW())`,
  );
  await execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."OrgMember" (id, "userId", "organizationId", role, "createdAt")
     VALUES ('${cuid()}', '${bobUserId}', '${orgId}', 'MEMBER', NOW())`,
  );
  projId = cuid();
  await execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."Project" (id, name, slug, "organizationId", "createdAt")
     VALUES ('${projId}', '${PROJ_SLUG}', '${PROJ_SLUG}', '${orgId}', NOW())`,
  );
  // Bob ProjectMember EDITOR non masqué → son UserToken atteint le projet.
  await execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."ProjectMember" (id, "userId", "projectId", role, hidden)
     VALUES ('${cuid()}', '${bobUserId}', '${projId}', 'EDITOR', false)`,
  );
  // UserToken de Bob (ligne tenant + index admin).
  const hash = sha256(USER_TOKEN);
  await execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."UserToken" (id, "userId", name, "tokenHash", prefix, "createdAt")
     VALUES ('${cuid()}', '${bobUserId}', 'pat', '${hash}', '${USER_TOKEN.slice(0, 12)}', NOW())`,
  );
  await execSql(
    `INSERT INTO admin.token_index (token_hash, tenant_slug, kind, created_at)
     VALUES ('${hash}', '${TENANT_SLUG}', 'USER', NOW())`,
  );
});

afterAll(async () => {
  const S = TENANT_SCHEMA;
  await execSql(`DELETE FROM admin.token_index WHERE token_hash = '${sha256(USER_TOKEN)}'`).catch(() => {});
  await execSql(`DELETE FROM "${S}"."UserToken" WHERE "userId" = '${bobUserId}'`).catch(() => {});
  await execSql(`DELETE FROM "${S}"."ProjectMember" WHERE "userId" = '${bobUserId}'`).catch(() => {});
  await execSql(`DELETE FROM "${S}"."Project" WHERE id = '${projId}'`).catch(() => {});
  await execSql(`DELETE FROM "${S}"."OrgMember" WHERE "organizationId" = '${orgId}'`).catch(() => {});
  await execSql(`DELETE FROM "${S}"."Organization" WHERE id = '${orgId}'`).catch(() => {});
  await execSql(`DELETE FROM "${S}"."User" WHERE id = '${bobUserId}'`).catch(() => {});
});

describe("§2.20a — un UserToken (PAT) SURVIT au reset (arbitrage voulu)", () => {
  it("sanity : le UserToken valide accède aux intégrations (pas 401)", async () => {
    const res = await credsFetch();
    expect(res.status).not.toBe(401);
  });

  it("après bump sessionsValidFrom (= reset mdp / 2FA off) → le UserToken SURVIT (toujours pas 401)", async () => {
    await bumpBobSessionsValidFrom();
    const res = await credsFetch();
    // La branche USER de validateIntegrationToken n'applique PAS sessionsValidFrom :
    // c'est la sémantique PAT. Si ce test passe à 401, quelqu'un a branché le
    // kill-switch sur les UserToken → reconsidérer (cf. §2.20a, fix = ré-auth
    // à l'émission, pas révocation par borne).
    expect(res.status).not.toBe(401);
  });
});
