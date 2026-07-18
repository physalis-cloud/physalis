// Le flag `ProjectMember.hidden` est une BARRIÈRE D'ACCÈS, pas un confort
// d'affichage : `requireProjectMember` répond 403 sur un projet masqué (règle 2),
// et `audit` + `secret-requests` l'appliquent déjà. Ce test verrouille le fait
// qu'on ne peut pas en sortir par un token.
//
// Le contournement (découvert 2026-07-17) :
//   ① GET /api/orgs/<org>/projects            → le projet masqué apparaît
//      (le sélecteur filtre `some: { userId }`, sans lire `hidden`)
//   ② POST /api/orgs/<org>/org-tokens          → accepté
//      (`devMemberProjectIds` se construit sans filtrer `hidden`, donc
//       validateDevTokenCreation croit le DEV légitime)
//   ③ GET /api/integrations/credentials        → 200 + secrets déchiffrés
//      → un DEV lit les secrets d'un projet que l'UI lui refuse.
//
// Ce que ce test NE couvre pas, par décision : un OrgToken déjà émis avant le
// correctif continue de fonctionner (un token d'org n'est pas un proxy des
// droits mouvants de son créateur — le blocage est à l'émission). Le repérage
// des tokens hérités est confié à un script d'audit, pas à un 403 au runtime.

import { describe, it, expect, beforeAll } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import {
  Session,
  adminSession,
  loginAs,
  postJson,
  patchJson,
  BASE_URL,
  ADMIN_EMAIL,
  TENANT_SCHEMA,
  TENANT_HOST,
} from "./helpers/api";
import { execSql } from "./helpers/db";

const SUFFIX = `${Date.now()}`;
const DENIS_EMAIL = `denis-hidden-${SUFFIX}@test.local`;
const DENIS_PASSWORD = "denistestpassword12";
const ORG_SLUG = `hidden-org-${SUFFIX}`;
const HIDDEN_PROJECT_SLUG = `projet-sensible-${SUFFIX}`;
const VISIBLE_PROJECT_SLUG = `projet-ouvert-${SUFFIX}`;

let denis: Session;
let adminUserId = "";
let denisUserId = "";
let orgId = "";
let hiddenProjectId = "";
let visibleProjectId = "";

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

async function inviteDenisAsDev(orgId: string, invitedById: string) {
  const token = "iv_" + randomBytes(32).toString("hex");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const expiresAt = new Date(Date.now() + 3600_000)
    .toISOString()
    .replace("Z", "+00");
  await execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."Invitation" (id, email, "organizationId", role, "tokenHash", "expiresAt", "invitedById", "createdAt")
     VALUES ('${cuid()}', '${DENIS_EMAIL}', '${orgId}', 'DEV', '${tokenHash}', '${expiresAt}', '${invitedById}', NOW())`,
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

/** Ligne ProjectMember explicite — `hidden: true` = projet masqué pour ce user. */
async function seedMembership(
  userId: string,
  projectId: string,
  hidden: boolean,
) {
  await execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."ProjectMember" (id, "userId", "projectId", role, hidden)
     VALUES ('${cuid()}', '${userId}', '${projectId}', 'EDITOR', ${hidden})`,
  );
}

async function seedEnvironment(projectId: string, name: string) {
  await execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."Environment" (id, name, "projectId")
     VALUES ('${cuid()}', '${name}', '${projectId}')`,
  );
}

/** Collection de coffre d'équipe scopée projet — cible de déplacement. */
async function seedTeamCollection(
  projectId: string,
  slug: string,
): Promise<void> {
  await execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."TeamVaultCollection"
       (id, "projectId", name, slug, "createdAt", "updatedAt")
     VALUES ('${cuid()}', '${projectId}', '${slug}', '${slug}', NOW(), NOW())`,
  );
}

