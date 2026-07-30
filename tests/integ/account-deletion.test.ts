// Suppression de compte — cycle de vie complet contre la stack live.
//
// POURQUOI CE FICHIER : ce chantier a produit beaucoup de code livré et jamais
// exercé, et c'est exactement là qu'il cachait un défaut bloquant (le webhook
// Stripe écrasait PENDING_DELETION → aucun compte payant n'était jamais purgé,
// silencieusement, cf. lib/deletion-window.ts). Les règles pures sont couvertes
// par les tests unit ; ici on vérifie que le CÂBLAGE tient contre la vraie
// stack : endpoints, gardes, colonnes, et purge par le cron.
//
// ⚠️ SÛRETÉ — ce test manipule des chemins DESTRUCTEURS. Deux règles tenues :
//
//  1. Il ne crée et ne détruit QUE des utilisateurs jetables du tenant de test.
//     Jamais le tenant lui-même : un `DROP SCHEMA client_test` casserait toute
//     la suite d'intégration.
//  2. Le parcours de suppression du CLIENT n'est exercé que par ses chemins
//     NÉGATIFS (403 / 400 / 409), qui échouent tous AVANT la moindre écriture.
//     Le chemin positif poserait PENDING_DELETION sur le tenant partagé et
//     annulerait son abonnement Stripe — hors de question ici ; il relève d'un
//     tenant jetable dédié (cf. suppression-compte.md §Tests).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes, createHash } from "node:crypto";
import {
  Session,
  adminSession,
  loginAs,
  postJson,
  BASE_URL,
  TENANT_SCHEMA,
  TENANT_HOST,
} from "./helpers/api";
import { execSql } from "./helpers/db";

const execAsync = promisify(exec);
const SUFFIX = `${Date.now()}`;
const VICTIM_EMAIL = `deletion-victim-${SUFFIX}@test.local`;
const VICTIM_PASSWORD = "deletiontestpassword12";
const ORG_SLUG = `deletion-org-${SUFFIX}`;

let victim: Session;
let victimId = "";
let adminId = "";
let orgId = "";
let primaryOrgId = "";

const cuid = () => "ck" + randomBytes(11).toString("hex");

