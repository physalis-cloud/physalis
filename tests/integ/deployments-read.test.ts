// Integ — lecture du suivi des déploiements (C-0051, Phase 3) :
//   GET /api/projects/[slug]/[env]/deployments  (historique d'un environnement)
//   GET /api/projects/[slug]/deployments        (dernier par environnement)
//
// Les lignes sont semées en SQL : les écrire par la vraie route exigerait un
// jeton OIDC signé par une plateforme (cf. tests/integ/deploy-report.test.ts).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  Session,
  adminSession,
  postJson,
  deleteReq,
  TENANT_SCHEMA,
} from "./helpers/api";
import { execSql } from "./helpers/db";

const SUFFIX = `${Date.now()}`;
let admin: Session;
let projectSlug = "";
let projectId = "";
let envId = "";

const seed = (id: string, fields: string, values: string) =>
  execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."Deployment"
       (id, "projectId", "environmentId", provider, repo, workflow, branch, "runId", ${fields})
     VALUES ('${id}', '${projectId}', '${envId}', 'github', 'acme/app', 'deploy.yml', 'main', ${values})`,
  );

beforeAll(async () => {
  admin = await adminSession();
  const res = await postJson(admin, "/api/projects", { name: `deploy-read-${SUFFIX}` });
  if (res.status !== 201) throw new Error(`setup: ${res.status}`);
  const data = (await res.json()) as { project: { id: string; slug: string } };
  projectSlug = data.project.slug;
  projectId = data.project.id;
  envId = (
    await execSql(
      `SELECT id FROM "${TENANT_SCHEMA}"."Environment" WHERE "projectId" = '${projectId}' AND name = 'production'`,
    )
  ).trim();
  if (!envId) throw new Error("setup: environnement production absent");

  // Ancien : réussi et corrélé. Récent : sans rapport depuis 35 min → anormal.
  // Un troisième, rapporté sans bundle servi → non corrélé.
  await seed(
    `dr1-${SUFFIX}`,
    `"runAttempt", status, "bundleServedCount", "authorizedAt", "reportedAt", "createdAt"`,
    `'100', '1', 'succeeded', 2, NOW() - interval '2 hours', NOW() - interval '110 minutes', NOW() - interval '2 hours'`,
  );
  await seed(
    `dr2-${SUFFIX}`,
    `"runAttempt", status, "bundleServedCount", "reportedAt", "createdAt"`,
    `'101', '1', 'failed', 0, NOW() - interval '1 hour', NOW() - interval '1 hour'`,
  );
  await seed(
    `dr3-${SUFFIX}`,
    `"runAttempt", status, "bundleServedCount", "authorizedAt", "createdAt"`,
    `'102', '1', 'requested', 1, NOW() - interval '35 minutes', NOW() - interval '35 minutes'`,
  );
});

afterAll(async () => {
  if (projectSlug) await deleteReq(admin, `/api/projects/${projectSlug}`).catch(() => {});
});

describe("GET /api/projects/[slug]/[env]/deployments", () => {
  it("rend l'historique, du plus récent au plus ancien, avec la phase calculée", async () => {
    const res = await admin.fetch(`/api/projects/${projectSlug}/production/deployments`);
    expect(res.status).toBe(200);
    const { deployments } = (await res.json()) as {
      deployments: { id: string; phase: string; correlated: boolean; runUrl: string | null }[];
    };
    expect(deployments.map((d) => d.id)).toEqual([
      `dr3-${SUFFIX}`,
      `dr2-${SUFFIX}`,
      `dr1-${SUFFIX}`,
    ]);
    expect(deployments.map((d) => d.phase)).toEqual(["abnormal", "failed", "succeeded"]);
    expect(deployments.map((d) => d.correlated)).toEqual([true, false, true]);
    expect(deployments[2].runUrl).toBe("https://github.com/acme/app/actions/runs/100");
    // Rien d'autre que la vue : pas de repo brut, pas d'identifiant de policy.
    expect(deployments[0]).not.toHaveProperty("policyId");
  });

  it("environnement inconnu → 404", async () => {
    const res = await admin.fetch(`/api/projects/${projectSlug}/nope/deployments`);
    expect(res.status).toBe(404);
  });

  it("sans session → refusé", async () => {
    const res = await fetch(
      `${process.env.TEST_BASE_URL ?? "http://localhost:3001"}/api/projects/${projectSlug}/production/deployments`,
    );
    expect([401, 403]).toContain(res.status);
  });
});

describe("GET /api/projects/[slug]/deployments", () => {
  it("rend le dernier déploiement de chaque environnement qui en a un", async () => {
    const res = await admin.fetch(`/api/projects/${projectSlug}/deployments`);
    expect(res.status).toBe(200);
    const { latest } = (await res.json()) as {
      latest: Record<string, { id: string; phase: string }>;
    };
    expect(Object.keys(latest)).toEqual(["production"]);
    expect(latest.production).toMatchObject({ id: `dr3-${SUFFIX}`, phase: "abnormal" });
  });
});
