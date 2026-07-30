// §2.25f — invitation survivant à la perte d'autorité de l'émetteur : ni le DELETE
// ni le PATCH membre ne touchaient les invitations ÉMISES → un ADMIN en cours
// d'offboarding s'auto-invitait puis acceptait dans la fenêtre TTL (48 h) APRÈS
// son retrait. Fix : la transaction de retrait supprime les invitations pendantes
// émises par le partant, SCOPÉ à l'org.
//
// Pour prouver la deleteMany (et pas la simple cascade `invitedBy onDelete:Cascade`),
// le membre retiré doit SURVIVRE à la purge d'orphelin → on lui donne une 2e org.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import { adminSession, ADMIN_EMAIL, TENANT_SCHEMA } from "./helpers/api";
import { execSql } from "./helpers/db";
import { cuid, seedInvitation } from "./helpers/org";

const SUFFIX = `${Date.now()}`;
const ORG1 = `mri-org1-${SUFFIX}`;
const ORG2 = `mri-org2-${SUFFIX}`;
const BOB = `bob-mri-${SUFFIX}@test.local`;

let admin: Awaited<ReturnType<typeof adminSession>>;
let bobUserId = "";
let org1Id = "";
let org2Id = "";
let invA = ""; // émise par Bob dans org1 (doit disparaître)
let invB = ""; // émise par Bob dans org2 (doit survivre — scopé)

async function invExists(token: string): Promise<boolean> {
  const h = createHash("sha256").update(token).digest("hex");
  const r = await execSql(
    `SELECT count(*) FROM "${TENANT_SCHEMA}"."Invitation" WHERE "tokenHash" = '${h}'`,
  );
  return Number(r.trim()) > 0;
}

beforeAll(async () => {
  admin = await adminSession();
  const adminUserId = (
    await execSql(
      `SELECT id FROM "${TENANT_SCHEMA}"."User" WHERE email = '${ADMIN_EMAIL}'`,
    )
  ).trim();

  for (const [slug, ref] of [
    [ORG1, "1"],
    [ORG2, "2"],
  ] as const) {
    const id = cuid();
    if (ref === "1") org1Id = id;
    else org2Id = id;
    await execSql(
      `INSERT INTO "${TENANT_SCHEMA}"."Organization" (id, name, slug, "createdAt")
       VALUES ('${id}', '${slug}', '${slug}', NOW())`,
    );
    await execSql(
      `INSERT INTO "${TENANT_SCHEMA}"."OrgMember" (id, "userId", "organizationId", role, "createdAt")
       VALUES ('${cuid()}', '${adminUserId}', '${id}', 'OWNER', NOW())`,
    );
  }

  // Bob : ADMIN de org1 (le retrait le vise), MEMBER de org2 (→ survit à la purge).
  bobUserId = cuid();
  await execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."User" (id, email, "createdAt") VALUES ('${bobUserId}', '${BOB}', NOW())`,
  );
  await execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."OrgMember" (id, "userId", "organizationId", role, "createdAt")
     VALUES ('${cuid()}', '${bobUserId}', '${org1Id}', 'ADMIN', NOW())`,
  );
  await execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."OrgMember" (id, "userId", "organizationId", role, "createdAt")
     VALUES ('${cuid()}', '${bobUserId}', '${org2Id}', 'MEMBER', NOW())`,
  );

  invA = await seedInvitation(org1Id, `inv-a-${SUFFIX}@test.local`, "MEMBER", bobUserId);
  invB = await seedInvitation(org2Id, `inv-b-${SUFFIX}@test.local`, "MEMBER", bobUserId);
});

afterAll(async () => {
  const S = TENANT_SCHEMA;
  await execSql(`DELETE FROM "${S}"."Invitation" WHERE "invitedById" = '${bobUserId}'`).catch(() => {});
  await execSql(`DELETE FROM "${S}"."OrgMember" WHERE "organizationId" IN ('${org1Id}','${org2Id}')`).catch(() => {});
  await execSql(`DELETE FROM "${S}"."Organization" WHERE id IN ('${org1Id}','${org2Id}')`).catch(() => {});
  await execSql(`DELETE FROM "${S}"."User" WHERE id = '${bobUserId}'`).catch(() => {});
});

describe("§2.25f — le retrait d'un membre révoque ses invitations pendantes (scopé à l'org)", () => {
  it("sanity : les deux invitations émises par Bob existent", async () => {
    expect(await invExists(invA)).toBe(true);
    expect(await invExists(invB)).toBe(true);
  });

  it("retirer Bob de org1 → son invitation dans org1 est supprimée", async () => {
    const res = await admin.fetch(`/api/orgs/${ORG1}/members/${bobUserId}`, {
      method: "DELETE",
    });
    expect([200, 204]).toContain(res.status);
    expect(await invExists(invA)).toBe(false);
  });

  it("son invitation dans org2 (où il reste membre) survit — révocation scopée à l'org", async () => {
    expect(await invExists(invB)).toBe(true);
  });

  it("Bob n'est PAS purgé (encore membre de org2) → la suppression vient bien de deleteMany, pas de la cascade User", async () => {
    const c = await execSql(
      `SELECT count(*) FROM "${TENANT_SCHEMA}"."User" WHERE id = '${bobUserId}'`,
    );
    expect(Number(c.trim())).toBe(1);
  });
});
