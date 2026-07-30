// Ouverture des demandes externes (SecretRequest) aux MEMBRES.
// Contre-preuves de l'élargissement d'accès :
//   1. un MEMBER peut créer une demande ORG-LEVEL (201) ;
//   2. un MEMBER NE PEUT PAS scoper un projet auquel il n'a pas accès (403)
//      — la prévention d'escalade (check `effectiveProjectRole`, §4) ;
//   3. un MEMBER ne voit que SES demandes (pas celles d'un DEV+), et son org
//      apparaît comme cible de création.

import { describe, it, expect, beforeAll , afterAll} from "vitest";
import bcrypt from "bcryptjs";
import { execSql, execSqlValue } from "./helpers/db";
import {
  loginAs,
  adminSession,
  TENANT_SCHEMA,
  TENANT_HOST,
  TENANT_SLUG,
  ADMIN_EMAIL,
  type Session,
} from "./helpers/api";
import { provisionOrg, cuid } from "./helpers/org";
import { cleanupFixtures } from "./helpers/cleanup";

const STAMP = Date.now();
const MEMBER_EMAIL = `member-sr-${STAMP}@test.local`;
const MEMBER_PASSWORD = "member-test-password-123";
const HDR = {
  "content-type": "application/json",
  "x-forwarded-host": TENANT_HOST,
};

let orgId: string;
let inaccessibleProjectId: string;
let member: Session;

function createRequest(session: Session, body: Record<string, unknown>) {
  return session.fetch("/api/secret-requests", {
    method: "POST",
    headers: HDR,
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  const adminUserId = await execSqlValue(
    `SELECT id FROM "${TENANT_SCHEMA}"."User" WHERE email='${ADMIN_EMAIL}'`,
  );
  // Utilisateur MEMBER dédié.
  const memberUserId = cuid();
  const hash = bcrypt.hashSync(MEMBER_PASSWORD, 12);
  await execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."User" (id, email, password) VALUES ('${memberUserId}', '${MEMBER_EMAIL}', '${hash}')`,
  );
  // Org (admin = OWNER) + le user ajouté en MEMBER.
  orgId = await provisionOrg(`srmem${STAMP}`, adminUserId);
  await execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."OrgMember" (id, "userId", "organizationId", role, "createdAt") VALUES ('${cuid()}', '${memberUserId}', '${orgId}', 'MEMBER', NOW())`,
  );
  // Projet dans l'org — le MEMBER n'a AUCUNE ligne ProjectMember → aucun accès.
  inaccessibleProjectId = cuid();
  await execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."Project" (id, name, slug, "organizationId", "createdAt") VALUES ('${inaccessibleProjectId}', 'psr', 'psr${STAMP}', '${orgId}', NOW())`,
  );
  member = await loginAs(MEMBER_EMAIL, MEMBER_PASSWORD, undefined, TENANT_SLUG);
});

// Le tenant de test est PARTAGÉ et plafonné à 5 sièges : un fichier qui
// sème un utilisateur sans le reprendre occupe un siège définitivement, et
// finit par faire échouer les invitations des autres en 403.
afterAll(async () => {
  await cleanupFixtures(STAMP);
});


describe("Demandes externes ouvertes aux membres", () => {
  it("un MEMBER crée une demande org-level (200)", async () => {
    const res = await createRequest(member, {
      label: "org-level par un membre",
      organizationId: orgId,
    });
    expect(res.status).toBe(201);
    const data = (await res.json()) as { id?: string };
    expect(data.id).toBeTruthy();
  });

  it("un MEMBER NE PEUT PAS scoper un projet inaccessible (403 — anti-escalade §4)", async () => {
    const res = await createRequest(member, {
      label: "scopée projet",
      organizationId: orgId,
      projectId: inaccessibleProjectId,
    });
    expect(res.status).toBe(403);
  });

  it("un MEMBER ne voit que SES demandes (pas celles d'un DEV+) + son org en cible", async () => {
    // Un DEV+ (admin OWNER) crée une demande dans la même org.
    const admin = await adminSession();
    const adminRes = await createRequest(admin, {
      label: "demande admin",
      organizationId: orgId,
    });
    expect(adminRes.status).toBe(201);
    const adminReqId = ((await adminRes.json()) as { id: string }).id;

    const listRes = await member.fetch("/api/secret-requests", {
      headers: { "x-forwarded-host": TENANT_HOST },
    });
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as {
      requests: Array<{ id: string; requestedByEmail: string }>;
      orgs: Array<{ id: string }>;
    };
    // La demande du DEV+ ne fuit PAS au membre.
    expect(list.requests.map((r) => r.id)).not.toContain(adminReqId);
    // Le membre voit ses propres demandes.
    expect(list.requests.every((r) => r.requestedByEmail === MEMBER_EMAIL)).toBe(
      true,
    );
    // Son org est proposée comme cible de création.
    expect(list.orgs.map((o) => o.id)).toContain(orgId);
  });
});