/** Entrée de coffre PERSO appartenant à `userId` — source de déplacement. */
async function seedPersonalEntry(
  userId: string,
  name: string,
): Promise<string> {
  const id = cuid();
  await execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."VaultEntry"
       (id, "userId", name, "createdAt", "updatedAt")
     VALUES ('${id}', '${userId}', '${name}', NOW(), NOW())`,
  );
  return id;
}

/** SecretRequest soumise, ciblant (projectId, envName, key) — prête à importer. */
async function seedSecretRequest(
  projectId: string,
  envName: string,
): Promise<string> {
  const id = cuid();
  const tokenHash = createHash("sha256")
    .update(`sr-${cuid()}`)
    .digest("hex");
  await execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."SecretRequest"
       (id, "tokenHash", label, "requestedByEmail", "organizationId",
        "projectId", "environmentName", "secretKey", "publicKeyJwk",
        "expiresAt", "submittedAt")
     VALUES ('${id}', '${tokenHash}', 'req ${id}', '${ADMIN_EMAIL}', '${orgId}',
        '${projectId}', '${envName}', 'TEST_KEY', '{}',
        NOW() + interval '7 days', NOW())`,
  );
  return id;
}

beforeAll(async () => {
  await adminSession();
  adminUserId = (
    await execSql(
      `SELECT id FROM "${TENANT_SCHEMA}"."User" WHERE email = '${ADMIN_EMAIL}'`,
    )
  ).trim();
  if (!adminUserId) throw new Error("Admin user not found");

  orgId = await provisionOrg(ORG_SLUG, adminUserId);
  await inviteDenisAsDev(orgId, adminUserId);
  denis = await loginAs(DENIS_EMAIL, DENIS_PASSWORD);

  denisUserId = (
    await execSql(
      `SELECT id FROM "${TENANT_SCHEMA}"."User" WHERE email = '${DENIS_EMAIL}'`,
    )
  ).trim();
  if (!denisUserId) throw new Error("Denis user not found");

  // Denis a bossé sur les deux projets — l'admin en a masqué un seul.
  hiddenProjectId = await seedProject(HIDDEN_PROJECT_SLUG, orgId);
  visibleProjectId = await seedProject(VISIBLE_PROJECT_SLUG, orgId);
  await seedMembership(denisUserId, hiddenProjectId, true);
  await seedMembership(denisUserId, visibleProjectId, false);
  // Un environnement "production" dans chaque projet (cible d'import).
  await seedEnvironment(hiddenProjectId, "production");
  await seedEnvironment(visibleProjectId, "production");
  // Une collection d'équipe dans chaque projet (cible de déplacement).
  await seedTeamCollection(hiddenProjectId, "coffre-equipe");
  await seedTeamCollection(visibleProjectId, "coffre-equipe");
});

describe("hidden — la barrière tient dans l'UI", () => {
  it("refuse à Denis le projet masqué (sanity : la règle 2 s'applique)", async () => {
    const res = await denis.fetch(`/api/projects/${HIDDEN_PROJECT_SLUG}`);
    expect(res.status).toBe(403);
  });

  it("laisse passer le projet non masqué (sanity : pas de sur-restriction)", async () => {
    const res = await denis.fetch(`/api/projects/${VISIBLE_PROJECT_SLUG}`);
    expect(res.status).toBe(200);
  });
});

