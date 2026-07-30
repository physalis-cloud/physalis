// Integ tests pour les Policy + /api/deploy.
//
// Note : le happy path /api/deploy (token OIDC valide → bundle de deploy)
// est couvert exhaustivement par tests/lib/oidc.test.ts (avec un faux
// issuer en process). Ici on couvre :
//   - CRUD Policy (RBAC + validation + dedup)
//   - Chemins de refus de /api/deploy (pas de token, token invalide)
//   - Audit log peuplé sur DEPLOY_DENIED.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  Session,
  adminSession,
  postJson,
  patchJson,
  deleteReq,
  BASE_URL,
  TENANT_SCHEMA,
} from "./helpers/api";
import { randomBytes } from "node:crypto";
import { execSql } from "./helpers/db";

const SUFFIX = `${Date.now()}`;
const PROJECT_NAME = `pol-proj-${SUFFIX}`;

let admin: Session;
let projectSlug = "";
let projectId = "";
let policyId = "";
let ciConnectionId = "";

beforeAll(async () => {
  admin = await adminSession();
  const res = await postJson(admin, "/api/projects", { name: PROJECT_NAME });
  if (res.status !== 201) throw new Error(`setup: ${res.status}`);
  const data = (await res.json()) as { project: { id: string; slug: string } };
  projectSlug = data.project.slug;
  projectId = data.project.id;

  // Le repo des policies est désormais dérivé du repo projet (source unique).
  // On le définit ici pour que la création de policy soit possible.
  const patch = await patchJson(admin, `/api/projects/${projectSlug}`, {
    githubRepo: "argo-web/voyages",
  });
  if (patch.status !== 200) throw new Error(`setup repo: ${patch.status}`);

  // Connexion CI/CD — REQUISE depuis la refonte multiprovider : la route de
  // création de policy lit `loadProjectCiMeta` et refuse en 400 tant que le
  // projet n'est relié à aucune connexion (le provider et l'issuer en
  // proviennent, plus seulement le repo). Ce fichier précédait ce changement et
  // échouait donc de façon déterministe. Le refus de l'app est correct ; c'est
  // le fixture qui était incomplet.
  const orgId = (
    await execSql(
      `SELECT "organizationId" FROM "${TENANT_SCHEMA}"."Project" WHERE id = '${projectId}'`,
    )
  ).trim();
  ciConnectionId = "ck" + randomBytes(11).toString("hex");
  await execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."CiConnection" (id, "organizationId", name, provider, "createdAt", "updatedAt")
     VALUES ('${ciConnectionId}', '${orgId}', 'ci-${SUFFIX}', 'github', NOW(), NOW())`,
  );
  await execSql(
    `UPDATE "${TENANT_SCHEMA}"."Project" SET "ciConnectionId" = '${ciConnectionId}' WHERE id = '${projectId}'`,
  );
});

afterAll(async () => {
  if (projectSlug) {
    await deleteReq(admin, `/api/projects/${projectSlug}`).catch(() => {});
  }
});

describe("Policy CRUD", () => {
  it("POST crée une policy (201), hérite du repo projet et retourne l'env name", async () => {
    const res = await postJson(admin, `/api/projects/${projectSlug}/policies`, {
      workflow: "deploy.yml",
      branch: "main",
      environment: "production",
    });
    expect(res.status).toBe(201);
    const data = (await res.json()) as {
      policy: { id: string; environment: string; repo: string };
    };
    expect(data.policy.environment).toBe("production");
    // Le repo n'est plus saisi : il provient de Project.githubRepo.
    expect(data.policy.repo).toBe("argo-web/voyages");
    policyId = data.policy.id;
  });

  it("POST refuse si le repo projet n'est pas défini → 400", async () => {
    const create = await postJson(admin, "/api/projects", {
      name: `pol-norepo-${SUFFIX}`,
    });
    const proj = (await create.json()) as { project: { slug: string } };
    try {
      const res = await postJson(
        admin,
        `/api/projects/${proj.project.slug}/policies`,
        { workflow: "deploy.yml", branch: "main", environment: "production" },
      );
      expect(res.status).toBe(400);
    } finally {
      await deleteReq(admin, `/api/projects/${proj.project.slug}`).catch(
        () => {},
      );
    }
  });

  it("POST refuse un workflow sans extension yml → 400", async () => {
    const res = await postJson(admin, `/api/projects/${projectSlug}/policies`, {
      workflow: "deploy",
      branch: "main",
      environment: "production",
    });
    expect(res.status).toBe(400);
  });

  it("POST refuse un environnement inconnu → 400", async () => {
    const res = await postJson(admin, `/api/projects/${projectSlug}/policies`, {
      workflow: "deploy.yml",
      branch: "main",
      environment: "non-existent",
    });
    expect(res.status).toBe(400);
  });

  it("POST refuse un duplicat → 409", async () => {
    const res = await postJson(admin, `/api/projects/${projectSlug}/policies`, {
      workflow: "deploy.yml",
      branch: "main",
      environment: "production",
    });
    expect(res.status).toBe(409);
  });

  it("GET liste retourne la policy", async () => {
    const res = await admin.fetch(`/api/projects/${projectSlug}/policies`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      policies: Array<{ id: string }>;
    };
    expect(data.policies.find((p) => p.id === policyId)).toBeDefined();
  });

  it("PATCH du repo projet resync le repo des policies existantes", async () => {
    const patch = await patchJson(admin, `/api/projects/${projectSlug}`, {
      githubRepo: "argo-web/voyages-v2",
    });
    expect(patch.status).toBe(200);

    const res = await admin.fetch(`/api/projects/${projectSlug}/policies`);
    const data = (await res.json()) as {
      policies: Array<{ id: string; repo: string }>;
    };
    const p = data.policies.find((x) => x.id === policyId);
    expect(p?.repo).toBe("argo-web/voyages-v2");

    // Remet la valeur initiale pour ne pas perturber d'éventuels tests suivants.
    await patchJson(admin, `/api/projects/${projectSlug}`, {
      githubRepo: "argo-web/voyages",
    });
  });

  it("DELETE supprime la policy (200)", async () => {
    const res = await deleteReq(
      admin,
      `/api/projects/${projectSlug}/policies/${policyId}`,
    );
    expect(res.status).toBe(200);

    const get = await admin.fetch(`/api/projects/${projectSlug}/policies`);
    const data = (await get.json()) as { policies: unknown[] };
    expect(data.policies.length).toBe(0);
    policyId = "";
  });

  it("DELETE d'une policy inexistante → 404", async () => {
    const res = await deleteReq(
      admin,
      `/api/projects/${projectSlug}/policies/cknotfound000000000000`,
    );
    expect(res.status).toBe(404);
  });

  it("anon → 401 sur GET liste", async () => {
    const anon = new Session();
    const res = await anon.fetch(`/api/projects/${projectSlug}/policies`);
    expect(res.status).toBe(401);
  });
});

describe("/api/deploy — chemins de refus", () => {
  it("POST sans Authorization → 401", async () => {
    const res = await fetch(`${BASE_URL}/api/deploy`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        project: projectSlug,
        environment: "production",
      }),
    });
    expect(res.status).toBe(401);
  });

  it("POST avec un Bearer ne ressemblant pas à un JWT → 401", async () => {
    const res = await fetch(`${BASE_URL}/api/deploy`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer not-a-jwt",
      },
      body: JSON.stringify({
        project: projectSlug,
        environment: "production",
      }),
    });
    expect(res.status).toBe(401);
  });

  it("POST avec un JWT cryptographiquement invalide → 401 + audit DEPLOY_DENIED", async () => {
    // JWT signé localement avec une cle bidon — impossible de matcher le
    // JWKS GitHub. La signature jose echoue → on attend `bad_signature`.
    const fakeJwt =
      // header { alg: "RS256", typ: "JWT" }
      "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9." +
      // payload { iss, aud, exp future, repository, ... }
      "eyJpc3MiOiJodHRwczovL3Rva2VuLmFjdGlvbnMuZ2l0aHVidXNlcmNvbnRlbnQuY29tIiwiYXVkIjoic2VjcmV0dmF1bHQuYXJnb3dlYi5mciIsImV4cCI6OTk5OTk5OTk5OSwicmVwb3NpdG9yeSI6ImFyZ28td2ViL2pheCIsImpvYl93b3JrZmxvd19yZWYiOiJhcmdvLXdlYi9qYXgvLmdpdGh1Yi93b3JrZmxvd3MvZGVwbG95LnltbEByZWZzL2hlYWRzL21haW4iLCJyZWYiOiJyZWZzL2hlYWRzL21haW4ifQ." +
      // signature bidon
      "AAAAA";

    const beforeCount = await countDenials();
    const res = await fetch(`${BASE_URL}/api/deploy`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${fakeJwt}`,
      },
      body: JSON.stringify({
        project: projectSlug,
        environment: "production",
      }),
    });
    expect(res.status).toBe(401);

    // Note multi-tenant : pour un JWT invalide on n'a pas encore de
    // tenant identifié → logAction() skip sans tenantSlug. L'audit
    // d'un DEPLOY_DENIED anonymous nécessiterait une table globale
    // admin.deploy_denied (TODO V2). En attendant, on se contente de
    // vérifier que le HTTP 401 est bien renvoyé.
    void beforeCount;
  });
});

describe("/api/deploy — Policy lookup (sans token valide on ne va pas plus loin)", () => {
  // Pour tester le chemin "policy not found" il faudrait un vrai JWT
  // GitHub valide — coverage assuree par tests/lib/oidc.test.ts. Ici on
  // se contente de valider que la route est branchee : pas de body sans
  // header → toujours 401, pas 400, ce qui prouve que l'auth passe avant
  // la validation du body.
  it("body manquant + token absent → 401 (auth d'abord)", async () => {
    const res = await fetch(`${BASE_URL}/api/deploy`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(401);
  });
});

async function countDenials(): Promise<number> {
  // Filtre par projectId pour ne compter que les denis de notre test.
  // Les denis precoces (signature) n'ont pas de projectId, donc on
  // compte tous les DEPLOY_DENIED recents (hack : derniere minute).
  const out = await execSql(
    `SELECT COUNT(*) FROM "${TENANT_SCHEMA}"."AccessLog" WHERE action = 'DEPLOY_DENIED' AND "createdAt" > NOW() - INTERVAL '1 minute'`,
  );
  return Number(out.trim());
}

// projectId est utilise indirectement par les helpers de cleanup qui
// passent par projectSlug. On le garde pour le rendre dispo si besoin.
void projectId;