const sql = (s: string) => s.replace(/'/g, "''");

async function userId(email: string): Promise<string> {
  return (
    await execSql(
      `SELECT id FROM "${TENANT_SCHEMA}"."User" WHERE email = '${sql(email)}'`,
    )
  ).trim();
}

async function userExists(email: string): Promise<boolean> {
  return (await userId(email)).length > 0;
}

/**
 * Secret du cron admin, lu dans le conteneur applicatif — même approche que
 * les helpers DB, qui shellent déjà dans docker. Retourne null si indisponible
 * (les cas qui en dépendent sont alors explicitement ignorés plutôt que
 * silencieusement verts).
 */
async function cronSecret(): Promise<string | null> {
  if (process.env.TEST_CRON_SECRET_ADMIN) return process.env.TEST_CRON_SECRET_ADMIN;
  try {
    const container = process.env.TEST_APP_CONTAINER ?? "physalis";
    const { stdout } = await execAsync(
      `docker exec ${container} printenv CRON_SECRET_ADMIN`,
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function runPurgeCron(secret: string): Promise<Response> {
  return fetch(`${BASE_URL}/api/cron/purge-accounts`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${secret}`,
    },
  });
}

/**
 * Crée un utilisateur jetable via le VRAI parcours d'inscription (invitation +
 * register-and-accept). pgcrypto n'étant pas installé, on ne peut pas hacher un
 * mot de passe en SQL — et c'est tant mieux : passer par l'app garantit que le
 * compte est dans le même état qu'un compte réel.
 */
async function seedUser(email: string, orgIdForInvite: string): Promise<string> {
  const token = "iv_" + randomBytes(32).toString("hex");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const expiresAt = new Date(Date.now() + 3600_000)
    .toISOString()
    .replace("Z", "+00");
  await execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."Invitation" (id, email, "organizationId", role, "tokenHash", "expiresAt", "invitedById", "createdAt")
     VALUES ('${cuid()}', '${sql(email)}', '${orgIdForInvite}', 'MEMBER', '${tokenHash}', '${expiresAt}', '${adminId}', NOW())`,
  );
  const reg = await fetch(
    `${BASE_URL}/api/invitations/${token}/register-and-accept`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-host": TENANT_HOST,
        "x-forwarded-for": `203.0.113.${Math.floor(Math.random() * 254) + 1}`,
      },
      body: JSON.stringify({ password: VICTIM_PASSWORD }),
    },
  );
  if (!reg.ok) {
    throw new Error(`register-and-accept a échoué : HTTP ${reg.status}`);
  }
  return userId(email);
}

beforeAll(async () => {
  await adminSession(); // vérifie que la stack répond + tenant résolu
  adminId = (
    await execSql(
      `SELECT id FROM "${TENANT_SCHEMA}"."User" ORDER BY "createdAt" ASC LIMIT 1`,
    )
  ).trim();
  primaryOrgId = (
    await execSql(
      `SELECT id FROM "${TENANT_SCHEMA}"."Organization" WHERE "isPrimary" = true LIMIT 1`,
    )
  ).trim();
  if (!primaryOrgId) throw new Error("Pas d'org principale dans le tenant de test");

  victimId = await seedUser(VICTIM_EMAIL, primaryOrgId);
  expect(victimId).not.toBe("");
  victim = await loginAs(VICTIM_EMAIL, VICTIM_PASSWORD);
}, 60_000);

afterAll(async () => {
  // Nettoyage inconditionnel : si un cas a échoué en cours de route, on ne
  // laisse ni utilisateur ni org fantôme dans le tenant partagé.
  await execSql(
    `DELETE FROM "${TENANT_SCHEMA}"."User" WHERE email = '${sql(VICTIM_EMAIL)}'`,
  ).catch(() => {});
  if (orgId) {
    await execSql(
      `DELETE FROM "${TENANT_SCHEMA}"."Organization" WHERE id = '${orgId}'`,
    ).catch(() => {});
  }
});

describe("suppression du compte MEMBRE — cycle complet", () => {
  it("GET /api/me/delete annonce l'éligibilité et la phrase à recopier", async () => {
    const res = await victim.fetch("/api/me/delete");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      email: VICTIM_EMAIL,
      confirmPhrase: VICTIM_EMAIL,
      pending: false,
      canDelete: true,
    });
    // L'échelle de ré-auth est annoncée pour que l'UI sache quoi afficher.
    expect(["password", "totp", "freshness"]).toContain(body.reauthMethod);
  });

  it("refuse une phrase de confirmation qui ne correspond pas", async () => {
    const res = await postJson(victim, "/api/me/delete", {
      confirmPhrase: "pas-la-bonne-adresse@test.local",
    });
    expect(res.status).toBe(400);
    // Rien ne doit avoir été écrit.
    expect(
      (
        await execSql(
          `SELECT "deletionRequestedAt" FROM "${TENANT_SCHEMA}"."User" WHERE id = '${victimId}'`,
        )
      ).trim(),
    ).toBe("");
  });

  it("accepte la demande et pose la fenêtre de récupération", async () => {
    const res = await postJson(victim, "/api/me/delete", {
      confirmPhrase: VICTIM_EMAIL,
    });
    expect(res.status).toBe(200);

    const row = await execSql(
      `SELECT "deletionRequestedAt" IS NOT NULL, "purgeAt" > now() + interval '29 days'
       FROM "${TENANT_SCHEMA}"."User" WHERE id = '${victimId}'`,
    );
    expect(row.trim()).toBe("t|t");
  });

  it("refuse une seconde demande (409)", async () => {
    const res = await postJson(victim, "/api/me/delete", {
      confirmPhrase: VICTIM_EMAIL,
    });
    expect(res.status).toBe(409);
  });

  it("la suppression définitive exige la phrase, pas seulement la session", async () => {
    const res = await postJson(victim, "/api/me/delete/now", {
      confirmPhrase: "mauvaise",
    });
    expect(res.status).toBe(400);
    expect(await userExists(VICTIM_EMAIL)).toBe(true);
  });

  it("la suppression définitive exige une preuve d'identité, pas seulement la phrase", async () => {
    // Le cœur de l'arbitrage : la phrase est affichée à l'écran, donc lisible
    // par quiconque détient une session volée. Elle ne doit JAMAIS suffire
    // seule sur l'irréversible.
    const res = await postJson(victim, "/api/me/delete/now", {
      confirmPhrase: VICTIM_EMAIL,
    });
    expect([400, 401]).toContain(res.status);
    expect(await userExists(VICTIM_EMAIL)).toBe(true);
  });

  it("annule la demande et restaure l'état antérieur", async () => {
    const res = await postJson(victim, "/api/me/delete/cancel", {});
    expect(res.status).toBe(200);
    const row = await execSql(
      `SELECT "deletionRequestedAt", "purgeAt" FROM "${TENANT_SCHEMA}"."User" WHERE id = '${victimId}'`,
    );
    expect(row.trim()).toBe("|");
  });

  it("refuse une annulation quand rien n'est en cours (409)", async () => {
    const res = await postJson(victim, "/api/me/delete/cancel", {});
    expect(res.status).toBe(409);
  });
});

