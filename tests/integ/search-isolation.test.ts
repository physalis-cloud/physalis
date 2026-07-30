// Test isolation des listings/recherches : aucun endpoint de listing ne
// doit remonter des données d'orgs où l'user n'est pas membre.
//
// Couvre proposal Secrets #6 (recherche cross-org leak) — étendu aux
// endpoints de listing courants car le codebase n'a pas de recherche
// globale. La règle générique testée : "les listings sont scopés
// strictement par membership".
//
// Setup : orgA + orgB, chaque avec un projet portant un marqueur unique.
// Bob est membre d'orgA uniquement. Bob list :
//   - /api/projects → uniquement projet orgA
//   - /api/projects?org=<slugB> → 404 (cf. #3 IDOR mais re-vérifié ici)
//   - /api/orgs → uniquement orgA
//
// Bonus : le marqueur unique dans le nom du projet permet de grep la
// réponse JSON entière → catche tout leak via un champ inattendu.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import {
  Session,
  adminSession,
  loginAs,
  BASE_URL,
  ADMIN_EMAIL,
  TENANT_SCHEMA,
  TENANT_HOST,
} from "./helpers/api";
import { execSql } from "./helpers/db";

const SUFFIX = `${Date.now()}`;
const BOB_EMAIL = `bob-search-${SUFFIX}@test.local`;
const BOB_PASSWORD = "bobtestpassword12";
const ORG_A_SLUG = `search-a-${SUFFIX}`;
const ORG_B_SLUG = `search-b-${SUFFIX}`;
const PROJECT_A_MARKER = `project-a-secret-marker-${SUFFIX}`;
const PROJECT_B_MARKER = `project-b-secret-marker-${SUFFIX}`;

let admin: Session;
let bob: Session;
let orgAId = "";
let orgBId = "";
let adminUserId = "";

async function provisionOrg(slug: string, ownerId: string): Promise<string> {
  const id = "ck" + randomBytes(11).toString("hex");
  await execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."Organization" (id, name, slug, "createdAt")
     VALUES ('${id}', '${slug}', '${slug}', NOW())`,
  );
  const memberId = "ck" + randomBytes(11).toString("hex");
  await execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."OrgMember" (id, "userId", "organizationId", role, "createdAt")
     VALUES ('${memberId}', '${ownerId}', '${id}', 'OWNER', NOW())`,
  );
  return id;
}

async function provisionProject(orgId: string, slugAndName: string) {
  const id = "ck" + randomBytes(11).toString("hex");
  await execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."Project" (id, slug, name, "organizationId", "createdAt")
     VALUES ('${id}', '${slugAndName}', '${slugAndName}', '${orgId}', NOW())`,
  );
  return id;
}

/**
 * Bob est invité en **DEV**, pas en MEMBER.
 *
 * Ce test portait sur l'isolation CROSS-ORG, mais invitait Bob en MEMBER sans
 * lui donner de ligne `ProjectMember`, puis attendait qu'il voie le projet de
 * son org. C'était le comportement d'AVANT le durcissement v1.8.0, où
 * `/api/projects` ne filtrait que par org — « tout MEMBER voyait les noms et
 * slugs de TOUS les projets, y compris ceux masqués pour lui ». Depuis, la
 * règle 5 s'applique : un MEMBER sans ligne explicite ne voit rien, et le test
 * échouait sans que personne le remarque.
 *
 * DEV est le rôle qui correspond à l'intention d'origine : membre légitime de
 * l'org A, donc il en voit les projets non masqués (règle 4), tout en restant
 * étranger à l'org B — ce que ces tests vérifient réellement.
 */
async function inviteBobToOrg(orgId: string, invitedById: string) {
  const token = "iv_" + randomBytes(32).toString("hex");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const id = "ck" + randomBytes(11).toString("hex");
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000)
    .toISOString()
    .replace("Z", "+00");
  await execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."Invitation" (id, email, "organizationId", role, "tokenHash", "expiresAt", "invitedById", "createdAt")
     VALUES ('${id}', '${BOB_EMAIL}', '${orgId}', 'DEV', '${tokenHash}', '${expiresAt}', '${invitedById}', NOW())`,
  );
  const res = await fetch(
    `${BASE_URL}/api/invitations/${token}/register-and-accept`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-host": TENANT_HOST,
        "x-forwarded-for": `203.0.113.${Math.floor(Math.random() * 254) + 1}`,
      },
      body: JSON.stringify({ password: BOB_PASSWORD }),
    },
  );
  if (!res.ok) throw new Error(`register-and-accept failed: HTTP ${res.status}`);
}