describe("hidden — non contournable par un OrgToken", () => {
  it("① ne propose pas le projet masqué dans le sélecteur", async () => {
    const res = await denis.fetch(`/api/orgs/${ORG_SLUG}/projects`);
    expect(res.status).toBe(200);
    const { projects } = (await res.json()) as {
      projects: Array<{ id: string; slug: string }>;
    };
    const slugs = projects.map((p) => p.slug);
    expect(slugs).toContain(VISIBLE_PROJECT_SLUG);
    expect(slugs).not.toContain(HIDDEN_PROJECT_SLUG);
  });

  it("② refuse la création d'un token autorisant le projet masqué", async () => {
    const res = await postJson(denis, `/api/orgs/${ORG_SLUG}/org-tokens`, {
      name: `bypass-${SUFFIX}`,
      scopes: ["SECRETS_READ"],
      allowedProjectIds: [hiddenProjectId],
      expiresInDays: 30,
    });
    expect(res.status).toBe(403);
  });

  it("② bis autorise le projet non masqué (garde anti sur-restriction)", async () => {
    const res = await postJson(denis, `/api/orgs/${ORG_SLUG}/org-tokens`, {
      name: `legit-${SUFFIX}`,
      scopes: ["SECRETS_READ"],
      allowedProjectIds: [visibleProjectId],
      expiresInDays: 30,
    });
    expect(res.status).toBe(201);
  });

  it("② ter refuse d'ÉTENDRE un token existant vers le projet masqué", async () => {
    const created = await postJson(denis, `/api/orgs/${ORG_SLUG}/org-tokens`, {
      name: `extend-${SUFFIX}`,
      scopes: ["SECRETS_READ"],
      allowedProjectIds: [visibleProjectId],
      expiresInDays: 30,
    });
    expect(created.status).toBe(201);
    const { orgToken } = (await created.json()) as { orgToken: { id: string } };

    const res = await patchJson(
      denis,
      `/api/orgs/${ORG_SLUG}/org-tokens/${orgToken.id}`,
      { allowedProjectIds: [visibleProjectId, hiddenProjectId] },
    );
    expect(res.status).toBe(403);
  });

  // Type confusion : `expiresInDays` vient de readJson non typé. La garde DEV
  // utilisait `> 90` (`"abc" > 90` = false → passait) et la persistance
  // `typeof === "number"` (→ expiresAt = null) → un DEV postant `"abc"`
  // obtenait un token ÉTERNEL, contournant maxExpiresInDays. Le projet est
  // VISIBLE : on isole la faille d'expiration, pas le filtre hidden.
  it("② quater refuse une expiration non numérique (pas de token DEV éternel)", async () => {
    const res = await postJson(denis, `/api/orgs/${ORG_SLUG}/org-tokens`, {
      name: `eternal-${SUFFIX}`,
      scopes: ["SECRETS_READ"],
      allowedProjectIds: [visibleProjectId],
      expiresInDays: "abc",
    });
    expect(res.status).toBe(400);
  });

  it("② quinquies refuse une expiration DEV au-delà de la borne (sanity)", async () => {
    const res = await postJson(denis, `/api/orgs/${ORG_SLUG}/org-tokens`, {
      name: `toolong-${SUFFIX}`,
      scopes: ["SECRETS_READ"],
      allowedProjectIds: [visibleProjectId],
      expiresInDays: 365,
    });
    expect(res.status).toBe(400);
  });
});

