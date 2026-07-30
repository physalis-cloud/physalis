// §2.7 — Le retrait d'un membre d'organisation cascade les ProjectMember et
// révoque les MachineToken, mais laissait intacts ses TeamVaultMember : l'ex-membre
// gardait l'accès aux coffres d'équipe (l'accès coffre ne re-dérive pas
// l'appartenance à l'org). Offboarding incomplet.
//
// Fix : la transaction de retrait supprime aussi les TeamVaultMember, pour les
// collections ORG-level ET PROJET-level de CETTE org — sans toucher aux autres orgs.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import {
  Session,
  adminSession,
  deleteReq,
  ADMIN_EMAIL,
  TENANT_SCHEMA,
} from "./helpers/api";
import { execSql } from "./helpers/db";

const SUFFIX = `${Date.now()}`;
const ORG_SLUG = `vault-offboard-${SUFFIX}`;
const OTHER_ORG_SLUG = `vault-keep-${SUFFIX}`;
const PROJECT_SLUG = `vault-offboard-proj-${SUFFIX}`;
const MALLORY_EMAIL = `offboarded-${SUFFIX}@test.local`;

let admin: Session;
let orgId = "";
let otherOrgId = "";
let projectId = "";
let malloryId = "";

const cuid = () => "ck" + randomBytes(11).toString("hex");

async function seedCollection(
  scope: { organizationId?: string; projectId?: string },
  slug: string,
): Promise<string> {
  const id = cuid();
  const col = scope.organizationId ? '"organizationId"' : '"projectId"';
  const val = scope.organizationId ?? scope.projectId;
  await execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."TeamVaultCollection"
       (id, ${col}, name, slug, "createdAt", "updatedAt")
     VALUES ('${id}', '${val}', '${slug}', '${slug}', NOW(), NOW())`,
  );
  return id;
}

async function shareWithMallory(collectionId: string) {
  await execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."TeamVaultMember" (id, "collectionId", "userId", role, "createdAt")
     VALUES ('${cuid()}', '${collectionId}', '${malloryId}', 'EDITOR', NOW())`,
  );
}

/** Nombre de partages de coffre restants pour Mallory sur ces collections. */
async function sharesOn(collectionIds: string[]): Promise<number> {
  const list = collectionIds.map((c) => `'${c}'`).join(",");
  const n = await execSql(
    `SELECT count(*) FROM "${TENANT_SCHEMA}"."TeamVaultMember"
     WHERE "userId" = '${malloryId}' AND "collectionId" IN (${list})`,
  );
  return parseInt(n.trim(), 10);
}

let orgCollectionId = "";
let projectCollectionId = "";
let otherOrgCollectionId = "";

beforeAll(async () => {
  admin = await adminSession();
  const adminUserId = (
    await execSql(
      `SELECT id FROM "${TENANT_SCHEMA}"."User" WHERE email = '${ADMIN_EMAIL}'`,
    )
  ).trim();

  // Org cible (l'admin en est OWNER → il peut retirer un membre) + un projet.
  orgId = cuid();
  await execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."Organization" (id, name, slug, "createdAt")
     VALUES ('${orgId}', '${ORG_SLUG}', '${ORG_SLUG}', NOW())`,
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

  // Org de contrôle : Mallory y reste membre — ses coffres NE doivent PAS bouger.
  otherOrgId = cuid();
  await execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."Organization" (id, name, slug, "createdAt")
     VALUES ('${otherOrgId}', '${OTHER_ORG_SLUG}', '${OTHER_ORG_SLUG}', NOW())`,
  );

  // Mallory : membre des deux orgs (elle ne se connecte jamais — on agit en admin).
  malloryId = cuid();
  await execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."User" (id, email, role, "createdAt")
     VALUES ('${malloryId}', '${MALLORY_EMAIL}', 'MEMBER', NOW())`,
  );
  for (const oid of [orgId, otherOrgId]) {
    await execSql(
      `INSERT INTO "${TENANT_SCHEMA}"."OrgMember" (id, "userId", "organizationId", role, "createdAt")
       VALUES ('${cuid()}', '${malloryId}', '${oid}', 'MEMBER', NOW())`,
    );
  }

  // Coffres partagés avec Mallory : org-level + projet-level (org cible), et un
  // coffre de l'autre org (contrôle anti sur-suppression).
  orgCollectionId = await seedCollection({ organizationId: orgId }, `org-col-${SUFFIX}`);
  projectCollectionId = await seedCollection({ projectId }, `proj-col-${SUFFIX}`);
  otherOrgCollectionId = await seedCollection({ organizationId: otherOrgId }, `keep-col-${SUFFIX}`);
  await shareWithMallory(orgCollectionId);
  await shareWithMallory(projectCollectionId);
  await shareWithMallory(otherOrgCollectionId);
});

afterAll(async () => {
  const S = TENANT_SCHEMA;
  await execSql(`DELETE FROM "${S}"."TeamVaultMember" WHERE "userId" = '${malloryId}'`).catch(() => {});
  await execSql(`DELETE FROM "${S}"."TeamVaultCollection" WHERE id IN ('${orgCollectionId}','${projectCollectionId}','${otherOrgCollectionId}')`).catch(() => {});
  await execSql(`DELETE FROM "${S}"."Project" WHERE id = '${projectId}'`).catch(() => {});
  await execSql(`DELETE FROM "${S}"."OrgMember" WHERE "organizationId" IN ('${orgId}','${otherOrgId}')`).catch(() => {});
  await execSql(`DELETE FROM "${S}"."Organization" WHERE id IN ('${orgId}','${otherOrgId}')`).catch(() => {});
  await execSql(`DELETE FROM "${S}"."User" WHERE id = '${malloryId}'`).catch(() => {});
});

describe("§2.7 — le retrait d'org révoque les coffres d'équipe", () => {
  it("sanity : Mallory a bien 3 partages avant retrait", async () => {
    expect(
      await sharesOn([orgCollectionId, projectCollectionId, otherOrgCollectionId]),
    ).toBe(3);
  });

  it("le retrait de l'org réussit", async () => {
    const res = await deleteReq(admin, `/api/orgs/${ORG_SLUG}/members/${malloryId}`);
    expect(res.status).toBe(200);
  });

  it("ses partages de coffre de CETTE org sont révoqués (org-level ET projet-level)", async () => {
    expect(await sharesOn([orgCollectionId, projectCollectionId])).toBe(0);
  });

  it("ses partages d'une AUTRE org sont intacts (pas de sur-suppression)", async () => {
    expect(await sharesOn([otherOrgCollectionId])).toBe(1);
  });
});
