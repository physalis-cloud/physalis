// Integ — onglet « Installation » (C-0051, Phase 4) :
//   GET   /api/projects/[slug]/setup
//   PATCH /api/projects/[slug] { setupGuide }

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  Session,
  adminSession,
  postJson,
  patchJson,
  deleteReq,
  TENANT_SCHEMA,
} from "./helpers/api";
import { execSql } from "./helpers/db";
import { randomBytes } from "node:crypto";

const SUFFIX = `${Date.now()}`;
let admin: Session;
let projectSlug = "";
let projectId = "";

type State = {
  legacy: boolean;
  guide: string | null;
  completedAt: string | null;
  steps: { id: string; status: string }[];
};
const getState = async () => {
  const res = await admin.fetch(`/api/projects/${projectSlug}/setup`);
  expect(res.status).toBe(200);
  return (await res.json()) as State;
};

beforeAll(async () => {
  admin = await adminSession();
  const res = await postJson(admin, "/api/projects", { name: `setup-${SUFFIX}` });
  if (res.status !== 201) throw new Error(`setup: ${res.status}`);
  const data = (await res.json()) as { project: { id: string; slug: string } };
  projectSlug = data.project.slug;
  projectId = data.project.id;
});

afterAll(async () => {
  if (projectSlug) await deleteReq(admin, `/api/projects/${projectSlug}`).catch(() => {});
});

describe("GET /api/projects/[slug]/setup", () => {
  it("un projet créé après le guide n'est pas « antérieur »", async () => {
    const s = await getState();
    expect(s.legacy).toBe(false);
    expect(s.guide).toBeNull();
    expect(s.completedAt).toBeNull();
    expect(s.steps.map((x) => x.id)).toEqual([
      "connection",
      "repo",
      "server",
      "secrets",
      "policy",
      "workflow",
      "firstCall",
      "firstSuccess",
    ]);
    expect(s.steps.find((x) => x.id === "connection")?.status).toBe("todo");
  });

  it("suit l'état réel : un dépôt renseigné valide l'étape aussitôt", async () => {
    const res = await patchJson(admin, `/api/projects/${projectSlug}`, {
      githubRepo: "acme/setup-test",
    });
    expect(res.status).toBe(200);
    expect((await getState()).steps.find((x) => x.id === "repo")?.status).toBe("done");
  });

  it("un succès corrélé posé en base ferme la dernière étape", async () => {
    await execSql(
      `UPDATE "${TENANT_SCHEMA}"."Project" SET "setupCompletedAt" = NOW() WHERE id = '${projectId}'`,
    );
    const s = await getState();
    expect(s.completedAt).not.toBeNull();
    expect(s.steps.find((x) => x.id === "firstSuccess")?.status).toBe("done");
  });
});

describe("PATCH setupGuide", () => {
  it("accepte shown, hidden et null (automatique)", async () => {
    for (const v of ["shown", "hidden", null]) {
      const res = await patchJson(admin, `/api/projects/${projectSlug}`, { setupGuide: v });
      expect(res.status).toBe(200);
      expect((await getState()).guide).toBe(v);
    }
  });

  it("refuse une valeur inconnue", async () => {
    const res = await patchJson(admin, `/api/projects/${projectSlug}`, { setupGuide: "auto" });
    expect(res.status).toBe(400);
  });

  it("n'écrit jamais setupLegacy, réservé à la migration", async () => {
    const res = await patchJson(admin, `/api/projects/${projectSlug}`, { setupLegacy: true });
    expect(res.status).toBe(200);
    expect((await getState()).legacy).toBe(false);
  });
});

describe("GET /api/projects/[slug]/setup/template", () => {
  let policyId = "";

  beforeAll(async () => {
    // Connexion CI requise pour créer une policy (cf. tests/integ/policies.test.ts).
    const orgId = (
      await execSql(
        `SELECT "organizationId" FROM "${TENANT_SCHEMA}"."Project" WHERE id = '${projectId}'`,
      )
    ).trim();
    const ciId = "ck" + randomBytes(11).toString("hex");
    await execSql(
      `INSERT INTO "${TENANT_SCHEMA}"."CiConnection" (id, "organizationId", name, provider, "createdAt", "updatedAt")
       VALUES ('${ciId}', '${orgId}', 'ci-setup-${SUFFIX}', 'github', NOW(), NOW())`,
    );
    await execSql(
      `UPDATE "${TENANT_SCHEMA}"."Project" SET "ciConnectionId" = '${ciId}' WHERE id = '${projectId}'`,
    );
    const res = await postJson(admin, `/api/projects/${projectSlug}/policies`, {
      workflow: "cd.yml",
      branch: "release",
      environment: "staging",
    });
    expect(res.status).toBe(201);
    policyId = ((await res.json()) as { policy: { id: string } }).policy.id;
  });

  it("rend le modèle pré-rempli et le chemin tiré de la policy", async () => {
    const res = await admin.fetch(
      `/api/projects/${projectSlug}/setup/template?policy=${policyId}&template=deploy`,
    );
    expect(res.status).toBe(200);
    const { content, path } = (await res.json()) as { content: string; path: string };
    expect(path).toBe(".github/workflows/cd.yml");
    expect(content).toContain(`VAULT_PROJECT: "${projectSlug}"`);
    expect(content).toContain(`VAULT_ENV: "staging"`);
    expect(content).toContain(`branches: ["release"]`);
    expect(content).toContain("Report to Physalis");
  });

  it("modèle d'un autre fournisseur que la policy → 400", async () => {
    const res = await admin.fetch(
      `/api/projects/${projectSlug}/setup/template?policy=${policyId}&template=gitlab`,
    );
    expect(res.status).toBe(400);
  });

  it("policy inconnue (ou d'un autre projet) → 404", async () => {
    const res = await admin.fetch(
      `/api/projects/${projectSlug}/setup/template?policy=nope&template=deploy`,
    );
    expect(res.status).toBe(404);
  });

  it("le guide expose la policy, avec son identifiant", async () => {
    const s = (await (await admin.fetch(`/api/projects/${projectSlug}/setup`)).json()) as {
      policies: { id: string; workflow: string }[];
    };
    expect(s.policies).toEqual([
      {
        id: policyId,
        workflow: "cd.yml",
        branch: "release",
        environment: "staging",
        // Connexion sans jeton : le fichier ne peut pas être lu, on ne conclut pas.
        file: { status: "unreadable", hasReport: null },
        lastRun: { state: "unknown", url: null, at: null },
      },
    ]);
  });
});
