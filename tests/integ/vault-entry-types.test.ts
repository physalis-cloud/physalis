// Integ tests pour les types d'entrée du coffre personnel (V2.2).
//
// Couvre ce que les tests unitaires ne peuvent pas voir : le chiffrement
// effectif du blob LIST/NOTE en base, le déplacement de la valeur unique
// lors d'un changement de type, le refus des conversions destructrices, et
// le blocage du move vers un coffre d'équipe.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import {
  Session,
  loginAs,
  postJson,
  patchJson,
  TENANT_SCHEMA,
  TENANT_SLUG,
} from "./helpers/api";
import { execSql, selectRows } from "./helpers/db";

const SUFFIX = `${Date.now()}`;
const BOB_EMAIL = `bob-types-${SUFFIX}@test.local`;
const BOB_PASSWORD = "bobtestpassword123";
let bobId = "";
let bob: Session;

// Marqueurs uniques : on les cherche en base pour prouver que rien n'y est
// stocké en clair.
const NOTE_MARKER = `note-marker-${SUFFIX}`;
const ITEM_VALUE_MARKER = `item-value-marker-${SUFFIX}`;
const ITEM_LABEL_MARKER = `item-label-marker-${SUFFIX}`;
const PWD_MARKER = `pwd-marker-${SUFFIX}`;

/** Contenu brut de la ligne, pour vérifier qu'aucun marqueur n'y traîne. */
async function rawRow(id: string): Promise<string> {
  const rows = await selectRows(
    `SELECT COALESCE("encryptedData",'') || '|' || COALESCE("encryptedPassword",'') || '|' || name
       FROM "${TENANT_SCHEMA}"."VaultEntry" WHERE id = '${id}'`,
  );
  return rows[0] ?? "";
}

async function createEntry(body: Record<string, unknown>): Promise<string> {
  const res = await postJson(bob, "/api/vault/entries", body);
  expect(res.status).toBe(201);
  const data = (await res.json()) as { entry: { id: string } };
  return data.entry.id;
}

type Revealed = {
  type: string;
  url: string | null;
  username: string | null;
  password: string | null;
  totpSecret: string | null;
  items: Array<{ label: string; value: string }>;
  text: string;
  itemCount: number | null;
};

async function reveal(id: string): Promise<Revealed> {
  const res = await bob.fetch(`/api/vault/entries/${id}`);
  expect(res.status).toBe(200);
  const data = (await res.json()) as { entry: Revealed };
  return data.entry;
}

