// #2-E — e2e invitation avec accès projet pré-attribués.
//
// Deux bouts de la chaîne :
//   1. POST /api/orgs/[slug]/members  → stocke projectAccess sur l'Invitation
//      (feature multi_users active sur le tenant test = SHARED).
//   2. POST /api/invitations/[token]/register-and-accept → applique les
//      ProjectMember à l'acceptation (applyInvitationProjectAccess), en
//      filtrant tout projet n'appartenant pas à l'org.

import { describe, it, expect, beforeAll , afterAll} from "vitest";
import { randomBytes, createHash } from "node:crypto";
import { execSql, execSqlValue } from "./helpers/db";
import {
  adminSession,
  BASE_URL,
  TENANT_SCHEMA,
  TENANT_HOST,
  ADMIN_EMAIL,
  type Session,
} from "./helpers/api";
import { provisionOrg, cuid } from "./helpers/org";
import { cleanupFixtures } from "./helpers/cleanup";

const STAMP = Date.now();
const ORG_SLUG = `ipae${STAMP}`;
const PROJ_A = `ipaeA${STAMP}`;
const PROJ_B = `ipaeB${STAMP}`;
const HDR = { "content-type": "application/json", "x-forwarded-host": TENANT_HOST };

let admin: Session;
let adminUserId: string;
let orgId: string;
let projAId: string;
let projBId: string;

const q = (sql: string) => execSqlValue(sql);

beforeAll(async () => {
  adminUserId = await q(
    `SELECT id FROM "${TENANT_SCHEMA}"."User" WHERE email='${ADMIN_EMAIL}'`,
  );
  orgId = await provisionOrg(ORG_SLUG, adminUserId); // admin = OWNER
  projAId = cuid();
  projBId = cuid();
  await execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."Project" (id, name, slug, "organizationId", "createdAt") VALUES ('${projAId}', 'A', '${PROJ_A}', '${orgId}', NOW()), ('${projBId}', 'B', '${PROJ_B}', '${orgId}', NOW())`,
  );
  admin = await adminSession();
});

// Le tenant de test est PARTAGÉ et plafonné à 5 sièges : un fichier qui
// sème un utilisateur sans le reprendre occupe un siège définitivement, et
// finit par faire échouer les invitations des autres en 403.
afterAll(async () => {
  await cleanupFixtures(STAMP);
});


describe("#2-E — invitation avec accès projet pré-attribués", () => {
  it("POST invitation stocke projectAccess sur l'Invitation", async () => {
    const email = `ipae-store-${STAMP}@test.local`;
    const res = await admin.fetch(`/api/orgs/${ORG_SLUG}/members`, {
      method: "POST",
      headers: HDR,
      body: JSON.stringify({
        email,
        role: "MEMBER",
        projectAccess: [
          { projectId: projAId, role: "EDITOR" },
          { projectId: projBId, role: "VIEWER" },
        ],
      }),
    });
    expect(res.status).toBe(201);
    const invId = ((await res.json()) as { invitation: { id: string } })
      .invitation.id;

    const stored = await q(
      `SELECT "projectAccess"::text FROM "${TENANT_SCHEMA}"."Invitation" WHERE id='${invId}'`,
    );
    const parsed = JSON.parse(stored) as { projectId: string; role: string }[];
    expect(parsed).toEqual(
      expect.arrayContaining([
        { projectId: projAId, role: "EDITOR" },
        { projectId: projBId, role: "VIEWER" },
      ]),
    );
    expect(parsed).toHaveLength(2);
  });

  it("register-and-accept crée les ProjectMember (et filtre un projet hors-org)", async () => {
    const email = `ipae-accept-${STAMP}@test.local`;
    const token = "iv_" + randomBytes(32).toString("hex");
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000)
      .toISOString()
      .replace("Z", "+00");
    const bogusProjectId = cuid(); // projet inexistant / hors-org → doit être filtré
    const projectAccess = JSON.stringify([
      { projectId: projAId, role: "EDITOR" },
      { projectId: projBId, role: "VIEWER" },
      { projectId: bogusProjectId, role: "OWNER" },
    ]);
    // JSON = guillemets doubles uniquement → sûr à embarquer dans '...'.
    await execSql(
      `INSERT INTO "${TENANT_SCHEMA}"."Invitation" (id, email, "organizationId", role, "tokenHash", "expiresAt", "invitedById", "projectAccess", "createdAt") VALUES ('${cuid()}', '${email}', '${orgId}', 'MEMBER', '${tokenHash}', '${expiresAt}', '${adminUserId}', '${projectAccess}'::jsonb, NOW())`,
    );

    const res = await fetch(
      `${BASE_URL}/api/invitations/${token}/register-and-accept`,
      {
        method: "POST",
        headers: HDR,
        body: JSON.stringify({ password: "accept-e2e-password-123" }),
      },
    );
    expect(res.status).toBe(200);

    const newUserId = await q(
      `SELECT id FROM "${TENANT_SCHEMA}"."User" WHERE email='${email}'`,
    );
    expect(newUserId).not.toBe("");

    // OrgMember MEMBER créé.
    const orgRole = await q(
      `SELECT role FROM "${TENANT_SCHEMA}"."OrgMember" WHERE "userId"='${newUserId}' AND "organizationId"='${orgId}'`,
    );
    expect(orgRole).toBe("MEMBER");

    // ProjectMember : A=EDITOR, B=VIEWER (hidden=false), bogus filtré.
    const rows = await execSql(
      `SELECT "projectId", role, hidden FROM "${TENANT_SCHEMA}"."ProjectMember" WHERE "userId"='${newUserId}' ORDER BY "projectId"`,
    );
    const parsed = rows
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [projectId, role, hidden] = l.split("|");
        return { projectId, role, hidden };
      });
    expect(parsed).toHaveLength(2);
    const a = parsed.find((r) => r.projectId === projAId);
    const b = parsed.find((r) => r.projectId === projBId);
    expect(a).toEqual({ projectId: projAId, role: "EDITOR", hidden: "f" });
    expect(b).toEqual({ projectId: projBId, role: "VIEWER", hidden: "f" });
    expect(parsed.find((r) => r.projectId === bogusProjectId)).toBeUndefined();
  });
});
