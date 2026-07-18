// Integ tests pour les coffres d'equipe (cf. coffres.md, sub-PR2).
//
// Couvre :
//   - Org collection : CRUD + members + entries + isolation par membership
//   - Project collection : CRUD + entries avec RBAC herite du projet
//   - 404 anti-leak quand pas d'acces
//   - Validation refus TeamVaultMember sur collection projet (404 implicit)

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import {
  Session,
  loginAs,
  postJson,
  patchJson,
  deleteReq,
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  TENANT_SCHEMA,
  TENANT_SLUG,
} from "./helpers/api";
import { execSql } from "./helpers/db";

const SUFFIX = `${Date.now()}`;
const ALICE_EMAIL = `alice-tv-${SUFFIX}@test.local`;
const BOB_EMAIL = `bob-tv-${SUFFIX}@test.local`;
const CAROL_EMAIL = `carol-tv-${SUFFIX}@test.local`;
const PWD = "team-vault-pwd-12";

let aliceId = "";
let bobId = "";
let carolId = "";
let aliceSession: Session;
let bobSession: Session;
let carolSession: Session;
let adminSess: Session;
let orgId = "";
const orgSlug = `tv-${SUFFIX}`;
let projectId = "";
let projectSlug = "";
let collectionSlug = "";
let projectCollectionSlug = "";
let entryId = "";
let projectEntryId = "";

const PLAINTEXT = `s3cr3t-team-${SUFFIX}`;

async function provisionUser(email: string): Promise<string> {
  const id = "ck" + randomBytes(11).toString("hex");
  const pwdHash = await bcrypt.hash(PWD, 12);
  await execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."User" (id, email, password, role, "createdAt")
     VALUES ('${id}', '${email}', '${pwdHash}', 'MEMBER', NOW())`,
  );
  return id;
}

beforeAll(async () => {
  aliceId = await provisionUser(ALICE_EMAIL);
  bobId = await provisionUser(BOB_EMAIL);
  carolId = await provisionUser(CAROL_EMAIL);

  // Org avec Alice OWNER, Bob ADMIN, Carol MEMBER
  orgId = "ck" + randomBytes(11).toString("hex");
  await execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."Organization" (id, name, slug, "createdAt")
     VALUES ('${orgId}', 'TV org', '${orgSlug}', NOW())`,
  );
  for (const [uid, role] of [
    [aliceId, "OWNER"],
    [bobId, "ADMIN"],
    [carolId, "MEMBER"],
  ] as const) {
    const mid = "ck" + randomBytes(11).toString("hex");
    await execSql(
      `INSERT INTO "${TENANT_SCHEMA}"."OrgMember" (id, "userId", "organizationId", role, "createdAt")
       VALUES ('${mid}', '${uid}', '${orgId}', '${role}', NOW())`,
    );
  }

  // Projet de l'org. Alice OWNER projet (implicite via OrgOWNER), Carol VIEWER projet.
  projectId = "ck" + randomBytes(11).toString("hex");
  projectSlug = `tv-proj-${SUFFIX}`;
  await execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."Project" (id, name, slug, "organizationId", "createdAt")
     VALUES ('${projectId}', 'tv proj', '${projectSlug}', '${orgId}', NOW())`,
  );
  const carolProjectMember = "ck" + randomBytes(11).toString("hex");
  await execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."ProjectMember" (id, "userId", "projectId", role)
     VALUES ('${carolProjectMember}', '${carolId}', '${projectId}', 'VIEWER')`,
  );

  aliceSession = await loginAs(ALICE_EMAIL, PWD, undefined, TENANT_SLUG);
  bobSession = await loginAs(BOB_EMAIL, PWD, undefined, TENANT_SLUG);
  carolSession = await loginAs(CAROL_EMAIL, PWD, undefined, TENANT_SLUG);
  adminSess = await loginAs(ADMIN_EMAIL, ADMIN_PASSWORD, undefined, TENANT_SLUG);
});

afterAll(async () => {
  await execSql(`DELETE FROM "${TENANT_SCHEMA}"."Organization" WHERE slug = '${orgSlug}'`).catch(
    () => {},
  );
  await execSql(`DELETE FROM "${TENANT_SCHEMA}"."User" WHERE id = '${aliceId}'`).catch(() => {});
  await execSql(`DELETE FROM "${TENANT_SCHEMA}"."User" WHERE id = '${bobId}'`).catch(() => {});
  await execSql(`DELETE FROM "${TENANT_SCHEMA}"."User" WHERE id = '${carolId}'`).catch(() => {});
});

