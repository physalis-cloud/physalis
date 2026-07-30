// §2.6 — Le token d'agent n'autorise qu'un (tenant, projet), mais les routes
// laissaient l'agent DÉCLARER son environnement :
//   - /rotation/agent/plan  : `?env=` était un CHOIX (fallback sur la config) →
//     un agent de staging demandait `?env=production` et recevait les creds DB
//     et les `hookToken` de prod.
//   - /rotation/agent/report: l'appartenance du secret n'était vérifiée qu'au
//     PROJET → un agent de staging écrasait la valeur d'un secret de PROD.
//
// Fix : l'environnement vient de l'AUTHENTIFICATION (cfg.environmentName) ; le
// param `env` devient une comparaison, et /report exige l'env authentifié.

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { randomBytes, createHash } from "node:crypto";
import { adminSession, BASE_URL, TENANT_SCHEMA, TENANT_SLUG } from "./helpers/api";
import { execSql } from "./helpers/db";

const SUFFIX = `${Date.now()}`;
const ORG_SLUG = `agent-env-org-${SUFFIX}`;
const PROJECT_SLUG = `agent-env-proj-${SUFFIX}`;
const AUTH_ENV = "production"; // env porté par la config agent (= authentifié)
const OTHER_ENV = "staging"; // env que l'agent n'a PAS le droit de viser

// Token d'agent au format attendu (sv_backup_<64 hex>) ; on stocke son sha256.
const AGENT_TOKEN = "sv_backup_" + randomBytes(32).toString("hex");
const AGENT_TOKEN_HASH = createHash("sha256").update(AGENT_TOKEN).digest("hex");

let orgId = "";
let projectId = "";
let prodSecretId = "";
let stagingSecretId = "";

const cuid = () => "ck" + randomBytes(11).toString("hex");

async function seedEnv(name: string): Promise<string> {
  const id = cuid();
  await execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."Environment" (id, name, "projectId")
     VALUES ('${id}', '${name}', '${projectId}')`,
  );
  return id;
}

/** Secret en rotation mode AGENT dans `environmentId` — cible de /report. */
async function seedAgentSecret(environmentId: string, key: string): Promise<string> {
  const id = cuid();
  await execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."Secret"
       (id, key, "encryptedValue", iv, tag, "environmentId",
        "rotationEnabled", "rotationStrategy", "rotationExecMode", "createdAt", "updatedAt")
     VALUES ('${id}', '${key}', 'x', 'x', 'x', '${environmentId}',
        true, 'WEBHOOK', 'AGENT', NOW(), NOW())`,
  );
  return id;
}

function planUrl(env?: string): string {
  const q = new URLSearchParams({ tenant: TENANT_SLUG, project: PROJECT_SLUG });
  if (env) q.set("env", env);
  return `${BASE_URL}/api/rotation/agent/plan?${q.toString()}`;
}

function agentFetch(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      authorization: `Bearer ${AGENT_TOKEN}`,
      // IP dédiée : le rate-limit agent est de 120/min/IP.
      "x-forwarded-for": `198.51.100.${Math.floor(Math.random() * 254) + 1}`,
    },
  });
}

function report(secretId: string): Promise<Response> {
  return agentFetch(`${BASE_URL}/api/rotation/agent/report`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    // `failed` : ne mute pas la valeur (applyRotationFailure), on ne teste que l'authz.
    body: JSON.stringify({
      tenant: TENANT_SLUG,
      project: PROJECT_SLUG,
      secretId,
      status: "failed",
      error: "test",
    }),
  });
}

beforeAll(async () => {
  await adminSession(); // vérifie que la stack répond
  const adminUserId = (
    await execSql(
      `SELECT id FROM "${TENANT_SCHEMA}"."User" ORDER BY "createdAt" ASC LIMIT 1`,
    )
  ).trim();

  orgId = cuid();
  // `rotationFeatureEnabled` = true : requis par le gating de rotation (lecture
  // ET, depuis §2.14, écriture). Sans lui le report legit serait refusé.
  await execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."Organization" (id, name, slug, "rotationFeatureEnabled", "createdAt")
     VALUES ('${orgId}', '${ORG_SLUG}', '${ORG_SLUG}', true, NOW())`,
  );
  await execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."OrgMember" (id, "userId", "organizationId", role, "createdAt")
     VALUES ('${cuid()}', '${adminUserId}', '${orgId}', 'OWNER', NOW())`,
  );

  projectId = cuid();
  await execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."Project" (id, name, slug, "organizationId", "createdAt")
     VALUES ('${projectId}', '${PROJECT_SLUG}', '${PROJECT_SLUG}', '${orgId}', NOW())`,
  );

  const prodEnvId = await seedEnv(AUTH_ENV);
  const stagingEnvId = await seedEnv(OTHER_ENV);
  prodSecretId = await seedAgentSecret(prodEnvId, "PROD_SECRET");
  stagingSecretId = await seedAgentSecret(stagingEnvId, "STAGING_SECRET");

  // Config agent : le token n'est valable QUE pour `production`.
  await execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."ProjectBackupConfig"
       (id, "projectId", enabled, "environmentName", "agentTokenHash", "createdAt", "updatedAt")
     VALUES ('${cuid()}', '${projectId}', true, '${AUTH_ENV}', '${AGENT_TOKEN_HASH}', NOW(), NOW())`,
  );
});

