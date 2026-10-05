// Integ — POST /api/projects/[slug]/[env]/deployments/[id]/rerun (C-0051).
// Chemins de refus seulement : la relance réelle exige un jeton de plateforme.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Session, adminSession, postJson, deleteReq, TENANT_SCHEMA } from "./helpers/api";
import { execSql } from "./helpers/db";

const SUFFIX = `${Date.now()}`;
let admin: Session;
let projectSlug = "";
let projectId = "";
let envId = "";

const rerun = (id: string) =>
  admin.fetch(`/api/projects/${projectSlug}/production/deployments/${id}/rerun`, {
    method: "POST",
  });

beforeAll(async () => {
  admin = await adminSession();
  const res = await postJson(admin, "/api/projects", { name: `rerun-${SUFFIX}` });
  const data = (await res.json()) as { project: { id: string; slug: string } };
  projectSlug = data.project.slug;
  projectId = data.project.id;
  envId = (
    await execSql(
      `SELECT id FROM "${TENANT_SCHEMA}"."Environment" WHERE "projectId" = '${projectId}' AND name = 'production'`,
    )
  ).trim();
  const seed = (id: string, status: string, ageMin: number) =>
    execSql(
      `INSERT INTO "${TENANT_SCHEMA}"."Deployment"
         (id, "projectId", "environmentId", provider, repo, workflow, branch, "runId", status, "bundleServedCount", "authorizedAt", "createdAt")
       VALUES ('${id}', '${projectId}', '${envId}', 'github', 'acme/app', 'deploy.yml', 'main', '${id.length}${ageMin}', '${status}', 1,
               NOW() - interval '${ageMin} minutes', NOW() - interval '${ageMin} minutes')`,
    );
  await seed(`rr-run-${SUFFIX}`, "requested", 2);
  await seed(`rr-done-${SUFFIX}`, "failed", 90);
});

afterAll(async () => {
  if (projectSlug) await deleteReq(admin, `/api/projects/${projectSlug}`).catch(() => {});
});

describe("relance d'un déploiement", () => {
  it("ligne inconnue → 404", async () => {
    expect((await rerun("nope")).status).toBe(404);
  });

  it("run encore en cours → 409", async () => {
    expect((await rerun(`rr-run-${SUFFIX}`)).status).toBe(409);
  });

  it("projet sans connexion à jeton → refus explicite, aucun appel à la plateforme", async () => {
    const res = await rerun(`rr-done-${SUFFIX}`);
    // 409 (connexion ≠ fournisseur du run : aucune connexion) ou 400 (pas de jeton).
    expect([400, 409]).toContain(res.status);
  });

  it("la liste dit à l'interface que la relance n'est pas possible (pas de jeton)", async () => {
    const res = await admin.fetch(`/api/projects/${projectSlug}/production/deployments`);
    expect(((await res.json()) as { canRerun: boolean }).canRerun).toBe(false);
  });
});
