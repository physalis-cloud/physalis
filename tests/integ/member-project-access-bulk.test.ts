// #2-B — PUT /api/orgs/[slug]/members/[userId]/project-access
//
// Pose EN BLOC les accès projet d'un membre (modale « Droits d'accès »).
// Vérifie : create/update/delete des lignes ProjectMember explicites non
// masquées, la cascade §2.15 (révocation MachineToken quand un OrgMEMBER perd
// réellement l'accès), et le refus 400 pour un OWNER/ADMIN d'org.

import { describe, it, expect, beforeAll , afterAll} from "vitest";
import { execSql, execSqlValue } from "./helpers/db";
import {
  adminSession,
  TENANT_SCHEMA,
  TENANT_HOST,
  ADMIN_EMAIL,
  type Session,
} from "./helpers/api";
import { provisionOrg, cuid } from "./helpers/org";
import { cleanupFixtures } from "./helpers/cleanup";

const STAMP = Date.now();
const ORG_SLUG = `mpaorg${STAMP}`;
const PROJ_A = `mpaA${STAMP}`;
const PROJ_B = `mpaB${STAMP}`;
const PROJ_C = `mpac${STAMP}`;
const HDR = { "content-type": "application/json", "x-forwarded-host": TENANT_HOST };

let admin: Session;
let orgId: string;
let adminUserId: string;
let memberUserId: string;
let devUserId: string;
let projAId: string;
let projBId: string;
let envId: string;
let tokenId: string;
let devTokenId: string;

const q = (sql: string) => execSqlValue(sql);

async function rowFor(userId: string, projectId: string) {
  const role = await q(
    `SELECT role FROM "${TENANT_SCHEMA}"."ProjectMember" WHERE "userId"='${userId}' AND "projectId"='${projectId}'`,
  );
  const hidden = await q(
    `SELECT hidden FROM "${TENANT_SCHEMA}"."ProjectMember" WHERE "userId"='${userId}' AND "projectId"='${projectId}'`,
  );
  return role ? { role, hidden } : null;
}

const memberRow = (projectId: string) => rowFor(memberUserId, projectId);

/** État vu par la modale : accès EFFECTIF calculé serveur (§4). */
async function accessState(userId: string) {
  const res = await admin.fetch(
    `/api/orgs/${ORG_SLUG}/members/${userId}/project-access`,
    { headers: { "x-forwarded-host": TENANT_HOST } },
  );
  const data = (await res.json()) as {
    projects: {
      id: string;
      hidden: boolean;
      hasAccess: boolean;
      effectiveRole: string | null;
    }[];
  };
  return new Map(data.projects.map((p) => [p.id, p]));
}

function put(userId: string, projectAccess: { projectId: string; role: string }[]) {
  return admin.fetch(`/api/orgs/${ORG_SLUG}/members/${userId}/project-access`, {
    method: "PUT",
    headers: HDR,
    body: JSON.stringify({ projectAccess }),
  });
}

