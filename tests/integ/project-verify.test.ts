// Integ — vérification d'un projet antérieur au guide (C-0051, Phase 4 bis) :
// POST /api/projects/[slug]/setup/verify. On fait passer un même projet par
// les états successifs et on lit l'issue à chaque fois.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import {
  Session,
  adminSession,
  postJson,
  patchJson,
  deleteReq,
  TENANT_SCHEMA,
} from "./helpers/api";
import { execSql } from "./helpers/db";

const SUFFIX = `${Date.now()}`;
let admin: Session;
let projectSlug = "";
let projectId = "";
let ciId = "";
let serverId = "";

type Result = {
  outcome: string;
  checks: Record<string, string>;
  lastAuthorizedAt: string | null;
  snippet: string | null;
  file: { path: string; branch: string } | null;
};
const verify = async () => {
  const res = await admin.fetch(`/api/projects/${projectSlug}/setup/verify`, { method: "POST" });
  expect(res.status).toBe(200);
  return (await res.json()) as Result;
};

beforeAll(async () => {
  admin = await adminSession();
  const res = await postJson(admin, "/api/projects", { name: `verify-${SUFFIX}` });
  if (res.status !== 201) throw new Error(`setup: ${res.status}`);
  const data = (await res.json()) as { project: { id: string; slug: string } };
  projectSlug = data.project.slug;
  projectId = data.project.id;
  // Simule un projet antérieur au guide (c'est la migration qui pose ce drapeau).
  await execSql(
    `UPDATE "${TENANT_SCHEMA}"."Project" SET "setupLegacy" = true WHERE id = '${projectId}'`,
  );
});

afterAll(async () => {
  if (projectSlug) await deleteReq(admin, `/api/projects/${projectSlug}`).catch(() => {});
  if (ciId) await execSql(`DELETE FROM "${TENANT_SCHEMA}"."CiConnection" WHERE id = '${ciId}'`);
  if (serverId) await execSql(`DELETE FROM "${TENANT_SCHEMA}"."Server" WHERE id = '${serverId}'`);
});

describe("POST /api/projects/[slug]/setup/verify", () => {
  it("projet relié à rien → notLinked", async () => {
    const r = await verify();
    expect(r.outcome).toBe("notLinked");
    expect(r.checks.deployed).toBe("ko");
    expect(r.snippet).toBeNull();
  });

  it("la vérification classe le projet : il n'est plus « antérieur au guide »", async () => {
    const legacy = (
      await execSql(
        `SELECT "setupLegacy" FROM "${TENANT_SCHEMA}"."Project" WHERE id = '${projectId}'`,
      )
    ).trim();
    expect(legacy).toBe("f");
  });

  it("relié mais jamais servi → neverDeployed", async () => {
    const orgId = (
      await execSql(
        `SELECT "organizationId" FROM "${TENANT_SCHEMA}"."Project" WHERE id = '${projectId}'`,
      )
    ).trim();
    ciId = "ck" + randomBytes(11).toString("hex");
    await execSql(
      `INSERT INTO "${TENANT_SCHEMA}"."CiConnection" (id, "organizationId", name, provider, "createdAt", "updatedAt")
       VALUES ('${ciId}', '${orgId}', 'ci-verify-${SUFFIX}', 'github', NOW(), NOW())`,
    );
    await execSql(
      `UPDATE "${TENANT_SCHEMA}"."Project" SET "ciConnectionId" = '${ciId}' WHERE id = '${projectId}'`,
    );
    expect(
      (await patchJson(admin, `/api/projects/${projectSlug}`, { githubRepo: "acme/legacy" })).status,
    ).toBe(200);
    expect(
      (
        await postJson(admin, `/api/projects/${projectSlug}/policies`, {
          workflow: "deploy.yml",
          branch: "main",
          environment: "production",
        })
      ).status,
    ).toBe(201);
    const r = await verify();
    expect(r.outcome).toBe("neverDeployed");
    expect(r.file).toEqual({ path: ".github/workflows/deploy.yml", branch: "main", httpStatus: 0 });
  });

  it("déjà servi mais aucun environnement lié à un serveur → configIncomplete", async () => {
    await execSql(
      `INSERT INTO "${TENANT_SCHEMA}"."AccessLog" (id, "projectId", action, "createdAt")
       VALUES ('al${SUFFIX}', '${projectId}', 'DEPLOY_AUTHORIZED', NOW() - interval '3 days')`,
    );
    const r = await verify();
    expect(r.outcome).toBe("configIncomplete");
    expect(r.checks).toMatchObject({ config: "ko", deployed: "ok" });
  });

  it("déjà servi, workflow illisible (connexion sans jeton) → ready + étape fournie", async () => {
    // Un environnement lié à un serveur complète la configuration.
    const orgId = (
      await execSql(
        `SELECT "organizationId" FROM "${TENANT_SCHEMA}"."Project" WHERE id = '${projectId}'`,
      )
    ).trim();
    serverId = "sv" + randomBytes(11).toString("hex");
    await execSql(
      `INSERT INTO "${TENANT_SCHEMA}"."Server" (id, "organizationId", name, ip, "sshUser", "encryptedKey", iv, tag, "createdAt", "updatedAt")
       VALUES ('${serverId}', '${orgId}', 'srv-${SUFFIX}', '203.0.113.7', 'deploy', 'x', 'x', 'x', NOW(), NOW())`,
    );
    await execSql(
      `UPDATE "${TENANT_SCHEMA}"."Environment" SET "serverId" = '${serverId}'
       WHERE "projectId" = '${projectId}' AND name = 'production'`,
    );
    const r = await verify();
    expect(r.outcome).toBe("ready");
    expect(r.checks).toMatchObject({ deployed: "ok", workflowFile: "unknown", reportStep: "unknown" });
    expect(r.lastAuthorizedAt).not.toBeNull();
    // On ne sait pas si l'étape existe : on fournit de quoi l'ajouter, tirée du modèle.
    expect(r.snippet).toContain("/api/deploy/report");
    expect(r.snippet).toContain("Report to Physalis");
  });

  it("un succès déjà enregistré → completed", async () => {
    await execSql(
      `UPDATE "${TENANT_SCHEMA}"."Project" SET "setupCompletedAt" = NOW() WHERE id = '${projectId}'`,
    );
    expect((await verify()).outcome).toBe("completed");
  });
});