beforeAll(async () => {
  admin = await adminSession();
  adminUserId = (
    await execSql(`SELECT id FROM "${TENANT_SCHEMA}"."User" WHERE email = '${ADMIN_EMAIL}'`)
  ).trim();
  if (!adminUserId) throw new Error("Admin user not found");

  orgAId = await provisionOrg(ORG_A_SLUG, adminUserId);
  orgBId = await provisionOrg(ORG_B_SLUG, adminUserId);
  await provisionProject(orgAId, PROJECT_A_MARKER);
  await provisionProject(orgBId, PROJECT_B_MARKER);

  await inviteBobToOrg(orgAId, adminUserId);
  bob = await loginAs(BOB_EMAIL, BOB_PASSWORD);
});

afterAll(async () => {
  await execSql(`DELETE FROM "${TENANT_SCHEMA}"."User" WHERE email = '${BOB_EMAIL}'`);
  await execSql(
    `DELETE FROM "${TENANT_SCHEMA}"."Project" WHERE slug IN ('${PROJECT_A_MARKER}', '${PROJECT_B_MARKER}')`,
  );
  await execSql(
    `DELETE FROM "${TENANT_SCHEMA}"."Organization" WHERE slug IN ('${ORG_A_SLUG}', '${ORG_B_SLUG}')`,
  );
});

describe("Listings cross-org isolation (Secrets #6)", () => {
  describe("/api/projects (listing scopé à l'org courante)", () => {
    it("Bob avec org=A voit projet A, pas projet B", async () => {
      const res = await bob.fetch(
        `/api/projects?org=${ORG_A_SLUG}`,
      );
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain(PROJECT_A_MARKER);
      expect(body).not.toContain(PROJECT_B_MARKER);
    });

    it("Bob avec org=B (où il n'est pas membre) → 404", async () => {
      const res = await bob.fetch(
        `/api/projects?org=${ORG_B_SLUG}`,
      );
      expect([403, 404]).toContain(res.status);
    });

    it("Bob sans param org → ne voit que les projets de SES orgs", async () => {
      const res = await bob.fetch("/api/projects");
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).not.toContain(PROJECT_B_MARKER);
    });
  });

  describe("/api/orgs (listing org-level)", () => {
    it("Bob ne voit que ses orgs (pas orgB)", async () => {
      const res = await bob.fetch("/api/orgs");
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain(ORG_A_SLUG);
      expect(body).not.toContain(ORG_B_SLUG);
    });
  });

  describe("Filtre admin global ne bypass pas le scoping", () => {
    it("Admin (OWNER des 2 orgs) voit légitimement les 2 projets", async () => {
      // Admin est OWNER d'orgA et orgB → doit voir A et B individuellement.
      // Sanity : confirme que le test discrimine bien la membership.
      const resA = await admin.fetch(
        `/api/projects?org=${ORG_A_SLUG}`,
      );
      const bodyA = await resA.text();
      expect(bodyA).toContain(PROJECT_A_MARKER);

      const resB = await admin.fetch(
        `/api/projects?org=${ORG_B_SLUG}`,
      );
      const bodyB = await resB.text();
      expect(bodyB).toContain(PROJECT_B_MARKER);
    });
  });

  describe("Recherche directe par slug projet → 404", () => {
    it("Bob GET /api/projects/<slugB> (projet d'orgB) → 404", async () => {
      const res = await bob.fetch(`/api/projects/${PROJECT_B_MARKER}`);
      expect([403, 404]).toContain(res.status);
    });
  });
});
