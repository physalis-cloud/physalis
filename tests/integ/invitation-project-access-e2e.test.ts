// #2-E — e2e invitation avec accès projet pré-attribués.
//
// Deux bouts de la chaîne :
//   1. POST /api/orgs/[slug]/members  → stocke projectAccess sur l'Invitation
//      (feature multi_users active sur le tenant test = SHARED).
//   2. POST /api/invitations/[token]/register-and-accept → applique les
//      ProjectMember à l'acceptation (applyInvitationProjectAccess), en
//      filtrant tout projet n'appartenant pas à l'org.
//   3. POST /api/invitations/[token] (compte EXISTANT, lien e-mail) → idem.
//      Ajouté le 2026-08-09 : ce chemin n'appliquait PAS les accès projet, et
//      c'était précisément le seul des trois qu'aucun test n'exerçait. Le
//      défaut était muet — l'invité rejoignait bien l'org, sans aucun accès.

import { describe, it, expect, beforeAll , afterAll} from "vitest";
import { randomBytes, createHash } from "node:crypto";
import { execSql, execSqlValue } from "./helpers/db";
import {
  adminSession,
  loginAs,
  BASE_URL,
  TENANT_SCHEMA,
  TENANT_HOST,
  ADMIN_EMAIL,
  type Session,
} from "./helpers/api";
import { provisionOrg, seedInvitation, cuid } from "./helpers/org";
import { cleanupFixtures } from "./helpers/cleanup";

const STAMP = Date.now();
const ORG_SLUG = `ipae${STAMP}`;
// Le 3ᵉ cas a besoin de DEUX orgs à lui :
//   - BOOT : y faire naître l'invité, pour qu'il EXISTE sans être membre de la
//     cible (sinon l'acceptation n'est plus une 1ʳᵉ acceptation et les accès
//     projet sont sautés, à dessein) ;
//   - LINK : la cible, avec ses propres projets.
// Pourquoi pas ORG_SLUG comme cible : `Organization.maxSeats` vaut 2 par défaut
// et ORG_SLUG est déjà plein (admin + l'invité du cas précédent) → 403. C'est le
// produit qui a raison ; on ne relève pas un quota pour faire passer un test.
const ORG_BOOT_SLUG = `ipaeB${STAMP}`;
const ORG_LINK_SLUG = `ipaeL${STAMP}`;
// 4ᵉ cas : invité DEV, dont l'accès par défaut est TOUT (règle 4). Org dédiée
// pour la même raison de sièges que ci-dessus.
const ORG_DEV_SLUG = `ipaed${STAMP}`;
const PROJ_E = `ipaee${STAMP}`;
const PROJ_F = `ipaef${STAMP}`;
const PROJ_C = `ipaeC${STAMP}`;
const PROJ_D = `ipaeD${STAMP}`;
const PROJ_A = `ipaeA${STAMP}`;
const PROJ_B = `ipaeB${STAMP}`;
const HDR = { "content-type": "application/json", "x-forwarded-host": TENANT_HOST };

let admin: Session;
let adminUserId: string;
let orgId: string;
let orgBootId: string;
let orgLinkId: string;
let orgDevId: string;
let projCId: string;
let projDId: string;
let projAId: string;
let projBId: string;
let projEId: string;
let projFId: string;

const q = (sql: string) => execSqlValue(sql);