describe("hidden — non contournable par un token utilisateur", () => {
  // Un UserToken agit AU NOM de Denis : il ne doit pas lui ouvrir ce que l'UI
  // lui ferme. Le contrôle `ctx.kind === "user"` de l'API intégrations se
  // contentait de vérifier l'EXISTENCE d'une ligne ProjectMember.
  it("③ refuse les credentials du projet masqué", async () => {
    const created = await postJson(denis, `/api/user-tokens`, {
      name: `denis-token-${SUFFIX}`,
      expiresInDays: 30,
    });
    expect(created.status).toBe(201);
    const { token } = (await created.json()) as { token: string };

    const res = await fetch(
      `${BASE_URL}/api/integrations/credentials?project=${HIDDEN_PROJECT_SLUG}&type=service`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(res.status).toBe(403);
  });

  it("③ bis accorde les credentials du projet non masqué (sanity)", async () => {
    const created = await postJson(denis, `/api/user-tokens`, {
      name: `denis-token-ok-${SUFFIX}`,
      expiresInDays: 30,
    });
    expect(created.status).toBe(201);
    const { token } = (await created.json()) as { token: string };

    const res = await fetch(
      `${BASE_URL}/api/integrations/credentials?project=${VISIBLE_PROJECT_SLUG}&type=service`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(res.status).toBe(200);
  });
});

describe("hidden — non contournable par l'export RGPD", () => {
  // /api/me/export DÉCHIFFRE les secrets par conception (portabilité art. 20) —
  // c'était le seul endpoint du code à déchiffrer ET à ne pas lire `hidden`.
  // Pas de token à émettre, pas de sélecteur à traverser : un GET suffisait.
  // Son en-tête énonce pourtant le contrat qu'il violait : « juste de SES
  // données et de ce qu'il voit » — un projet masqué est ce qu'il ne voit pas.
  //
  // Rate-limit : 1 export / 15 min / user → UNE seule requête possible, donc
  // l'attaque ET le sanity anti sur-restriction vivent dans le MÊME test.
  it("④ n'exporte pas le projet masqué, exporte le projet visible", async () => {
    const res = await denis.fetch(`/api/me/export`);
    expect(res.status).toBe(200);
    const dump = (await res.json()) as {
      projects: Array<{ slug: string }>;
      environments: Array<{
        projectId: string;
        secrets: Array<{ key: string; value: string }>;
      }>;
    };

    const slugs = dump.projects.map((p) => p.slug);
    expect(slugs).toContain(VISIBLE_PROJECT_SLUG);
    expect(slugs).not.toContain(HIDDEN_PROJECT_SLUG);

    // Le vrai enjeu n'est pas le nom du projet mais ses secrets en clair :
    // `environments` est dérivé de la même liste d'ids.
    const envProjectIds = dump.environments.map((e) => e.projectId);
    expect(envProjectIds).not.toContain(hiddenProjectId);
  });
});

// Importer un secret ÉCRIT dans un projet. L'ancienne garde ne vérifiait que
// l'appartenance à l'org (OWNER/ADMIN/DEV), sans lire `hidden` → un DEV masqué
// du projet cible pouvait écrire un secret dans un projet que l'UI lui ferme.
// Le fix passe par requireEnvironment(EDITOR) = la garde d'écriture standard.
describe("hidden — non contournable par import de secret-request", () => {
  it("⑤ refuse à Denis (DEV masqué) l'import dans le projet masqué", async () => {
    const srId = await seedSecretRequest(hiddenProjectId, "production");
    const res = await postJson(
      denis,
      `/api/secret-requests/${srId}/import`,
      { value: "injected-by-hidden-dev" },
    );
    expect(res.status).toBe(403);
  });

  it("⑤ bis autorise l'import dans le projet visible (anti sur-restriction)", async () => {
    const srId = await seedSecretRequest(visibleProjectId, "production");
    const res = await postJson(
      denis,
      `/api/secret-requests/${srId}/import`,
      { value: "legit-value" },
    );
    expect(res.status).toBe(200);
  });
});

// Déplacer une entrée perso vers une collection d'équipe ÉCRIT dans le projet.
// resolveTarget re-dérivait le rôle depuis ProjectMember sans lire `hidden` → un
// DEV masqué du projet cible (EDITOR masqué) pouvait injecter une entrée dans un
// projet que l'UI lui ferme. Denis est OrgDEV : il a une ligne EDITOR sur les
// deux projets (masquée sur l'un). Le fallback DEV implicite ne doit PAS
// rattraper la ligne masquée (règle 2 prime sur règle 4).
describe("hidden — non contournable par déplacement d'entrée (vault move)", () => {
  it("⑥ refuse à Denis de déplacer une entrée vers le projet masqué", async () => {
    const entryId = await seedPersonalEntry(denisUserId, "creds-a-injecter");
    const res = await postJson(denis, `/api/vault/entries/${entryId}/move`, {
      target: "team_project",
      projectSlug: HIDDEN_PROJECT_SLUG,
      collectionSlug: "coffre-equipe",
    });
    expect([403, 404]).toContain(res.status);
  });

  it("⑥ bis autorise le déplacement vers le projet visible (anti sur-restriction)", async () => {
    const entryId = await seedPersonalEntry(denisUserId, "creds-legit");
    const res = await postJson(denis, `/api/vault/entries/${entryId}/move`, {
      target: "team_project",
      projectSlug: VISIBLE_PROJECT_SLUG,
      collectionSlug: "coffre-equipe",
    });
    expect(res.status).toBe(200);
  });

  // Second cas du même endpoint : convertir l'entrée perso en Compte de projet
  // (AppAccount). Même garde inline re-dérivée, même faille sans `hidden`.
  it("⑥ ter refuse la conversion en compte du projet masqué", async () => {
    const entryId = await seedPersonalEntry(denisUserId, "compte-a-injecter");
    const res = await postJson(denis, `/api/vault/entries/${entryId}/move`, {
      target: "project_account",
      projectSlug: HIDDEN_PROJECT_SLUG,
    });
    expect([403, 404]).toContain(res.status);
  });

  it("⑥ quater autorise la conversion dans le projet visible (anti sur-restriction)", async () => {
    const entryId = await seedPersonalEntry(denisUserId, "compte-legit");
    const res = await postJson(denis, `/api/vault/entries/${entryId}/move`, {
      target: "project_account",
      projectSlug: VISIBLE_PROJECT_SLUG,
    });
    expect(res.status).toBe(200);
  });
});
