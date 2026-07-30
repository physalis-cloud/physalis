// §2.3 — Un EDITOR de projet ne doit PAS pouvoir modifier la config CI/CD
// (githubRepo / ciRepo / ciConnectionId / githubWorkflow) via PATCH
// /api/projects/[slug]. Ces champs pilotent les policies OIDC : au changement,
// le handler repointe TOUTES les policies du projet (policy.updateMany +
// admin.oidcPolicy.updateMany) vers le repo indiqué → un EDITOR (potentiellement
// externe à l'org) pouvait détourner les policies vers un repo qu'il contrôle,
// obtenir un JWT OIDC et exfiltrer la clé SSH de prod via /api/deploy.
//
// Le fix reflète STRICTEMENT canManagePolicies (policies/route.ts:76) : OWNER
// projet OU OrgDEV. Les champs name/slug restent ouverts à l'EDITOR.

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
const ORG_SLUG = `ci-authz-org-${SUFFIX}`;
const PROJECT_SLUG = `ci-authz-proj-${SUFFIX}`;
const INITIAL_REPO = "argo-web/original";

const EDITOR_EMAIL = `editor-ci-${SUFFIX}@test.local`;
const EDITOR_PASSWORD = "editortestpassword12";
const DEV_EMAIL = `dev-ci-${SUFFIX}@test.local`;
const DEV_PASSWORD = "devtestpassword12";

let editor: Session;
let dev: Session;
let adminUserId = "";
let orgId = "";
let projectId = "";

const cuid = () => "ck" + randomBytes(11).toString("hex");

async function provisionOrg(slug: string, ownerId: string): Promise<string> {
  const id = cuid();
  await execSql(
    // `maxSeats` explicite : une org créée sans lui prend le bundle confiné
    // par défaut (2 sièges, ADDON_ORG_BUNDLE). Or ce fichier sème un admin +
    // 3 membres, et depuis le durcissement §2.24b le quota est REVÉRIFIÉ à
    // l'acceptation de l'invitation → 403 déterministe. Le refus de l'app est
    // correct ; c'est le fixture qui était sous-provisionné.
    `INSERT INTO "${TENANT_SCHEMA}"."Organization" (id, name, slug, "maxSeats", "createdAt")
     VALUES ('${id}', '${slug}', '${slug}', 10, NOW())`,
  );
  await execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."OrgMember" (id, "userId", "organizationId", role, "createdAt")
     VALUES ('${cuid()}', '${ownerId}', '${id}', 'OWNER', NOW())`,
  );
  return id;
}

/** Invite + enregistre un user avec le rôle org donné, renvoie sa session. */
async function inviteAndRegister(
  email: string,
  password: string,
  role: "MEMBER" | "DEV",
  invitedById: string,
): Promise<Session> {
  const token = "iv_" + randomBytes(32).toString("hex");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const expiresAt = new Date(Date.now() + 3600_000)
    .toISOString()
    .replace("Z", "+00");
  await execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."Invitation" (id, email, "organizationId", role, "tokenHash", "expiresAt", "invitedById", "createdAt")
     VALUES ('${cuid()}', '${email}', '${orgId}', '${role}', '${tokenHash}', '${expiresAt}', '${invitedById}', NOW())`,
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
      body: JSON.stringify({ password }),
    },
  );
  if (!res.ok) throw new Error(`register-and-accept failed: HTTP ${res.status}`);
  return loginAs(email, password);
}

async function userIdOf(email: string): Promise<string> {
  const id = (
    await execSql(
      `SELECT id FROM "${TENANT_SCHEMA}"."User" WHERE email = '${email}'`,
    )
  ).trim();
  if (!id) throw new Error(`user ${email} not found`);
  return id;
}

async function projectRepo(): Promise<string> {
  return (
    await execSql(
      `SELECT "githubRepo" FROM "${TENANT_SCHEMA}"."Project" WHERE slug = '${PROJECT_SLUG}'`,
    )
  ).trim();
}

beforeAll(async () => {
  await adminSession();
  adminUserId = await userIdOf(ADMIN_EMAIL);

  orgId = await provisionOrg(ORG_SLUG, adminUserId);

  // Projet avec un repo CI déjà configuré (cible du repointage).
  projectId = cuid();
  await execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."Project" (id, name, slug, "organizationId", "githubRepo", "createdAt")
     VALUES ('${projectId}', '${PROJECT_SLUG}', '${PROJECT_SLUG}', '${orgId}', '${INITIAL_REPO}', NOW())`,
  );

  // Mallory : OrgMEMBER + ProjectEDITOR non masqué — le profil « prestataire »
  // que le code des policies dit vouloir exclure.
  editor = await inviteAndRegister(EDITOR_EMAIL, EDITOR_PASSWORD, "MEMBER", adminUserId);
  const editorId = await userIdOf(EDITOR_EMAIL);
  await execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."ProjectMember" (id, "userId", "projectId", role, hidden)
     VALUES ('${cuid()}', '${editorId}', '${projectId}', 'EDITOR', false)`,
  );

  // Dana : OrgDEV — a le droit d'ajuster la config CI (intention d'origine).
  dev = await inviteAndRegister(DEV_EMAIL, DEV_PASSWORD, "DEV", adminUserId);
});

afterAll(async () => {
  const S = TENANT_SCHEMA;
  await execSql(`DELETE FROM "${S}"."ProjectMember" WHERE "projectId" = '${projectId}'`).catch(() => {});
  await execSql(`DELETE FROM "${S}"."Project" WHERE id = '${projectId}'`).catch(() => {});
  await execSql(`DELETE FROM "${S}"."Invitation" WHERE "organizationId" = '${orgId}'`).catch(() => {});
  await execSql(`DELETE FROM "${S}"."OrgMember" WHERE "organizationId" = '${orgId}'`).catch(() => {});
  await execSql(`DELETE FROM "${S}"."Organization" WHERE id = '${orgId}'`).catch(() => {});
  for (const email of [EDITOR_EMAIL, DEV_EMAIL]) {
    await execSql(`DELETE FROM "${S}"."User" WHERE email = '${email}'`).catch(() => {});
  }
});

describe("§2.3 — PATCH config CI réservé à OWNER/DEV", () => {
  it("EDITOR simple → 403 sur changement de githubRepo (repointage bloqué)", async () => {
    const res = await patchJson(editor, `/api/projects/${PROJECT_SLUG}`, {
      githubRepo: "attacker/pwn",
    });
    expect(res.status).toBe(403);
  });

  it("le repo du projet n'a PAS été modifié par la tentative", async () => {
    expect(await projectRepo()).toBe(INITIAL_REPO);
  });

  it("EDITOR peut toujours modifier name (pas de sur-restriction)", async () => {
    const res = await patchJson(editor, `/api/projects/${PROJECT_SLUG}`, {
      name: `renommé-${SUFFIX}`,
    });
    expect(res.status).toBe(200);
  });

  it("OrgDEV → 200 sur changement de githubRepo (rôle autorisé)", async () => {
    const res = await patchJson(dev, `/api/projects/${PROJECT_SLUG}`, {
      githubRepo: "argo-web/v2",
    });
    expect(res.status).toBe(200);
    expect(await projectRepo()).toBe("argo-web/v2");
  });
});