beforeAll(async () => {
  const id = "ck" + randomBytes(11).toString("hex");
  const passwordHash = await bcrypt.hash(BOB_PASSWORD, 12);
  await execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."User" (id, email, password, role, "createdAt")
     VALUES ('${id}', '${BOB_EMAIL}', '${passwordHash}', 'MEMBER', NOW())`,
  );
  const orgId = "ck" + randomBytes(11).toString("hex");
  await execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."Organization" (id, name, slug, "createdAt")
     VALUES ('${orgId}', 'bob types org', 'bob-types-${SUFFIX}', NOW())`,
  );
  const memId = "ck" + randomBytes(11).toString("hex");
  await execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."OrgMember" (id, "userId", "organizationId", role, "createdAt")
     VALUES ('${memId}', '${id}', '${orgId}', 'OWNER', NOW())`,
  );
  bobId = id;
  bob = await loginAs(BOB_EMAIL, BOB_PASSWORD, undefined, TENANT_SLUG);
});

afterAll(async () => {
  if (bobId) {
    await execSql(
      `DELETE FROM "${TENANT_SCHEMA}"."User" WHERE id = '${bobId}'`,
    ).catch(() => {});
    await execSql(
      `DELETE FROM "${TENANT_SCHEMA}"."Organization" WHERE slug = 'bob-types-${SUFFIX}'`,
    ).catch(() => {});
  }
});

describe("/api/vault/entries — création par type", () => {
  it("type inconnu → 400 (pas de repli silencieux sur LOGIN)", async () => {
    const res = await postJson(bob, "/api/vault/entries", {
      type: "CARD",
      name: "Visa",
    });
    expect(res.status).toBe(400);
  });

  it("type absent → LOGIN (compat extension / anciens clients)", async () => {
    const id = await createEntry({ name: "Sans type", password: "x" });
    expect((await reveal(id)).type).toBe("LOGIN");
  });

  it("NOTE : le texte est chiffré en base et relu au reveal", async () => {
    const id = await createEntry({
      type: "NOTE",
      name: "Procédure de récup",
      text: NOTE_MARKER,
    });
    expect(await rawRow(id)).not.toContain(NOTE_MARKER);

    const entry = await reveal(id);
    expect(entry.type).toBe("NOTE");
    expect(entry.text).toBe(NOTE_MARKER);
    expect(entry.itemCount).toBeNull();
  });

  it("LIST : libellés ET valeurs chiffrés, itemCount en clair", async () => {
    const id = await createEntry({
      type: "LIST",
      name: "Questions secrètes",
      items: [
        { label: ITEM_LABEL_MARKER, value: ITEM_VALUE_MARKER },
        { label: "Ville de naissance", value: "Nantes" },
      ],
    });
    const raw = await rawRow(id);
    // Les libellés vivent DANS le blob : ils en disent plus qu'une URL.
    expect(raw).not.toContain(ITEM_LABEL_MARKER);
    expect(raw).not.toContain(ITEM_VALUE_MARKER);

    const counts = await selectRows(
      `SELECT "itemCount"::text FROM "${TENANT_SCHEMA}"."VaultEntry" WHERE id = '${id}'`,
    );
    expect(counts[0].trim()).toBe("2");

    const entry = await reveal(id);
    expect(entry.items).toHaveLength(2);
    expect(entry.items[0]).toEqual({
      label: ITEM_LABEL_MARKER,
      value: ITEM_VALUE_MARKER,
    });
  });

  it("SECRET : réutilise la colonne password mais n'est pas scoré", async () => {
    const id = await createEntry({
      type: "SECRET",
      name: "Clé API",
      password: PWD_MARKER,
    });
    expect(await rawRow(id)).not.toContain(PWD_MARKER);
    expect((await reveal(id)).password).toBe(PWD_MARKER);

    // passwordStrength NULL : une clé d'API n'est pas un mot de passe faible,
    // elle ne doit pas polluer le filtre ni le tri par force.
    const rows = await selectRows(
      `SELECT COALESCE("passwordStrength"::text,'NULL') FROM "${TENANT_SCHEMA}"."VaultEntry" WHERE id = '${id}'`,
    );
    expect(rows[0].trim()).toBe("NULL");
  });

  it("les champs étrangers au type ne sont pas persistés", async () => {
    // Un client qui envoie une URL sur une NOTE ne doit pas la voir stockée.
    const id = await createEntry({
      type: "NOTE",
      name: "Note avec bruit",
      text: "contenu",
      url: "https://example.com",
      username: "someone",
    });
    const entry = await reveal(id);
    expect(entry.url).toBeNull();
    expect(entry.username).toBeNull();
  });

  it("GET liste : expose type + itemCount, jamais le blob ni le clair", async () => {
    const res = await bob.fetch("/api/vault/entries");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(NOTE_MARKER);
    expect(text).not.toContain(ITEM_VALUE_MARKER);
    expect(text).not.toContain(ITEM_LABEL_MARKER);
    for (const leaky of ['"encryptedData"', '"dataIv"', '"dataTag"', '"text"', '"items"']) {
      expect(text).not.toContain(leaky);
    }
    const data = JSON.parse(text) as {
      entries: Array<{ type: string; itemCount: number | null }>;
    };
    expect(data.entries.some((e) => e.type === "NOTE")).toBe(true);
    expect(data.entries.some((e) => e.type === "LIST" && e.itemCount === 2)).toBe(true);
  });
});

describe("/api/vault/entries/[id] — changement de type", () => {
  it("LOGIN nu → NOTE : le mot de passe devient le texte", async () => {
    // Le cas visé : reclasser une entrée historique qui n'a qu'un nom et un
    // mot de passe. Le client n'envoie QUE le type — c'est le serveur qui
    // déplace la valeur, sans avoir besoin du clair côté navigateur.
    const id = await createEntry({ name: "Vieux secret", password: PWD_MARKER });
    const res = await patchJson(bob, `/api/vault/entries/${id}`, { type: "NOTE" });
    expect(res.status).toBe(200);

    const entry = await reveal(id);
    expect(entry.type).toBe("NOTE");
    expect(entry.text).toBe(PWD_MARKER);
    // Plus aucun résidu dans les colonnes de login.
    expect(entry.password).toBeNull();
    expect(entry.url).toBeNull();
    expect(entry.username).toBeNull();
  });

  it("LOGIN nu → LIST : le mot de passe devient l'item unique", async () => {
    const id = await createEntry({ name: "Vieille clé", password: PWD_MARKER });
    const res = await patchJson(bob, `/api/vault/entries/${id}`, { type: "LIST" });
    expect(res.status).toBe(200);

    const entry = await reveal(id);
    expect(entry.type).toBe("LIST");
    expect(entry.items).toEqual([{ label: "Vieille clé", value: PWD_MARKER }]);
    expect(entry.password).toBeNull();
  });

  it("LOGIN nu → SECRET : le mot de passe reste en place, le score tombe", async () => {
    const id = await createEntry({ name: "À reclasser", password: PWD_MARKER });
    const res = await patchJson(bob, `/api/vault/entries/${id}`, { type: "SECRET" });
    expect(res.status).toBe(200);
    expect((await reveal(id)).password).toBe(PWD_MARKER);

    const rows = await selectRows(
      `SELECT COALESCE("passwordStrength"::text,'NULL') FROM "${TENANT_SCHEMA}"."VaultEntry" WHERE id = '${id}'`,
    );
    expect(rows[0].trim()).toBe("NULL");
  });

  it("NOTE → SECRET : le texte redevient la valeur, le blob est nettoyé", async () => {
    const id = await createEntry({
      type: "NOTE",
      name: "Aller-retour",
      text: NOTE_MARKER,
    });
    const res = await patchJson(bob, `/api/vault/entries/${id}`, { type: "SECRET" });
    expect(res.status).toBe(200);

    const entry = await reveal(id);
    expect(entry.password).toBe(NOTE_MARKER);
    expect(entry.text).toBe("");

    // Pas de blob orphelin laissé sur la ligne.
    const rows = await selectRows(
      `SELECT COALESCE("encryptedData",'NULL') FROM "${TENANT_SCHEMA}"."VaultEntry" WHERE id = '${id}'`,
    );
    expect(rows[0].trim()).toBe("NULL");
  });

  it("refuse LOGIN → SECRET quand l'entrée porte une URL", async () => {
    const id = await createEntry({
      name: "Avec URL",
      url: "https://gmail.com",
      password: "x",
    });
    const res = await patchJson(bob, `/api/vault/entries/${id}`, { type: "SECRET" });
    expect(res.status).toBe(400);
    const data = (await res.json()) as { code?: string; blocker?: string };
    expect(data.code).toBe("type_change_not_allowed");
    expect(data.blocker).toBe("url");

    // L'entrée n'a pas bougé.
    expect((await reveal(id)).type).toBe("LOGIN");
  });

  it("refuse LOGIN → NOTE quand l'entrée porte un login", async () => {
    const id = await createEntry({ name: "Avec login", username: "gael", password: "x" });
    const res = await patchJson(bob, `/api/vault/entries/${id}`, { type: "NOTE" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { blocker?: string }).blocker).toBe("username");
  });

  it("refuse d'écraser une LIST à plusieurs items", async () => {
    const id = await createEntry({
      type: "LIST",
      name: "Multi",
      items: [
        { label: "a", value: "1" },
        { label: "b", value: "2" },
      ],
    });
    for (const target of ["SECRET", "LOGIN", "NOTE"]) {
      const res = await patchJson(bob, `/api/vault/entries/${id}`, { type: target });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { blocker?: string }).blocker).toBe("items");
    }
  });

  it("un PATCH partiel n'efface pas la charge utile", async () => {
    // Le ★ de la liste envoie UNIQUEMENT {favorite}. Si ce chemin touchait
    // aux colonnes du blob, un simple clic viderait la note ou la liste.
    const noteId = await createEntry({
      type: "NOTE",
      name: "Note fragile",
      text: NOTE_MARKER,
    });
    const listId = await createEntry({
      type: "LIST",
      name: "Liste fragile",
      items: [
        { label: "a", value: "1" },
        { label: "b", value: "2" },
      ],
    });

    expect((await patchJson(bob, `/api/vault/entries/${noteId}`, { favorite: true })).status).toBe(200);
    expect((await patchJson(bob, `/api/vault/entries/${listId}`, { name: "Renommée" })).status).toBe(200);

    expect((await reveal(noteId)).text).toBe(NOTE_MARKER);
    const list = await reveal(listId);
    expect(list.items).toHaveLength(2);
    expect(list.itemCount).toBe(2);
  });

  it("un changement de type est tracé dans l'audit log", async () => {
    const rows = await selectRows(
      `SELECT metadata::text FROM "${TENANT_SCHEMA}"."AccessLog"
        WHERE "actorUserId" = '${bobId}' AND action::text = 'VAULT_ENTRY_UPDATE'
        ORDER BY "createdAt" DESC LIMIT 5`,
    );
    expect(rows.some((r) => r.includes("previousType"))).toBe(true);
  });
});

describe("/api/vault/entries/[id]/move — types non portables", () => {
  it("refuse de déplacer une NOTE vers un coffre d'équipe", async () => {
    // TeamVaultEntry n'a ni colonne `type` ni blob : le move la viderait.
    const id = await createEntry({
      type: "NOTE",
      name: "Note à ne pas perdre",
      text: NOTE_MARKER,
    });
    const res = await postJson(bob, `/api/vault/entries/${id}/move`, {
      target: "team_org",
      orgSlug: `bob-types-${SUFFIX}`,
      collectionSlug: "peu-importe",
    });
    expect(res.status).toBe(400);
    const data = (await res.json()) as { code?: string };
    expect(data.code).toBe("type_not_movable");

    // La note est toujours là, intacte.
    expect((await reveal(id)).text).toBe(NOTE_MARKER);
  });
});
