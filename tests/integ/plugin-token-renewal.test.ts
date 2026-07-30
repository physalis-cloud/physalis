// §2.18 — Un PluginToken volé se renouvelait indéfiniment : (1) le provider
// Credentials accepte le champ `pluginToken` et émet une session web fraîche ;
// (2) toute session web re-frappe un PluginToken neuf via /api/plugin/issue.
// La boucle survivait à l'expiration ET à la révocation manuelle.
//
// Fix : la session DÉRIVÉE d'un PluginToken porte `origin: "plugin_token"` dans
// le JWT ; /api/plugin/issue la refuse (403). Seul un vrai login web (mot de
// passe / SSO) ou /api/plugin/auth (email+password+TOTP) frappe un token neuf.
//
// On teste la cellule `plugin_token × explicit_revoke` de la matrice de
// révocation (§4bis / tests/lib/revocation-matrix.test.ts).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes, createHash } from "node:crypto";
import {
  Session,
  adminSession,
  ADMIN_EMAIL,
  TENANT_SLUG,
  TENANT_SCHEMA,
} from "./helpers/api";
import { execSql } from "./helpers/db";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const PLUGIN_RAW = "sv_plugin_" + randomBytes(32).toString("hex");
const PLUGIN_HASH = sha256(PLUGIN_RAW);

let adminUserId = "";

/** Seede un PluginToken valide (ligne tenant + entrée admin.token_index). */
async function seedPluginToken(userId: string, hash: string): Promise<void> {
  await execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."PluginToken" (id, "tokenHash", "userId", "expiresAt", "createdAt")
     VALUES ('ck${randomBytes(11).toString("hex")}', '${hash}', '${userId}', NOW() + interval '4 hours', NOW())`,
  );
  await execSql(
    `INSERT INTO admin.token_index (token_hash, tenant_slug, kind, created_at)
     VALUES ('${hash}', '${TENANT_SLUG}', 'PLUGIN', NOW())`,
  );
}

/** Échange un PluginToken brut contre une session web via le provider Credentials
 *  (branche `pluginToken`) — exactement la « leg 1 » de la boucle §2.18. */
async function exchangePluginTokenForSession(raw: string): Promise<Session> {
  const s = new Session();
  const csrfRes = await s.fetch("/api/auth/csrf");
  const { csrfToken } = (await csrfRes.json()) as { csrfToken: string };
  const body = new URLSearchParams({ csrfToken, pluginToken: raw }).toString();
  const res = await s.fetch("/api/auth/callback/credentials", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  // 302 dans les deux cas (NextAuth), mais un succès pose le cookie de session.
  expect(res.status).toBe(302);
  return s;
}

function issueToken(session: Session): Promise<Response> {
  return session.fetch("/api/plugin/issue", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
}

beforeAll(async () => {
  await adminSession(); // vérifie que la stack répond
  adminUserId = (
    await execSql(`SELECT id FROM "${TENANT_SCHEMA}"."User" WHERE email = '${ADMIN_EMAIL}'`)
  ).trim();
  if (!adminUserId) throw new Error("Admin user not found");
  await seedPluginToken(adminUserId, PLUGIN_HASH);
});

afterAll(async () => {
  await execSql(`DELETE FROM admin.token_index WHERE token_hash = '${PLUGIN_HASH}'`).catch(() => {});
  await execSql(`DELETE FROM "${TENANT_SCHEMA}"."PluginToken" WHERE "tokenHash" = '${PLUGIN_HASH}'`).catch(() => {});
});

describe("§2.18 — la boucle de renouvellement du PluginToken est cassée", () => {
  it("session web NORMALE → /api/plugin/issue 200 (garde anti sur-restriction)", async () => {
    // Un vrai login (origin = web) doit toujours pouvoir frapper un token pour
    // l'extension — c'est le hand-off SSO légitime.
    const web = await adminSession();
    const res = await issueToken(web);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessionToken?: string };
    expect(body.sessionToken).toMatch(/^sv_plugin_[0-9a-f]{64}$/);
  });

  it("session DÉRIVÉE d'un PluginToken → /api/plugin/issue 403 (boucle fermée)", async () => {
    // 403 (pas 401) prouve DEUX choses : la session est bien authentifiée (sinon
    // requireUser renverrait 401) ET le garde-fou d'origine a mordu.
    const derived = await exchangePluginTokenForSession(PLUGIN_RAW);
    const res = await issueToken(derived);
    expect(res.status).toBe(403);
  });
});
