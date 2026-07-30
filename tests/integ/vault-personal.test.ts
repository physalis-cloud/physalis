// Integ tests pour le coffre personnel /api/vault/entries/* (cf. coffres.md).
//
// Couvre : CRUD, reveal, isolation entre users, validation, audit log,
// chiffrement effectif (le password en base est base64 chiffre, jamais le
// plaintext).

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
import { execSql, selectRows } from "./helpers/db";

const SUFFIX = `${Date.now()}`;
const ALICE_EMAIL = `alice-vault-${SUFFIX}@test.local`;
const ALICE_PASSWORD = "alicetestpassword12";
let aliceId = "";
let aliceSession: Session;
let aliceEntryId = "";
let adminSess: Session;

const PLAINTEXT_MARKER = `s3cr3t-marker-${SUFFIX}`;

beforeAll(async () => {
  // Provision Alice (un user lambda) directement en DB.
  const id = "ck" + randomBytes(11).toString("hex");
  const passwordHash = await bcrypt.hash(ALICE_PASSWORD, 12);
  await execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."User" (id, email, password, role, "createdAt")
     VALUES ('${id}', '${ALICE_EMAIL}', '${passwordHash}', 'MEMBER', NOW())`,
  );
  // Org + OrgMember pour ne pas casser le login (LOGIN_SUCCESS rattache a primaryOrg).
  const orgId = "ck" + randomBytes(11).toString("hex");
  await execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."Organization" (id, name, slug, "createdAt")
     VALUES ('${orgId}', 'alice vault org', 'alice-vault-${SUFFIX}', NOW())`,
  );
  const memId = "ck" + randomBytes(11).toString("hex");
  await execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."OrgMember" (id, "userId", "organizationId", role, "createdAt")
     VALUES ('${memId}', '${id}', '${orgId}', 'OWNER', NOW())`,
  );
  aliceId = id;
  aliceSession = await loginAs(ALICE_EMAIL, ALICE_PASSWORD, undefined, TENANT_SLUG);
  adminSess = await loginAs(ADMIN_EMAIL, ADMIN_PASSWORD, undefined, TENANT_SLUG);
});

afterAll(async () => {
  if (aliceId) {
    await execSql(`DELETE FROM "${TENANT_SCHEMA}"."User" WHERE id = '${aliceId}'`).catch(() => {});
    await execSql(
      `DELETE FROM "${TENANT_SCHEMA}"."Organization" WHERE slug = 'alice-vault-${SUFFIX}'`,
    ).catch(() => {});
  }
});

describe("/api/vault/entries — coffre personnel", () => {
  it("POST sans name → 400", async () => {
    const res = await postJson(aliceSession, "/api/vault/entries", {});
    expect(res.status).toBe(400);
  });

  it("POST entree complete → 201", async () => {
    const res = await postJson(aliceSession, "/api/vault/entries", {
      name: "Gmail perso",
      url: "https://gmail.com",
      username: "alice@gmail.com",
      password: PLAINTEXT_MARKER,
      tags: ["perso", "google"],
      favorite: true,
    });
    expect(res.status).toBe(201);
    const data = (await res.json()) as {
      entry: { id: string; name: string; favorite: boolean; tags: string[] };
    };
    expect(data.entry.name).toBe("Gmail perso");
    expect(data.entry.favorite).toBe(true);
    expect(data.entry.tags).toEqual(["perso", "google"]);
    aliceEntryId = data.entry.id;
  });

  it("le password est chiffre en base, jamais en clair", async () => {
    const rows = await selectRows(
      `SELECT "encryptedPassword" FROM "${TENANT_SCHEMA}"."VaultEntry" WHERE id = '${aliceEntryId}'`,
    );
    expect(rows.length).toBe(1);
    expect(rows[0]).not.toContain(PLAINTEXT_MARKER);
    expect(rows[0]).toMatch(/^[A-Za-z0-9+/=]+$/); // base64
  });

  it("GET liste retourne les entrees (sans password)", async () => {
    const res = await aliceSession.fetch("/api/vault/entries");
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      entries: Array<{ id: string; name: string }>;
    };
    expect(data.entries.find((e) => e.id === aliceEntryId)).toBeDefined();
    // Sanity : la liste ne doit ni servir le mot de passe en clair, ni son
    // blob chiffré. On teste les VALEURS et les noms de champs EXACTS, pas la
    // sous-chaîne « password » — `passwordStrength` (un score numérique, aucun
    // secret) est un champ légitime de cette réponse, et l'assertion naïve
    // échouait dessus.
    const text = JSON.stringify(data);
    expect(text).not.toContain(PLAINTEXT_MARKER);
    for (const leaky of [
      '"password"',
      '"encryptedPassword"',
      '"passwordIv"',
      '"passwordTag"',
      '"encryptedTotpSecret"',
    ]) {
      expect(text).not.toContain(leaky);
    }
  });

  it("GET reveal retourne le password déchiffré", async () => {
    const res = await aliceSession.fetch(`/api/vault/entries/${aliceEntryId}`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      entry: { password: string | null };
    };
    expect(data.entry.password).toBe(PLAINTEXT_MARKER);
  });

  it("Admin global ne peut PAS lire l'entree d'Alice → 404", async () => {
    // Volontairement 404 et pas 403 pour ne pas leak l'existence.
    const res = await adminSess.fetch(`/api/vault/entries/${aliceEntryId}`);
    expect(res.status).toBe(404);
  });

  it("PATCH partiel : juste favorite", async () => {
    const res = await patchJson(
      aliceSession,
      `/api/vault/entries/${aliceEntryId}`,
      { favorite: false },
    );
    expect(res.status).toBe(200);

    // Verification que l'entree est bien dans la liste avec favorite=false
    const list = await aliceSession.fetch("/api/vault/entries");
    const data = (await list.json()) as {
      entries: Array<{ id: string; favorite: boolean }>;
    };
    const found = data.entries.find((e) => e.id === aliceEntryId);
    expect(found?.favorite).toBe(false);
  });

  it("PATCH password → re-encrypt en base", async () => {
    const newMarker = `new-${PLAINTEXT_MARKER}`;
    const oldEncrypted = await execSql(
      `SELECT "encryptedPassword" FROM "${TENANT_SCHEMA}"."VaultEntry" WHERE id = '${aliceEntryId}'`,
    );

    const res = await patchJson(
      aliceSession,
      `/api/vault/entries/${aliceEntryId}`,
      { password: newMarker },
    );
    expect(res.status).toBe(200);

    const newEncrypted = await execSql(
      `SELECT "encryptedPassword" FROM "${TENANT_SCHEMA}"."VaultEntry" WHERE id = '${aliceEntryId}'`,
    );
    expect(newEncrypted).not.toBe(oldEncrypted);
    expect(newEncrypted).not.toContain(newMarker);

    // Reveal pour confirmer
    const reveal = await aliceSession.fetch(`/api/vault/entries/${aliceEntryId}`);
    const revealData = (await reveal.json()) as {
      entry: { password: string };
    };
    expect(revealData.entry.password).toBe(newMarker);
  });

  it("filtre par tag fonctionne", async () => {
    const res = await aliceSession.fetch("/api/vault/entries?tag=google");
    const data = (await res.json()) as {
      entries: Array<{ id: string }>;
    };
    expect(data.entries.find((e) => e.id === aliceEntryId)).toBeDefined();

    const res2 = await aliceSession.fetch("/api/vault/entries?tag=does-not-exist");
    const data2 = (await res2.json()) as {
      entries: Array<{ id: string }>;
    };
    expect(data2.entries.find((e) => e.id === aliceEntryId)).toBeUndefined();
  });

  it("filtre favorite=true", async () => {
    // Repasse en favori d'abord
    await patchJson(aliceSession, `/api/vault/entries/${aliceEntryId}`, {
      favorite: true,
    });

    const res = await aliceSession.fetch("/api/vault/entries?favorite=true");
    const data = (await res.json()) as {
      entries: Array<{ id: string; favorite: boolean }>;
    };
    expect(data.entries.every((e) => e.favorite)).toBe(true);
    expect(data.entries.find((e) => e.id === aliceEntryId)).toBeDefined();
  });

  it("recherche par nom (case-insensitive)", async () => {
    const res = await aliceSession.fetch("/api/vault/entries?search=GMAIL");
    const data = (await res.json()) as {
      entries: Array<{ id: string }>;
    };
    expect(data.entries.find((e) => e.id === aliceEntryId)).toBeDefined();
  });

  it("anon → 401 sur GET liste", async () => {
    const anon = new Session();
    const res = await anon.fetch("/api/vault/entries");
    expect(res.status).toBe(401);
  });

  it("DELETE → 200 + ne reapparait plus dans la liste", async () => {
    const res = await deleteReq(
      aliceSession,
      `/api/vault/entries/${aliceEntryId}`,
    );
    expect(res.status).toBe(200);

    const list = await aliceSession.fetch("/api/vault/entries");
    const data = (await list.json()) as {
      entries: Array<{ id: string }>;
    };
    expect(data.entries.find((e) => e.id === aliceEntryId)).toBeUndefined();
  });

  it("DELETE inexistant → 404", async () => {
    const res = await deleteReq(
      aliceSession,
      "/api/vault/entries/ckdoesnotexist000000000000",
    );
    expect(res.status).toBe(404);
  });

  it("audit log peuple : CREATE, UPDATE, REVEAL, DELETE rattaches a Alice", async () => {
    const rows = await selectRows(
      `SELECT action FROM "${TENANT_SCHEMA}"."AccessLog"
       WHERE "actorUserId" = '${aliceId}'
         AND action::text LIKE 'VAULT_ENTRY_%'
       ORDER BY "createdAt" ASC`,
    );
    // On a fait : create + reveal + patch favorite + reveal admin (404 → pas de log)
    // + patch password + reveal (PATCH = 1 log) + reveal (1 log) + delete
    const actions = rows.map((r) => r.trim());
    expect(actions).toContain("VAULT_ENTRY_CREATE");
    expect(actions).toContain("VAULT_ENTRY_UPDATE");
    expect(actions).toContain("VAULT_ENTRY_REVEAL");
    expect(actions).toContain("VAULT_ENTRY_DELETE");
  });
});