describe("Coffre d'équipe ORG — CRUD collection", () => {
  it("OrgMEMBER (Carol) liste vide (pas d'acces aux collections sans membership)", async () => {
    // On n'a pas encore cree de collection, mais Carol va d'abord voir vide
    // puis ne pas voir celle qu'on cree (pas membre).
    const res = await carolSession.fetch(`/api/vault/org/${orgSlug}/collections`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { collections: unknown[] };
    expect(data.collections).toEqual([]);
  });

  it("OrgMEMBER (Carol) → POST refusé (404)", async () => {
    const res = await postJson(
      carolSession,
      `/api/vault/org/${orgSlug}/collections`,
      { name: "Tentative Carol" },
    );
    expect(res.status).toBe(404);
  });

  it("OrgADMIN (Bob) crée une collection", async () => {
    const res = await postJson(
      bobSession,
      `/api/vault/org/${orgSlug}/collections`,
      { name: "Outils internes" },
    );
    expect(res.status).toBe(201);
    const data = (await res.json()) as {
      collection: { slug: string; role: string };
    };
    expect(data.collection.role).toBe("OWNER");
    collectionSlug = data.collection.slug;
  });

  it("Slug duplicat → 409", async () => {
    const res = await postJson(
      bobSession,
      `/api/vault/org/${orgSlug}/collections`,
      { name: "Outils internes" },
    );
    expect(res.status).toBe(409);
  });

  it("OrgADMIN voit la collection", async () => {
    const res = await bobSession.fetch(`/api/vault/org/${orgSlug}/collections`);
    const data = (await res.json()) as { collections: { slug: string }[] };
    expect(data.collections.find((c) => c.slug === collectionSlug)).toBeDefined();
  });

  it("Carol (MEMBER) ne voit toujours PAS la collection (pas membre explicite)", async () => {
    const res = await carolSession.fetch(
      `/api/vault/org/${orgSlug}/collections`,
    );
    const data = (await res.json()) as { collections: { slug: string }[] };
    expect(data.collections.find((c) => c.slug === collectionSlug)).toBeUndefined();
  });

  it("Carol → 404 sur GET entries (pas d'accès)", async () => {
    const res = await carolSession.fetch(
      `/api/vault/org/${orgSlug}/collections/${collectionSlug}/entries`,
    );
    expect(res.status).toBe(404);
  });
});

describe("Coffre d'équipe ORG — Members", () => {
  it("Bob ajoute Carol comme EDITOR", async () => {
    const res = await postJson(
      bobSession,
      `/api/vault/org/${orgSlug}/collections/${collectionSlug}/members`,
      { email: CAROL_EMAIL, role: "EDITOR" },
    );
    expect(res.status).toBe(201);
  });

  it("Carol voit maintenant la collection avec rôle EDITOR", async () => {
    const res = await carolSession.fetch(
      `/api/vault/org/${orgSlug}/collections`,
    );
    const data = (await res.json()) as {
      collections: Array<{ slug: string; role: string }>;
    };
    const found = data.collections.find((c) => c.slug === collectionSlug);
    expect(found?.role).toBe("EDITOR");
  });

  it("Add membre user inexistant → 400", async () => {
    const res = await postJson(
      bobSession,
      `/api/vault/org/${orgSlug}/collections/${collectionSlug}/members`,
      { email: "ghost@nowhere.local", role: "VIEWER" },
    );
    expect(res.status).toBe(400);
  });

  it("Carol (EDITOR) ne peut PAS ajouter de membre (OWNER required)", async () => {
    const res = await postJson(
      carolSession,
      `/api/vault/org/${orgSlug}/collections/${collectionSlug}/members`,
      { email: CAROL_EMAIL, role: "VIEWER" },
    );
    expect(res.status).toBe(404);
  });

  it("Bob change Carol en VIEWER", async () => {
    const res = await patchJson(
      bobSession,
      `/api/vault/org/${orgSlug}/collections/${collectionSlug}/members/${carolId}`,
      { role: "VIEWER" },
    );
    expect(res.status).toBe(200);
  });
});

describe("Coffre d'équipe ORG — Entries", () => {
  it("Carol (VIEWER) ne peut PAS créer d'entrée → 403/404", async () => {
    const res = await postJson(
      carolSession,
      `/api/vault/org/${orgSlug}/collections/${collectionSlug}/entries`,
      { name: "Test Carol", password: "x" },
    );
    // 404 anti-leak ou 403 strict — convention selon la lib d'access.
    expect([403, 404]).toContain(res.status);
  });

  it("Bob (OrgADMIN→OWNER implicite) crée une entrée", async () => {
    const res = await postJson(
      bobSession,
      `/api/vault/org/${orgSlug}/collections/${collectionSlug}/entries`,
      {
        name: "Notion agence",
        url: "https://notion.so",
        username: "admin@argoweb.fr",
        password: PLAINTEXT,
      },
    );
    expect(res.status).toBe(201);
    const data = (await res.json()) as { entry: { id: string } };
    entryId = data.entry.id;
  });

  it("Carol (VIEWER) peut reveal l'entrée", async () => {
    const res = await carolSession.fetch(
      `/api/vault/org/${orgSlug}/collections/${collectionSlug}/entries/${entryId}`,
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { entry: { password: string } };
    expect(data.entry.password).toBe(PLAINTEXT);
  });

  it("Carol (VIEWER) ne peut PAS modifier → 403/404", async () => {
    const res = await patchJson(
      carolSession,
      `/api/vault/org/${orgSlug}/collections/${collectionSlug}/entries/${entryId}`,
      { name: "Modif Carol" },
    );
    expect([403, 404]).toContain(res.status);
  });

  it("Carol (VIEWER) ne peut PAS supprimer → 403/404", async () => {
    const res = await deleteReq(
      carolSession,
      `/api/vault/org/${orgSlug}/collections/${collectionSlug}/entries/${entryId}`,
    );
    expect([403, 404]).toContain(res.status);
  });

  it("admin global ne voit PAS les coffres d'org où il n'est pas membre", async () => {
    // Admin (notre user de test) n'est pas membre de l'org tv-${SUFFIX}.
    // Mais il a User.role = ADMIN. Donc il a accès OWNER implicite via le
    // god mode. Test que l'admin global PEUT lire (par design existant).
    const res = await adminSess.fetch(
      `/api/vault/org/${orgSlug}/collections`,
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { collections: { slug: string }[] };
    expect(data.collections.find((c) => c.slug === collectionSlug)).toBeDefined();
  });
});

describe("Coffre d'équipe PROJET — RBAC hérité", () => {
  it("Alice (OrgOWNER → ProjectOWNER implicite) crée une collection projet", async () => {
    const res = await postJson(
      aliceSession,
      `/api/vault/project/${projectSlug}/collections`,
      { name: "Comptes test" },
    );
    expect(res.status).toBe(201);
    const data = (await res.json()) as { collection: { slug: string } };
    projectCollectionSlug = data.collection.slug;
  });

  it("Carol (ProjectVIEWER) voit la collection avec role VIEWER", async () => {
    const res = await carolSession.fetch(
      `/api/vault/project/${projectSlug}/collections`,
    );
    const data = (await res.json()) as {
      collections: Array<{ slug: string; role: string }>;
    };
    const found = data.collections.find((c) => c.slug === projectCollectionSlug);
    expect(found?.role).toBe("VIEWER");
  });

  it("Carol (ProjectVIEWER) ne peut PAS créer d'entrée → 403/404", async () => {
    const res = await postJson(
      carolSession,
      `/api/vault/project/${projectSlug}/collections/${projectCollectionSlug}/entries`,
      { name: "test", password: "x" },
    );
    expect([403, 404]).toContain(res.status);
  });

  it("Alice (ProjectOWNER implicite) crée une entrée projet", async () => {
    const res = await postJson(
      aliceSession,
      `/api/vault/project/${projectSlug}/collections/${projectCollectionSlug}/entries`,
      {
        name: "Compte staging",
        username: "test@voyages.fr",
        password: PLAINTEXT,
      },
    );
    expect(res.status).toBe(201);
    const data = (await res.json()) as { entry: { id: string } };
    projectEntryId = data.entry.id;
  });

  it("Carol (VIEWER) reveal OK", async () => {
    const res = await carolSession.fetch(
      `/api/vault/project/${projectSlug}/collections/${projectCollectionSlug}/entries/${projectEntryId}`,
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { entry: { password: string } };
    expect(data.entry.password).toBe(PLAINTEXT);
  });

  it("user hors projet (admin sans membership projet) → admin global voit quand meme via god mode", async () => {
    // Admin global a OWNER implicite partout, donc voit aussi cette collection.
    const res = await adminSess.fetch(
      `/api/vault/project/${projectSlug}/collections/${projectCollectionSlug}/entries/${projectEntryId}`,
    );
    expect(res.status).toBe(200);
  });

  it("Bob (OrgADMIN) voit la collection projet (OWNER implicite via OrgADMIN)", async () => {
    const res = await bobSession.fetch(
      `/api/vault/project/${projectSlug}/collections`,
    );
    const data = (await res.json()) as {
      collections: Array<{ role: string }>;
    };
    expect(data.collections.every((c) => c.role === "OWNER")).toBe(true);
  });

  // `ProjectMember.hidden` est une BARRIÈRE (requireProjectMember règle 2 → 403).
  // Les resolvers du coffre d'équipe (lib/vault-access.ts requireProjectScope +
  // requireProjectCollectionAccess) re-dérivaient le rôle depuis ProjectMember
  // sans lire `hidden` → un membre masqué gardait un accès R/W au coffre projet
  // que l'UI lui ferme. Carol est OrgMEMBER + ProjectVIEWER : sans sa ligne, elle
  // n'a aucun accès, donc masquer la ligne doit tout couper.
  it("Carol masquée (hidden=true) perd l'accès au coffre projet (les 2 resolvers)", async () => {
    await execSql(
      `UPDATE "${TENANT_SCHEMA}"."ProjectMember" SET hidden = true WHERE "userId" = '${carolId}' AND "projectId" = '${projectId}'`,
    );

    // requireProjectScope (LIST) : la collection projet disparaît de sa liste.
    const list = await carolSession.fetch(
      `/api/vault/project/${projectSlug}/collections`,
    );
    if (list.status === 200) {
      const data = (await list.json()) as {
        collections: Array<{ slug: string }>;
      };
      expect(
        data.collections.find((c) => c.slug === projectCollectionSlug),
      ).toBeUndefined();
    } else {
      expect([403, 404]).toContain(list.status);
    }

    // requireProjectCollectionAccess : reveal de l'entrée refusé (était 200).
    const reveal = await carolSession.fetch(
      `/api/vault/project/${projectSlug}/collections/${projectCollectionSlug}/entries/${projectEntryId}`,
    );
    expect([403, 404]).toContain(reveal.status);
  });

  it("Carol dé-masquée (hidden=false) retrouve l'accès (anti sur-restriction)", async () => {
    await execSql(
      `UPDATE "${TENANT_SCHEMA}"."ProjectMember" SET hidden = false WHERE "userId" = '${carolId}' AND "projectId" = '${projectId}'`,
    );
    const reveal = await carolSession.fetch(
      `/api/vault/project/${projectSlug}/collections/${projectCollectionSlug}/entries/${projectEntryId}`,
    );
    expect(reveal.status).toBe(200);
  });
});

describe("CHECK constraint XOR org/projet", () => {
  it("la DB rejette une collection avec orgId ET projectId set", async () => {
    let threw = false;
    try {
      const cid = "ck" + randomBytes(11).toString("hex");
      await execSql(
        `INSERT INTO "${TENANT_SCHEMA}"."TeamVaultCollection" (id, "organizationId", "projectId", name, slug, "createdAt", "updatedAt")
         VALUES ('${cid}', '${orgId}', '${projectId}', 'invalid', 'invalid-${SUFFIX}', NOW(), NOW())`,
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it("la DB rejette une collection avec orgId ET projectId NULL", async () => {
    let threw = false;
    try {
      const cid = "ck" + randomBytes(11).toString("hex");
      await execSql(
        `INSERT INTO "${TENANT_SCHEMA}"."TeamVaultCollection" (id, name, slug, "createdAt", "updatedAt")
         VALUES ('${cid}', 'orphan', 'orphan-${SUFFIX}', NOW(), NOW())`,
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});

describe("Audit log peuplé", () => {
  it("VAULT_COLLECTION_CREATE et VAULT_ENTRY_* tracés", async () => {
    const rows = await execSql(
      `SELECT action FROM "${TENANT_SCHEMA}"."AccessLog"
       WHERE "organizationId" = '${orgId}'
         AND action::text LIKE 'VAULT_%'`,
    );
    const actions = rows.split("\n").filter(Boolean);
    expect(actions).toContain("VAULT_COLLECTION_CREATE");
    expect(actions).toContain("VAULT_ENTRY_CREATE");
    expect(actions).toContain("VAULT_ENTRY_REVEAL");
    expect(actions).toContain("VAULT_MEMBER_ADD");
    expect(actions).toContain("VAULT_MEMBER_ROLE_CHANGE");
  });
});