describe("garde du dernier OWNER", () => {
  it("bloque la suppression et NOMME l'organisation concernée", async () => {
    // La victime devient seule OWNER d'une org jetable : partir l'orphelinerait.
    orgId = cuid();
    await execSql(
      `INSERT INTO "${TENANT_SCHEMA}"."Organization" (id, name, slug, "isPrimary", "createdAt")
       VALUES ('${orgId}', 'Deletion Org ${SUFFIX}', '${ORG_SLUG}', false, now())`,
    );
    await execSql(
      `INSERT INTO "${TENANT_SCHEMA}"."OrgMember" (id, "userId", "organizationId", role, "createdAt")
       VALUES ('${cuid()}', '${victimId}', '${orgId}', 'OWNER', now())`,
    );

    const res = await postJson(victim, "/api/me/delete", {
      confirmPhrase: VICTIM_EMAIL,
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("last_owner");
    // L'org est nommée : la modale l'annonce AVANT toute saisie plutôt que de
    // laisser l'utilisateur se heurter à un refus générique.
    expect(body.organizations.map((o: { name: string }) => o.name)).toContain(
      `Deletion Org ${SUFFIX}`,
    );

    // On rend la propriété partagée → le blocage doit tomber.
    await execSql(
      `INSERT INTO "${TENANT_SCHEMA}"."OrgMember" (id, "userId", "organizationId", role, "createdAt")
       VALUES ('${cuid()}', '${adminId}', '${orgId}', 'OWNER', now())`,
    );
    const res2 = await victim.fetch("/api/me/delete");
    expect((await res2.json()).canDelete).toBe(true);
  });
});

describe("purge par le cron", () => {
  it("supprime l'utilisateur dont l'échéance est passée, et lui seul", async () => {
    const secret = await cronSecret();
    if (!secret) {
      // Explicite plutôt que silencieusement vert : sans le secret, ce cas
      // n'est PAS couvert.
      expect.fail(
        "CRON_SECRET_ADMIN introuvable (ni TEST_CRON_SECRET_ADMIN, ni docker exec). Cas de purge non couvert.",
      );
    }

    await postJson(victim, "/api/me/delete", { confirmPhrase: VICTIM_EMAIL });
    // Échéance forcée dans le passé : on ne va pas attendre 30 jours.
    await execSql(
      `UPDATE "${TENANT_SCHEMA}"."User" SET "purgeAt" = now() - interval '1 day' WHERE id = '${victimId}'`,
    );

    const res = await runPurgeCron(secret);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.members.purged).toBeGreaterThanOrEqual(1);

    // L'utilisateur a disparu…
    expect(await userExists(VICTIM_EMAIL)).toBe(false);
    // …et l'admin, lui, est toujours là (la purge ne ratisse pas large).
    expect(
      (
        await execSql(
          `SELECT count(*) FROM "${TENANT_SCHEMA}"."User" WHERE id = '${adminId}'`,
        )
      ).trim(),
    ).toBe("1");
  }, 60_000);

  it("laisse le journal d'audit, avec l'email dénormalisé", async () => {
    // AccessLog survit à la suppression (actorUserId → SetNull) : c'est la
    // seule trace qu'il reste du compte, elle doit exister.
    const rows = await execSql(
      `SELECT "actorUserId" IS NULL, "actorUserEmail"
       FROM "${TENANT_SCHEMA}"."AccessLog"
       WHERE action = 'USER_ACCOUNT_DELETED' AND "actorUserEmail" = '${sql(VICTIM_EMAIL)}'
       ORDER BY "createdAt" DESC LIMIT 1`,
    );
    expect(rows.trim()).toBe(`t|${VICTIM_EMAIL}`);
  });
});

describe("suppression du compte CLIENT — chemins négatifs uniquement", () => {
  // ⚠️ Aucun cas positif ici : il poserait PENDING_DELETION sur le tenant
  // partagé et annulerait son abonnement Stripe. Tous ces cas échouent AVANT
  // la moindre écriture.

  it("refuse la purge immédiate quand aucune suppression n'est en cours", async () => {
    // On résout l'org principale COMME L'APP le fait, puis on promeut un
    // utilisateur jetable OWNER de CELLE-LÀ. Le tenant de test contient deux
    // organisations `isPrimary = true` et `resolvePrimaryOrgId` fait un
    // `findFirst` SANS `orderBy` : présumer que le compte admin est le
    // propriétaire résolu rendrait ce test dépendant d'un aléa de seed.
    const resolvedPrimary = (
      await execSql(
        `SELECT id FROM "${TENANT_SCHEMA}"."Organization" WHERE "isPrimary" = true LIMIT 1`,
      )
    ).trim();
    const email = `deletion-owner-${SUFFIX}@test.local`;
    const ownerId = await seedUser(email, resolvedPrimary);
    await execSql(
      `INSERT INTO "${TENANT_SCHEMA}"."OrgMember" (id, "userId", "organizationId", role, "createdAt")
       VALUES ('${cuid()}', '${ownerId}', '${resolvedPrimary}', 'OWNER', now())
       ON CONFLICT ("userId", "organizationId") DO UPDATE SET role = 'OWNER'`,
    );
    try {
      const owner = await loginAs(email, VICTIM_PASSWORD);
      const res = await postJson(owner, "/api/account/delete/now", {
        confirmName: "peu importe",
      });
      // 409 = le garde d'autorisation est PASSÉ et c'est l'absence de
      // suppression en cours qui refuse — donc rien n'a été écrit.
      expect(res.status).toBe(409);
      expect(
        (
          await execSql(
            `SELECT status FROM admin.clients WHERE slug = '${sql(process.env.TEST_TENANT_SLUG ?? "test")}'`,
          )
        ).trim(),
      ).not.toBe("PENDING_DELETION");
    } finally {
      await execSql(
        `DELETE FROM "${TENANT_SCHEMA}"."User" WHERE email = '${sql(email)}'`,
      ).catch(() => {});
    }
  });

  it("refuse la suppression du client à un membre non-OWNER", async () => {
    // La victime a été purgée : on rejoue avec une session fraîche d'un membre
    // simple recréé pour ce seul cas.
    const email = `deletion-nonowner-${SUFFIX}@test.local`;
    await seedUser(email, primaryOrgId);
    try {
      const s2 = await loginAs(email, VICTIM_PASSWORD);
      const res = await postJson(s2, "/api/account/delete", {
        confirmName: "peu importe",
      });
      expect(res.status).toBe(403);
    } finally {
      await execSql(
        `DELETE FROM "${TENANT_SCHEMA}"."User" WHERE email = '${sql(email)}'`,
      ).catch(() => {});
    }
  });
});
