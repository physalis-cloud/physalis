// #3 — « Autoriser l'accès » à un MEMBER doit CRÉER une ligne ProjectMember.
// Régression : le PATCH avait une « optimisation » qui ne créait pas de ligne
// quand l'état cible = default (VIEWER, non masqué) — or pour un OrgMEMBER,
// « pas de ligne » = AUCUN accès (règle 5). Le grant était donc un no-op.

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
const PROJECT_SLUG = `pmg${STAMP}`;
const HDR = { "content-type": "application/json", "x-forwarded-host": TENANT_HOST };

let memberUserId: string;
let admin: Session;

type MemberItem = {
  userId: string;
  hasAccess: boolean;
  source: string;
};

async function getMember(): Promise<MemberItem | undefined> {
  const res = await admin.fetch(`/api/projects/${PROJECT_SLUG}/members`, {
    headers: { "x-forwarded-host": TENANT_HOST },
  });
  const data = (await res.json()) as { members: MemberItem[] };
  return data.members.find((m) => m.userId === memberUserId);
}

beforeAll(async () => {
  const adminUserId = await execSqlValue(
    `SELECT id FROM "${TENANT_SCHEMA}"."User" WHERE email='${ADMIN_EMAIL}'`,
  );
  memberUserId = cuid();
  await execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."User" (id, email) VALUES ('${memberUserId}', 'pmg-${STAMP}@test.local')`,
  );
  const orgId = await provisionOrg(`pmgorg${STAMP}`, adminUserId);
  await execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."OrgMember" (id, "userId", "organizationId", role, "createdAt") VALUES ('${cuid()}', '${memberUserId}', '${orgId}', 'MEMBER', NOW())`,
  );
  await execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."Project" (id, name, slug, "organizationId", "createdAt") VALUES ('${cuid()}', 'pmg', '${PROJECT_SLUG}', '${orgId}', NOW())`,
  );
  admin = await adminSession();
});

// Le tenant de test est PARTAGÉ et plafonné à 5 sièges : un fichier qui
// sème un utilisateur sans le reprendre occupe un siège définitivement, et
// finit par faire échouer les invitations des autres en 403.
afterAll(async () => {
  await cleanupFixtures(STAMP);
});


describe("#3 — grant d'accès projet à un MEMBER", () => {
  it("au départ, le MEMBER n'a PAS accès (default, règle 5)", async () => {
    const m = await getMember();
    expect(m).toBeDefined();
    expect(m!.hasAccess).toBe(false);
    expect(m!.source).toBe("default");
  });

  it("« Autoriser l'accès » (PATCH hidden=false) crée la ligne → hasAccess", async () => {
    const patch = await admin.fetch(
      `/api/projects/${PROJECT_SLUG}/members/${memberUserId}`,
      { method: "PATCH", headers: HDR, body: JSON.stringify({ hidden: false }) },
    );
    expect(patch.status).toBe(200);
    const body = (await patch.json()) as { noop?: boolean };
    expect(body.noop).not.toBe(true); // PAS un no-op : une ligne a été créée

    const m = await getMember();
    expect(m!.hasAccess).toBe(true);
    expect(m!.source).toBe("explicit");
  });
});