beforeAll(async () => {
  adminUserId = await q(
    `SELECT id FROM "${TENANT_SCHEMA}"."User" WHERE email='${ADMIN_EMAIL}'`,
  );
  memberUserId = cuid();
  await execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."User" (id, email) VALUES ('${memberUserId}', 'mpa-${STAMP}@test.local')`,
  );
  orgId = await provisionOrg(ORG_SLUG, adminUserId); // admin = OWNER
  await execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."OrgMember" (id, "userId", "organizationId", role, "createdAt") VALUES ('${cuid()}', '${memberUserId}', '${orgId}', 'MEMBER', NOW())`,
  );
  projAId = cuid();
  projBId = cuid();
  await execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."Project" (id, name, slug, "organizationId", "createdAt") VALUES ('${projAId}', 'A', '${PROJ_A}', '${orgId}', NOW()), ('${projBId}', 'B', '${PROJ_B}', '${orgId}', NOW())`,
  );
  // Un DEV : il a l'EDITOR implicite sur A et B sans aucune ligne (règle 4).
  devUserId = cuid();
  await execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."User" (id, email) VALUES ('${devUserId}', 'mpadev-${STAMP}@test.local')`,
  );
  await execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."OrgMember" (id, "userId", "organizationId", role, "createdAt") VALUES ('${cuid()}', '${devUserId}', '${orgId}', 'DEV', NOW())`,
  );
  // Environnement + MachineToken du MEMBRE sur le projet A (cascade §2.15).
  envId = cuid();
  await execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."Environment" (id, name, "projectId") VALUES ('${envId}', 'prod', '${projAId}')`,
  );
  tokenId = cuid();
  devTokenId = cuid();
  await execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."MachineToken" (id, name, "tokenHash", "projectId", "environmentId", "createdById", "createdAt") VALUES ('${tokenId}', 'tok', 'hash-${STAMP}', '${projAId}', '${envId}', '${memberUserId}', NOW()), ('${devTokenId}', 'devtok', 'devhash-${STAMP}', '${projAId}', '${envId}', '${devUserId}', NOW())`,
  );
  admin = await adminSession();
});

// Le tenant de test est PARTAGÉ et plafonné à 5 sièges : un fichier qui
// sème un utilisateur sans le reprendre occupe un siège définitivement, et
// finit par faire échouer les invitations des autres en 403.
afterAll(async () => {
  await cleanupFixtures(STAMP);
});


describe("#2-B — pose en bloc des accès projet d'un membre", () => {
  it("grant initial : A=EDITOR, B=OWNER → 2 lignes créées", async () => {
    const res = await put(memberUserId, [
      { projectId: projAId, role: "EDITOR" },
      { projectId: projBId, role: "OWNER" },
    ]);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ granted: 2, revoked: 0 });
    expect(await memberRow(projAId)).toEqual({ role: "EDITOR", hidden: "f" });
    expect(await memberRow(projBId)).toEqual({ role: "OWNER", hidden: "f" });
  });

  it("GET reflète l'état courant : A/B explicites avec leur rôle (#2-C)", async () => {
    const res = await admin.fetch(
      `/api/orgs/${ORG_SLUG}/members/${memberUserId}/project-access`,
      { headers: { "x-forwarded-host": TENANT_HOST } },
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      orgRole: string;
      projects: {
        id: string;
        explicit: boolean;
        explicitRole: string | null;
        hasAccess: boolean;
      }[];
    };
    expect(data.orgRole).toBe("MEMBER");
    const a = data.projects.find((p) => p.id === projAId)!;
    const b = data.projects.find((p) => p.id === projBId)!;
    expect(a).toMatchObject({ explicit: true, explicitRole: "EDITOR", hasAccess: true });
    expect(b).toMatchObject({ explicit: true, explicitRole: "OWNER", hasAccess: true });
  });

  it("re-PUT [A=VIEWER] : A mis à jour, B retiré (delete)", async () => {
    const res = await put(memberUserId, [{ projectId: projAId, role: "VIEWER" }]);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ granted: 1, revoked: 1 });
    expect(await memberRow(projAId)).toEqual({ role: "VIEWER", hidden: "f" });
    expect(await memberRow(projBId)).toBeNull();
    // Le token du membre est sur A (encore accessible) → PAS révoqué.
    const revoked = await q(
      `SELECT "revokedAt" FROM "${TENANT_SCHEMA}"."MachineToken" WHERE id='${tokenId}'`,
    );
    expect(revoked).toBe("");
  });

  it("PUT [] : A retiré → MEMBER perd l'accès → MachineToken révoqué (§2.15)", async () => {
    const res = await put(memberUserId, []);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ granted: 0, revoked: 1 });
    expect(await memberRow(projAId)).toBeNull();
    const revoked = await q(
      `SELECT "revokedAt" FROM "${TENANT_SCHEMA}"."MachineToken" WHERE id='${tokenId}'`,
    );
    expect(revoked).not.toBe(""); // revokedAt posé
  });

  it("cible OWNER d'org → 400 (OWNER implicite, accès par projet sans objet)", async () => {
    const res = await put(adminUserId, [{ projectId: projAId, role: "VIEWER" }]);
    expect(res.status).toBe(400);
  });
});

// Cible DEV — le cas qui manquait. Un DEV a l'EDITOR implicite PARTOUT (règle 4) :
// lui « retirer » un projet en omettant sa ligne ne fait rien du tout. Seul
// `NONE` (→ barrière `hidden`) le coupe réellement.
describe("#2-B bis — « aucun accès » sur un DEV pose une barrière", () => {
  it("A=NONE → ligne masquée ; B=EDITOR → AUCUNE ligne (l'implicite suffit)", async () => {
    const res = await put(devUserId, [
      { projectId: projAId, role: "NONE" },
      { projectId: projBId, role: "EDITOR" },
    ]);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ granted: 0, revoked: 1 });
    expect(await rowFor(devUserId, projAId)).toEqual({
      role: "VIEWER",
      hidden: "t",
    });
    // Figer une ligne EDITOR explicite ici la lui laisserait après une
    // rétrogradation en MEMBER, qui doit au contraire tout lui retirer.
    expect(await rowFor(devUserId, projBId)).toBeNull();
  });

  it("le DEV masqué perd l'accès effectif sur A, le garde sur B", async () => {
    const state = await accessState(devUserId);
    expect(state.get(projAId)).toMatchObject({
      hidden: true,
      hasAccess: false,
      effectiveRole: null,
    });
    expect(state.get(projBId)).toMatchObject({
      hasAccess: true,
      effectiveRole: "EDITOR",
    });
  });

  it("ses MachineTokens sur le projet masqué sont révoqués (§2.15)", async () => {
    // Sans ça, le DEV ne voit plus le projet mais son Bearer continue de lire.
    const revoked = await q(
      `SELECT "revokedAt" FROM "${TENANT_SCHEMA}"."MachineToken" WHERE id='${devTokenId}'`,
    );
    expect(revoked).not.toBe("");
  });

  it("re-PUT A=EDITOR : la barrière est levée sans laisser de ligne", async () => {
    const res = await put(devUserId, [
      { projectId: projAId, role: "EDITOR" },
      { projectId: projBId, role: "EDITOR" },
    ]);
    expect(res.status).toBe(200);
    expect(await rowFor(devUserId, projAId)).toBeNull();
    const state = await accessState(devUserId);
    expect(state.get(projAId)).toMatchObject({
      hasAccess: true,
      effectiveRole: "EDITOR",
    });
  });
});

// Lot 3 — les droits se posent DANS la création, pas après : un projet neuf ne
// doit jamais exister, même une seconde, ouvert à un dev qu'on voulait exclure.
describe("création de projet — accès des membres posé d'entrée", () => {
  it("POST /api/projects avec memberAccess : DEV bloqué, MEMBER autorisé", async () => {
    const res = await admin.fetch("/api/projects", {
      method: "POST",
      headers: HDR,
      body: JSON.stringify({
        name: `C ${STAMP}`,
        slug: PROJ_C,
        organization: ORG_SLUG,
        memberAccess: [
          { userId: devUserId, role: "NONE" },
          { userId: memberUserId, role: "VIEWER" },
        ],
      }),
    });
    expect(res.status).toBe(201);
    const { project } = (await res.json()) as { project: { id: string } };

    expect(await rowFor(devUserId, project.id)).toEqual({
      role: "VIEWER",
      hidden: "t",
    });
    expect(await rowFor(memberUserId, project.id)).toEqual({
      role: "VIEWER",
      hidden: "f",
    });
    // Le créateur reste OWNER du projet.
    expect(await rowFor(adminUserId, project.id)).toEqual({
      role: "OWNER",
      hidden: "f",
    });

    const state = await accessState(devUserId);
    expect(state.get(project.id)).toMatchObject({ hasAccess: false });
  });

  it("un userId étranger à l'org est ignoré, la création aboutit", async () => {
    const res = await admin.fetch("/api/projects", {
      method: "POST",
      headers: HDR,
      body: JSON.stringify({
        name: `D ${STAMP}`,
        slug: `mpad${STAMP}`,
        organization: ORG_SLUG,
        memberAccess: [{ userId: cuid(), role: "OWNER" }],
      }),
    });
    expect(res.status).toBe(201);
    const { project } = (await res.json()) as { project: { id: string } };
    const rows = await q(
      `SELECT count(*) FROM "${TENANT_SCHEMA}"."ProjectMember" WHERE "projectId"='${project.id}'`,
    );
    expect(rows).toBe("1"); // le créateur, et lui seul
  });
});
