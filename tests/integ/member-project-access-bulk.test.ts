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
const HDR = { "content-type": "application/json", "x-forwarded-host": TENANT_HOST };

let admin: Session;
let orgId: string;
let adminUserId: string;
let memberUserId: string;
let projAId: string;
let projBId: string;
let tokenId: string;

const q = (sql: string) => execSqlValue(sql);

async function memberRow(projectId: string) {
  const role = await q(
    `SELECT role FROM "${TENANT_SCHEMA}"."ProjectMember" WHERE "userId"='${memberUserId}' AND "projectId"='${projectId}'`,
  );
  const hidden = await q(
    `SELECT hidden FROM "${TENANT_SCHEMA}"."ProjectMember" WHERE "userId"='${memberUserId}' AND "projectId"='${projectId}'`,
  );
  return role ? { role, hidden } : null;
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
  // Environnement + MachineToken du MEMBRE sur le projet A (cascade §2.15).
  const envId = cuid();
  await execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."Environment" (id, name, "projectId") VALUES ('${envId}', 'prod', '${projAId}')`,
  );
  tokenId = cuid();
  await execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."MachineToken" (id, name, "tokenHash", "projectId", "environmentId", "createdById", "createdAt") VALUES ('${tokenId}', 'tok', 'hash-${STAMP}', '${projAId}', '${envId}', '${memberUserId}', NOW())`,
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