beforeAll(async () => {
  adminUserId = await q(
    `SELECT id FROM "${TENANT_SCHEMA}"."User" WHERE email='${ADMIN_EMAIL}'`,
  );
  orgId = await provisionOrg(ORG_SLUG, adminUserId); // admin = OWNER
  orgBootId = await provisionOrg(ORG_BOOT_SLUG, adminUserId);
  orgLinkId = await provisionOrg(ORG_LINK_SLUG, adminUserId);
  orgDevId = await provisionOrg(ORG_DEV_SLUG, adminUserId);
  projCId = cuid();
  projDId = cuid();
  projAId = cuid();
  projBId = cuid();
  projEId = cuid();
  projFId = cuid();
  await execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."Project" (id, name, slug, "organizationId", "createdAt") VALUES ('${projAId}', 'A', '${PROJ_A}', '${orgId}', NOW()), ('${projBId}', 'B', '${PROJ_B}', '${orgId}', NOW())`,
  );
  await execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."Project" (id, name, slug, "organizationId", "createdAt") VALUES ('${projCId}', 'C', '${PROJ_C}', '${orgLinkId}', NOW()), ('${projDId}', 'D', '${PROJ_D}', '${orgLinkId}', NOW())`,
  );
  await execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."Project" (id, name, slug, "organizationId", "createdAt") VALUES ('${projEId}', 'E', '${PROJ_E}', '${orgDevId}', NOW()), ('${projFId}', 'F', '${PROJ_F}', '${orgDevId}', NOW())`,
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

  // Le trou trouvé le 2026-08-09. Chemin distinct du précédent : le compte
  // existe déjà, l'invité est connecté, il ouvre le lien reçu par e-mail.
  it("l'acceptation par lien e-mail (compte existant) crée aussi les ProjectMember", async () => {
    const email = `ipae-link-${STAMP}@test.local`;
    const password = "accept-link-e2e-password-123";

    // 1. Faire EXISTER l'invité sans le rendre membre de ORG_SLUG : on le crée
    //    via une invitation sur une AUTRE org, sans accès projet.
    const bootstrapToken = await seedInvitation(orgBootId, email, "MEMBER", adminUserId);
    const reg = await fetch(
      `${BASE_URL}/api/invitations/${bootstrapToken}/register-and-accept`,
      { method: "POST", headers: HDR, body: JSON.stringify({ password }) },
    );
    expect(reg.status).toBe(200);
    const userId = await q(
      `SELECT id FROM "${TENANT_SCHEMA}"."User" WHERE email='${email}'`,
    );
    expect(userId).not.toBe("");

    // Témoin : à ce stade il n'a AUCUN accès projet. Sans ce contrôle, un test
    // vert ne distinguerait pas « les accès ont été créés » de « ils étaient
    // déjà là ».
    const before = await q(
      `SELECT count(*) FROM "${TENANT_SCHEMA}"."ProjectMember" WHERE "userId"='${userId}'`,
    );
    expect(before).toBe("0");

    // 2. L'inviter dans ORG_SLUG avec des accès projet pré-cochés.
    const token = "iv_" + randomBytes(32).toString("hex");
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000)
      .toISOString()
      .replace("Z", "+00");
    const bogusProjectId = cuid();
    const projectAccess = JSON.stringify([
      { projectId: projCId, role: "EDITOR" },
      { projectId: projDId, role: "VIEWER" },
      { projectId: bogusProjectId, role: "OWNER" },
    ]);
    await execSql(
      `INSERT INTO "${TENANT_SCHEMA}"."Invitation" (id, email, "organizationId", role, "tokenHash", "expiresAt", "invitedById", "projectAccess", "createdAt") VALUES ('${cuid()}', '${email}', '${orgLinkId}', 'MEMBER', '${tokenHash}', '${expiresAt}', '${adminUserId}', '${projectAccess}'::jsonb, NOW())`,
    );

    // 3. Il se connecte et accepte depuis le lien.
    const invitee = await loginAs(email, password);
    const res = await invitee.fetch(`/api/invitations/${token}`, {
      method: "POST",
      headers: HDR,
    });
    expect(res.status).toBe(200);

    // OrgMember créé dans l'org cible.
    const orgRole = await q(
      `SELECT role FROM "${TENANT_SCHEMA}"."OrgMember" WHERE "userId"='${userId}' AND "organizationId"='${orgLinkId}'`,
    );
    expect(orgRole).toBe("MEMBER");

    // Le jeton est consommé (atomicité F5.1 : les deux ou aucun).
    const accepted = await q(
      `SELECT ("acceptedAt" IS NOT NULL)::text FROM "${TENANT_SCHEMA}"."Invitation" WHERE "tokenHash"='${tokenHash}'`,
    );
    expect(accepted).toBe("true");

    // ProjectMember : A=EDITOR, B=VIEWER (hidden=false), bogus filtré.
    const rows = await execSql(
      `SELECT "projectId", role, hidden FROM "${TENANT_SCHEMA}"."ProjectMember" WHERE "userId"='${userId}' ORDER BY "projectId"`,
    );
    const parsed = rows
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [projectId, role, hidden] = l.split("|");
        return { projectId, role, hidden };
      });
    expect(parsed).toHaveLength(2);
    expect(parsed.find((r) => r.projectId === projCId)).toEqual({
      projectId: projCId,
      role: "EDITOR",
      hidden: "f",
    });
    expect(parsed.find((r) => r.projectId === projDId)).toEqual({
      projectId: projDId,
      role: "VIEWER",
      hidden: "f",
    });
    expect(parsed.find((r) => r.projectId === bogusProjectId)).toBeUndefined();
  });

  // Un invité DEV arrive avec l'EDITOR implicite sur TOUS les projets de l'org
  // (règle 4). Pré-cocher des projets ne suffit donc pas à le cantonner : sans
  // `NONE`, tout nouveau dev démarre avec l'accès à tout.
  it("un invité DEV pré-bloqué sur un projet arrive avec la barrière posée", async () => {
    const email = `ipae-dev-${STAMP}@test.local`;
    const password = "accept-dev-e2e-password-123";

    const res = await admin.fetch(`/api/orgs/${ORG_DEV_SLUG}/members`, {
      method: "POST",
      headers: HDR,
      body: JSON.stringify({
        email,
        role: "DEV",
        projectAccess: [
          { projectId: projEId, role: "NONE" },
          { projectId: projFId, role: "EDITOR" },
        ],
      }),
    });
    expect(res.status).toBe(201);

    // Le `NONE` a bien traversé le stockage (parse défensif inclus).
    const stored = await q(
      `SELECT "projectAccess"::text FROM "${TENANT_SCHEMA}"."Invitation" WHERE email='${email}' AND "organizationId"='${orgDevId}'`,
    );
    expect(JSON.parse(stored)).toEqual(
      expect.arrayContaining([{ projectId: projEId, role: "NONE" }]),
    );

    // Le token en clair n'existe que dans l'e-mail : on repose un hash connu
    // sur l'invitation que l'API vient de créer, pour pouvoir l'accepter.
    const token = "iv_" + randomBytes(32).toString("hex");
    const tokenHash = createHash("sha256").update(token).digest("hex");
    await execSql(
      `UPDATE "${TENANT_SCHEMA}"."Invitation" SET "tokenHash"='${tokenHash}' WHERE email='${email}' AND "organizationId"='${orgDevId}'`,
    );

    const reg = await fetch(
      `${BASE_URL}/api/invitations/${token}/register-and-accept`,
      { method: "POST", headers: HDR, body: JSON.stringify({ password }) },
    );
    expect(reg.status).toBe(200);

    const userId = await q(
      `SELECT id FROM "${TENANT_SCHEMA}"."User" WHERE email='${email}'`,
    );
    const rows = await execSql(
      `SELECT "projectId", role, hidden FROM "${TENANT_SCHEMA}"."ProjectMember" WHERE "userId"='${userId}'`,
    );
    const parsed = rows
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [projectId, role, hidden] = l.split("|");
        return { projectId, role, hidden };
      });
    // E : barrière. F : AUCUNE ligne — l'EDITOR implicite du DEV suffit, et
    // figer une ligne explicite lui survivrait à une rétrogradation.
    expect(parsed).toEqual([
      { projectId: projEId, role: "VIEWER", hidden: "t" },
    ]);
  });
});
