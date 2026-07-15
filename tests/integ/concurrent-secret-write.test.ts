// Test : écritures concurrentes sur le MÊME secret d'org.
//
// Couvre proposal Qualité & Robustesse #4 — deux users modifient le même
// secret simultanément. L'upsert POST /api/orgs/[slug]/secrets est transac-
// tionnel (snapshot de version + upsert). On vérifie qu'un double write
// concurrent ne produit ni 500 ni corruption : la valeur finale est l'une
// des deux écritures et reste déchiffrable.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  Session,
  adminSession,
  postJson,
  ADMIN_EMAIL,
  TENANT_SCHEMA,
} from "./helpers/api";
import { execSql } from "./helpers/db";
import { provisionOrg } from "./helpers/org";

const SUFFIX = `${Date.now()}`;
const ORG_SLUG = `conc-${SUFFIX}`;
const KEY = "CONCURRENT_TEST";

let admin: Session;
let adminUserId = "";

beforeAll(async () => {
  admin = await adminSession();
  adminUserId = (
    await execSql(`SELECT id FROM "${TENANT_SCHEMA}"."User" WHERE email = '${ADMIN_EMAIL}'`)
  ).trim();
  if (!adminUserId) throw new Error("Admin user not found");
  await provisionOrg(ORG_SLUG, adminUserId);
});

afterAll(async () => {
  await execSql(`DELETE FROM "${TENANT_SCHEMA}"."Organization" WHERE slug = '${ORG_SLUG}'`);
});

describe("Écritures concurrentes sur un même secret (Qualité & Robustesse #4)", () => {
  it("double POST simultané → aucun 500, valeur finale cohérente et déchiffrable", async () => {
    // Valeur initiale (create).
    const init = await postJson(admin, `/api/orgs/${ORG_SLUG}/secrets`, {
      key: KEY,
      value: "initial",
    });
    expect(init.status).toBe(200);

    // Deux écritures concurrentes de valeurs différentes.
    const [rb, rc] = await Promise.all([
      postJson(admin, `/api/orgs/${ORG_SLUG}/secrets`, { key: KEY, value: "VALUE_B" }),
      postJson(admin, `/api/orgs/${ORG_SLUG}/secrets`, { key: KEY, value: "VALUE_C" }),
    ]);
    // Le contrat minimal : pas d'erreur serveur (500).
    expect(rb.status, "écriture B").toBeLessThan(500);
    expect(rc.status, "écriture C").toBeLessThan(500);

    // La valeur finale est l'une des deux (last-write-wins) et se déchiffre
    // sans erreur → pas de corruption iv/tag.
    const get = await admin.fetch(`/api/orgs/${ORG_SLUG}/secrets/${KEY}`);
    expect(get.status).toBe(200);
    const body = (await get.json()) as { value?: string };
    expect(["VALUE_B", "VALUE_C"]).toContain(body.value);
  });
});
