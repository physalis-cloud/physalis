// §2.25a — GET /api/projects/[slug]/[env]/secrets/export déchiffrait tous les
// secrets d'un environnement d'un coup SANS entrée d'audit → toute alerte fondée
// sur un pic de SECRET_REVEAL était aveugle à ce chemin. Fix : valeur d'enum
// SECRET_EXPORT (migration) + logAction sur le modèle de SECRET_FETCH_BULK.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Session, adminSession, ADMIN_EMAIL, TENANT_SCHEMA } from "./helpers/api";
import { execSql } from "./helpers/db";
import { cuid } from "./helpers/org";

const SUFFIX = `${Date.now()}`;
const ORG = `sea-org-${SUFFIX}`;
const PROJ = `sea-p-${SUFFIX}`;

let admin: Session;
let orgId = "";
let projId = "";

beforeAll(async () => {
  admin = await adminSession();
  const adminUserId = (
    await execSql(
      `SELECT id FROM "${TENANT_SCHEMA}"."User" WHERE email = '${ADMIN_EMAIL}'`,
    )
  ).trim();

  orgId = cuid();
  projId = cuid();
  await execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."Organization" (id, name, slug, "createdAt")
     VALUES ('${orgId}', '${ORG}', '${ORG}', NOW())`,
  );
  // Admin OrgOWNER → accès à tous les projets de l'org (god-mode org).
  await execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."OrgMember" (id, "userId", "organizationId", role, "createdAt")
     VALUES ('${cuid()}', '${adminUserId}', '${orgId}', 'OWNER', NOW())`,
  );
  await execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."Project" (id, name, slug, "organizationId", "createdAt")
     VALUES ('${projId}', '${PROJ}', '${PROJ}', '${orgId}', NOW())`,
  );
  await execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."Environment" (id, name, "projectId")
     VALUES ('${cuid()}', 'production', '${projId}')`,
  );
});

afterAll(async () => {
  const S = TENANT_SCHEMA;
  await execSql(`DELETE FROM "${S}"."AccessLog" WHERE "projectId" = '${projId}'`).catch(() => {});
  await execSql(`DELETE FROM "${S}"."Environment" WHERE "projectId" = '${projId}'`).catch(() => {});
  await execSql(`DELETE FROM "${S}"."Project" WHERE id = '${projId}'`).catch(() => {});
  await execSql(`DELETE FROM "${S}"."OrgMember" WHERE "organizationId" = '${orgId}'`).catch(() => {});
  await execSql(`DELETE FROM "${S}"."Organization" WHERE id = '${orgId}'`).catch(() => {});
});

async function exportLogCount(): Promise<number> {
  const r = await execSql(
    `SELECT count(*) FROM "${TENANT_SCHEMA}"."AccessLog" WHERE "projectId" = '${projId}' AND action = 'SECRET_EXPORT'`,
  );
  return Number(r.trim());
}

describe("§2.25a — l'export .env laisse une entrée d'audit SECRET_EXPORT", () => {
  it("aucune entrée avant l'export", async () => {
    expect(await exportLogCount()).toBe(0);
  });

  it("GET .../secrets/export → 200 ET une entrée SECRET_EXPORT est créée", async () => {
    const res = await admin.fetch(
      `/api/projects/${PROJ}/production/secrets/export`,
    );
    expect(res.status).toBe(200);
    // logAction est fire-and-forget (asynchrone) → petite attente.
    await new Promise((r) => setTimeout(r, 400));
    expect(await exportLogCount()).toBe(1);
  });
});