afterAll(async () => {
  const S = TENANT_SCHEMA;
  await execSql(`DELETE FROM "${S}"."ProjectBackupConfig" WHERE "projectId" = '${projectId}'`).catch(() => {});
  await execSql(`DELETE FROM "${S}"."Secret" WHERE "environmentId" IN (SELECT id FROM "${S}"."Environment" WHERE "projectId" = '${projectId}')`).catch(() => {});
  await execSql(`DELETE FROM "${S}"."Environment" WHERE "projectId" = '${projectId}'`).catch(() => {});
  await execSql(`DELETE FROM "${S}"."Project" WHERE id = '${projectId}'`).catch(() => {});
  await execSql(`DELETE FROM "${S}"."OrgMember" WHERE "organizationId" = '${orgId}'`).catch(() => {});
  await execSql(`DELETE FROM "${S}"."Organization" WHERE id = '${orgId}'`).catch(() => {});
});

describe("§2.6 — l'agent ne peut pas franchir d'environnement", () => {
  it("plan : env AUTRE que l'authentifié → 403 (le franchissement)", async () => {
    const res = await agentFetch(planUrl(OTHER_ENV));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("env_mismatch");
  });

  it("plan : son propre env → 200 (pas de sur-restriction)", async () => {
    const res = await agentFetch(planUrl(AUTH_ENV));
    expect(res.status).toBe(200);
  });

  it("plan : sans param env → 200 (l'env vient de l'authentification)", async () => {
    const res = await agentFetch(planUrl());
    expect(res.status).toBe(200);
  });

  it("report : secret d'un AUTRE env → 403 (l'écrasement cross-env)", async () => {
    const res = await report(stagingSecretId);
    expect(res.status).toBe(403);
  });

  it("report : secret de son propre env → accepté (garde anti sur-restriction)", async () => {
    // Prouve que le 403 ci-dessus vient bien de l'ENV, pas d'une ligne absente.
    const res = await report(prodSecretId);
    expect(res.status).toBe(200);
  });
});

// §2.14 — Le report appliquait `rotationExecMode: AGENT` + appartenance mais
// PAS les portails de /plan (rotationEnabled + projet non en pause + feature
// org). Conséquence : le kill-switch OWNER « Pause rotation » ne coupait que la
// LECTURE ; l'agent continuait d'écrire (versionne, écrase, redéploie).
describe("§2.14 — le kill-switch coupe aussi l'écriture (parité de gating /plan ↔ /report)", () => {
  const S = TENANT_SCHEMA;
  async function setPaused(v: boolean) {
    await execSql(`UPDATE "${S}"."Project" SET "rotationPaused" = ${v} WHERE id = '${projectId}'`);
  }
  async function setFeature(v: boolean) {
    await execSql(`UPDATE "${S}"."Organization" SET "rotationFeatureEnabled" = ${v} WHERE id = '${orgId}'`);
  }
  afterEach(async () => {
    // Rétablit l'état « rotation active » quel que soit le test précédent.
    await setPaused(false);
    await setFeature(true);
  });

  it("projet en pause → report 403 (le kill-switch, désormais opérant)", async () => {
    await setPaused(true);
    const res = await report(prodSecretId);
    expect(res.status).toBe(403);
  });

  it("reprise après pause → report 200 (le kill-switch n'est pas un aller simple)", async () => {
    await setPaused(true);
    expect((await report(prodSecretId)).status).toBe(403);
    await setPaused(false);
    expect((await report(prodSecretId)).status).toBe(200);
  });

  it("feature d'offre org désactivée → report 403 (gating d'offre appliqué à l'écriture)", async () => {
    await setFeature(false);
    const res = await report(prodSecretId);
    expect(res.status).toBe(403);
  });
});
