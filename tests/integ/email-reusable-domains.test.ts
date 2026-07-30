// Sélecteur « réutiliser un domaine déjà configuré » (onglet Email).
//
// Le compte Physalis Email est par CLIENT, pas par organisation : lister les
// domaines du compte exposerait ceux des autres orgs du client. La liste est
// donc dérivée des `ProjectEmailConfig` LOCAUX, filtrés par
// `accessibleProjectsWhere` — ce test verrouille ce cloisonnement.
//
// Ne touche pas au relais : le filtrage est purement local (c'est justement
// pour ça qu'on ne part pas des `projectRef` du relais, qui sont un champ libre
// et le slug figé à l'enregistrement).

import { describe, it, expect, beforeAll , afterAll} from "vitest";
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
import { cleanupFixtures } from "./helpers/cleanup";

const SUFFIX = `${Date.now()}`;
const DENIS_EMAIL = `denis-reuse-${SUFFIX}@test.local`;
const DENIS_PASSWORD = "denisreusepassword12";
const ORG_A = `reuse-a-${SUFFIX}`;
const ORG_B = `reuse-b-${SUFFIX}`;

const TARGET = `cible-${SUFFIX}`; // le projet qu'on connecte
const SIBLING = `voisin-${SUFFIX}`; // même org, visible → réutilisable
const MASKED = `masque-${SUFFIX}`; // même org, hidden → PAS réutilisable
const OTHER_ORG = `autre-org-${SUFFIX}`; // org B → PAS réutilisable

const DOM_SIBLING = `voisin-${SUFFIX}.example`;
const DOM_MASKED = `masque-${SUFFIX}.example`;
const DOM_OTHER_ORG = `autreorg-${SUFFIX}.example`;

let denis: Session;
let adminUserId = "";
let denisUserId = "";

const cuid = () => "ck" + randomBytes(11).toString("hex");

async function provisionOrg(slug: string, ownerId: string): Promise<string> {
  const id = cuid();
  await execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."Organization" (id, name, slug, "createdAt")
     VALUES ('${id}', '${slug}', '${slug}', NOW())`,
  );
  await execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."OrgMember" (id, "userId", "organizationId", role, "createdAt")
     VALUES ('${cuid()}', '${ownerId}', '${id}', 'OWNER', NOW())`,
  );
  return id;
}

async function inviteDenis(orgId: string, invitedById: string, role: string) {
  const token = "iv_" + randomBytes(32).toString("hex");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const expiresAt = new Date(Date.now() + 3600_000)
    .toISOString()
    .replace("Z", "+00");
  await execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."Invitation" (id, email, "organizationId", role, "tokenHash", "expiresAt", "invitedById", "createdAt")
     VALUES ('${cuid()}', '${DENIS_EMAIL}', '${orgId}', '${role}', '${tokenHash}', '${expiresAt}', '${invitedById}', NOW())`,
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
      body: JSON.stringify({ password: DENIS_PASSWORD }),
    },
  );
  if (!res.ok) throw new Error(`register-and-accept failed: HTTP ${res.status}`);
}

async function seedProject(slug: string, orgId: string): Promise<string> {
  const id = cuid();
  await execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."Project" (id, name, slug, "organizationId", "createdAt")
     VALUES ('${id}', '${slug}', '${slug}', '${orgId}', NOW())`,
  );
  return id;
}

/** ProjectEmailConfig minimal : le sélecteur ne lit que domain/domainId/verified. */
async function seedEmailConfig(projectId: string, domain: string) {
  await execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."ProjectEmailConfig"
       (id, "projectId", domain, "domainId", "keyId", "encryptedKey", iv, tag, verified, "dnsRecords", "createdAt", "updatedAt")
     VALUES ('${cuid()}', '${projectId}', '${domain}', 'dom-${domain}', 'key-x',
             'fake-cipher', 'fake-iv-123456', 'fake-tag-1234', true, '[]'::jsonb, NOW(), NOW())`,
  );
}

beforeAll(async () => {
  await adminSession();
  adminUserId = (
    await execSql(
      `SELECT id FROM "${TENANT_SCHEMA}"."User" WHERE email = '${ADMIN_EMAIL}'`,
    )
  ).trim();

  const orgAId = await provisionOrg(ORG_A, adminUserId);
  const orgBId = await provisionOrg(ORG_B, adminUserId);

  await inviteDenis(orgAId, adminUserId, "DEV");
  denis = await loginAs(DENIS_EMAIL, DENIS_PASSWORD);
  denisUserId = (
    await execSql(
      `SELECT id FROM "${TENANT_SCHEMA}"."User" WHERE email = '${DENIS_EMAIL}'`,
    )
  ).trim();

  // Org A : la cible (sans config email), un voisin visible, un projet masqué.
  await seedProject(TARGET, orgAId);
  const siblingId = await seedProject(SIBLING, orgAId);
  const maskedId = await seedProject(MASKED, orgAId);
  await seedEmailConfig(siblingId, DOM_SIBLING);
  await seedEmailConfig(maskedId, DOM_MASKED);
  await execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."ProjectMember" (id, "userId", "projectId", role, hidden)
     VALUES ('${cuid()}', '${denisUserId}', '${maskedId}', 'EDITOR', true)`,
  );

  // Org B : Denis n'y est pas — son domaine ne doit jamais lui apparaître.
  const otherId = await seedProject(OTHER_ORG, orgBId);
  await seedEmailConfig(otherId, DOM_OTHER_ORG);
});

// Le tenant de test est PARTAGÉ et plafonné à 5 sièges : un fichier qui
// sème un utilisateur sans le reprendre occupe un siège définitivement, et
// finit par faire échouer les invitations des autres en 403.
afterAll(async () => {
  await cleanupFixtures(SUFFIX);
});


describe("domaines réutilisables — cloisonnement", () => {
  async function reusable(): Promise<string[]> {
    const res = await denis.fetch(`/api/projects/${TARGET}/email`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      connected: boolean;
      reusableDomains?: Array<{ domain: string }>;
    };
    expect(body.connected).toBe(false);
    return (body.reusableDomains ?? []).map((d) => d.domain);
  }

  it("propose le domaine d'un projet visible de la même org", async () => {
    expect(await reusable()).toContain(DOM_SIBLING);
  });

  it("ne propose PAS le domaine d'un projet masqué (hidden)", async () => {
    expect(await reusable()).not.toContain(DOM_MASKED);
  });

  it("ne propose PAS le domaine d'une autre organisation du client", async () => {
    // Le compte Physalis Email est partagé par tout le client : c'est
    // précisément la fuite que le filtrage local évite.
    expect(await reusable()).not.toContain(DOM_OTHER_ORG);
  });
});
