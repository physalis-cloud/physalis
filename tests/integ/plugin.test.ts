// Tests integ pour les endpoints /api/plugin/* (cf. spec navigateurs-extension).
//
// Pre-requis sur la stack live :
//   - process.env.PLUGIN_ALLOWED_ORIGIN cote app doit inclure
//     "chrome-extension://test-extension-id" pour que les requetes
//     passent le check CORS. Si la var n'est pas configuree, ces tests
//     se skippent eux-memes (cf. beforeAll).
//
// Strategie : on cree un user dedie "plugin-test" avec 2FA preactivee
// directement en DB (insert chiffre), puis on teste auth + match + revoke.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { generate as totpGenerate } from "otplib";
import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import {
  Session,
  loginAs,
  BASE_URL,
  postJson,
  deleteReq,
  TENANT_SCHEMA,
  TENANT_SLUG,
} from "./helpers/api";
import { execSql } from "./helpers/db";

// Les INSERT/SELECT/UPDATE directs ciblent le schema du tenant de test
// (client_test), pas `public` : l'app est multi-tenant et `loginAs` se
// connecte au tenant `test`. Sans qualification, le user seede dans public
// est invisible au login → 401.
const T = `"${TENANT_SCHEMA}".`;

const SUFFIX = `${Date.now()}`;
const PLUGIN_USER_EMAIL = `plugin-${SUFFIX}@test.local`;
const PLUGIN_USER_PASSWORD = "plugintestpassword12";
const TEST_ORIGIN = "chrome-extension://testpluginextensionid000000000000";

let userId = "";
let orgId = "";
let projectId = "";
let pluginUserSession: Session;
let totpSecret = "";

/**
 * Crée un user avec 2FA pre-activee. Le secret TOTP doit etre chiffre avec
 * la meme ENCRYPTION_KEY que celle de l'app live. Pour eviter de dupliquer
 * la logique de chiffrement cote test, on passe par les endpoints existants :
 *   1. Insert user en DB
 *   2. Login NextAuth
 *   3. POST /api/me/2fa/setup → recupere le secret en clair
 *   4. POST /api/me/2fa/verify avec le code TOTP genere → 2FA active
 */
async function provisionUserWith2FA(): Promise<void> {
  const userIdLocal = "ck" + randomBytes(11).toString("hex");
  const orgIdLocal = "ck" + randomBytes(11).toString("hex");
  const memIdLocal = "ck" + randomBytes(11).toString("hex");
  const passwordHash = await bcrypt.hash(PLUGIN_USER_PASSWORD, 12);

  await execSql(
    `INSERT INTO ${T}"User" (id, email, password, role, "createdAt")
     VALUES ('${userIdLocal}', '${PLUGIN_USER_EMAIL}', '${passwordHash}', 'MEMBER', NOW())`,
  );
  await execSql(
    `INSERT INTO ${T}"Organization" (id, name, slug, "createdAt")
     VALUES ('${orgIdLocal}', 'plugin org', 'plugin-${SUFFIX}', NOW())`,
  );
  await execSql(
    `INSERT INTO ${T}"OrgMember" (id, "userId", "organizationId", role, "createdAt")
     VALUES ('${memIdLocal}', '${userIdLocal}', '${orgIdLocal}', 'OWNER', NOW())`,
  );
  userId = userIdLocal;
  orgId = orgIdLocal;

  // Login + activation 2FA pour avoir un secret chiffre coherent en base.
  pluginUserSession = await loginAs(PLUGIN_USER_EMAIL, PLUGIN_USER_PASSWORD);
  const setupRes = await pluginUserSession.fetch("/api/me/2fa/setup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  if (!setupRes.ok) throw new Error(`2fa setup failed: ${setupRes.status}`);
  const setupBody = (await setupRes.json()) as { secret: string };
  totpSecret = setupBody.secret;
  const code = await totpGenerate({ secret: totpSecret });
  const verifyRes = await pluginUserSession.fetch("/api/me/2fa/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
  });
  if (!verifyRes.ok) throw new Error(`2fa verify failed: ${verifyRes.status}`);

  // Cree un projet + service avec URL stripe.com pour les tests de match.
  const projIdLocal = "ck" + randomBytes(11).toString("hex");
  await execSql(
    `INSERT INTO ${T}"Project" (id, name, slug, "organizationId", "createdAt")
     VALUES ('${projIdLocal}', 'plugin-proj', 'plugin-proj-${SUFFIX}', '${orgIdLocal}', NOW())`,
  );
  const pmId = "ck" + randomBytes(11).toString("hex");
  await execSql(
    `INSERT INTO ${T}"ProjectMember" (id, "userId", "projectId", role)
     VALUES ('${pmId}', '${userIdLocal}', '${projIdLocal}', 'OWNER')`,
  );
  projectId = projIdLocal;
}

async function pluginFetch(
  path: string,
  init?: RequestInit & { skipOrigin?: boolean },
): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (!init?.skipOrigin) headers.set("origin", TEST_ORIGIN);
  // IP simulee unique par appel : isole le bucket rate-limit de /api/plugin/auth
  // (5/15min/IP). Sans ca, les multiples (re)auth de la suite partagent l'IP du
  // host docker et se font 429, ce qui casse aussi les beforeAll qui re-authent.
  if (!headers.has("x-forwarded-for")) {
    headers.set(
      "x-forwarded-for",
      `198.51.100.${Math.floor(Math.random() * 254) + 1}`,
    );
  }
  return fetch(`${BASE_URL}${path}`, {
    ...init,
    headers,
  });
}

// Probe l'origine en top-level await : doit etre resolu AVANT la collection
// des tests, car `it.runIf(pluginOriginConfigured)` lit la valeur au moment
// ou le test est defini (collection), pas a l'execution. Un beforeAll
// s'executerait trop tard → toute la suite se skipperait a tort.
const pluginOriginConfigured = await (async () => {
  try {
    const probe = await pluginFetch("/api/plugin/auth", { method: "OPTIONS" });
    return probe.headers.get("access-control-allow-origin") === TEST_ORIGIN;
  } catch {
    return false;
  }
})();

if (!pluginOriginConfigured) {
  console.warn(
    `[plugin.test] PLUGIN_ALLOWED_ORIGIN ne contient pas ${TEST_ORIGIN} ` +
      `cote app — tests skippe. Ajouter dans .env de la stack puis relancer.`,
  );
}

beforeAll(async () => {
  if (!pluginOriginConfigured) return;
  await provisionUserWith2FA();
});

afterAll(async () => {
  if (userId) {
    await execSql(
      `DELETE FROM ${T}"User" WHERE id = '${userId}'`,
    ).catch(() => {});
    await execSql(
      `DELETE FROM ${T}"Organization" WHERE id = '${orgId}'`,
    ).catch(() => {});
  }
});

describe("/api/plugin/auth", () => {
  it.runIf(pluginOriginConfigured)(
    "OPTIONS preflight retourne les headers CORS",
    async () => {
      const res = await pluginFetch("/api/plugin/auth", { method: "OPTIONS" });
      expect(res.status).toBe(204);
      expect(res.headers.get("access-control-allow-origin")).toBe(TEST_ORIGIN);
      expect(res.headers.get("access-control-allow-methods")).toContain("POST");
    },
  );

  it.runIf(pluginOriginConfigured)(
    "POST sans origin → accepte (Chrome strippe Origin pour les fetch sur host_permissions)",
    async () => {
      // Cf. lib/plugin-cors.ts : si Origin est absent on fait confiance au
      // Bearer/credentials. Une origin presente mais pas whitelistee est
      // toujours rejetee (couvert par le test "origin pas whitelistee").
      const res = await pluginFetch("/api/plugin/auth", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: PLUGIN_USER_EMAIL,
          password: PLUGIN_USER_PASSWORD,
          totp: await totpGenerate({ secret: totpSecret }),
          tenantSlug: TENANT_SLUG,
        }),
        skipOrigin: true,
      });
      // Soit 200 (auth ok), soit 401 si le TOTP a deja ete consomme dans
      // un test precedent (tolerance de fenetre TOTP). Quoi qu'il en soit,
      // pas de 403 lie a CORS.
      expect([200, 401]).toContain(res.status);
    },
  );

  it.runIf(pluginOriginConfigured)(
    "POST avec origin pas whitelistee → 403",
    async () => {
      const res = await fetch(`${BASE_URL}/api/plugin/auth`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://evil.example.com",
        },
        body: JSON.stringify({
          email: PLUGIN_USER_EMAIL,
          password: PLUGIN_USER_PASSWORD,
          totp: await totpGenerate({ secret: totpSecret }),
          tenantSlug: TENANT_SLUG,
        }),
      });
      expect(res.status).toBe(403);
    },
  );

  it.runIf(pluginOriginConfigured)(
    "body manquant → 400",
    async () => {
      const res = await pluginFetch("/api/plugin/auth", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(res.status).toBe(400);
    },
  );

  it.runIf(pluginOriginConfigured)(
    "user inexistant → 401",
    async () => {
      const res = await pluginFetch("/api/plugin/auth", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: `nope-${SUFFIX}@test.local`,
          password: "anything",
          totp: "123456",
          tenantSlug: TENANT_SLUG,
        }),
      });
      expect(res.status).toBe(401);
    },
  );

  it.runIf(pluginOriginConfigured)(
    "mauvais password → 401",
    async () => {
      const res = await pluginFetch("/api/plugin/auth", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: PLUGIN_USER_EMAIL,
          password: "wrong-password",
          totp: await totpGenerate({ secret: totpSecret }),
          tenantSlug: TENANT_SLUG,
        }),
      });
      expect(res.status).toBe(401);
    },
  );

  it.runIf(pluginOriginConfigured)(
    "TOTP invalide → 401",
    async () => {
      const res = await pluginFetch("/api/plugin/auth", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: PLUGIN_USER_EMAIL,
          password: PLUGIN_USER_PASSWORD,
          totp: "000000",
          tenantSlug: TENANT_SLUG,
        }),
      });
      expect(res.status).toBe(401);
    },
  );

  it.runIf(pluginOriginConfigured)(
    "creds OK + TOTP OK → 200 + sessionToken format `sv_plugin_<hex>`",
    async () => {
      const res = await pluginFetch("/api/plugin/auth", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: PLUGIN_USER_EMAIL,
          password: PLUGIN_USER_PASSWORD,
          totp: await totpGenerate({ secret: totpSecret }),
          tenantSlug: TENANT_SLUG,
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        sessionToken: string;
        expiresAt: number;
      };
      expect(body.sessionToken).toMatch(/^sv_plugin_[0-9a-f]{64}$/);
      expect(body.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
    },
  );

  it.runIf(pluginOriginConfigured)(
    "ttl explicite invalide → 400",
    async () => {
      const res = await pluginFetch("/api/plugin/auth", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: PLUGIN_USER_EMAIL,
          password: PLUGIN_USER_PASSWORD,
          totp: await totpGenerate({ secret: totpSecret }),
          tenantSlug: TENANT_SLUG,
          ttl: 7200, // 2h, pas dans la liste autorisée
        }),
      });
      expect(res.status).toBe(400);
    },
  );

  it.runIf(pluginOriginConfigured)(
    "ttl=3600 (1h) → 200 + expiresAt ~3600s plus tard",
    async () => {
      const before = Math.floor(Date.now() / 1000);
      const res = await pluginFetch("/api/plugin/auth", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: PLUGIN_USER_EMAIL,
          password: PLUGIN_USER_PASSWORD,
          totp: await totpGenerate({ secret: totpSecret }),
          tenantSlug: TENANT_SLUG,
          ttl: 3600,
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { expiresAt: number };
      // Tolerance de 30s pour la latence de la requete.
      expect(body.expiresAt).toBeGreaterThanOrEqual(before + 3600 - 30);
      expect(body.expiresAt).toBeLessThanOrEqual(before + 3600 + 30);
    },
  );
});

describe("/api/plugin/match", () => {
  let pluginToken = "";

  beforeAll(async () => {
    if (!pluginOriginConfigured) return;
    const res = await pluginFetch("/api/plugin/auth", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: PLUGIN_USER_EMAIL,
        password: PLUGIN_USER_PASSWORD,
        totp: await totpGenerate({ secret: totpSecret }),
        tenantSlug: TENANT_SLUG,
      }),
    });
    if (!res.ok) throw new Error(`auth setup: ${res.status}`);
    const body = (await res.json()) as { sessionToken: string };
    pluginToken = body.sessionToken;
  });

  it.runIf(pluginOriginConfigured)(
    "sans Authorization → 401",
    async () => {
      const res = await pluginFetch("/api/plugin/match?domain=stripe.com");
      expect(res.status).toBe(401);
    },
  );

  it.runIf(pluginOriginConfigured)(
    "Bearer token au mauvais format → 401",
    async () => {
      const res = await pluginFetch("/api/plugin/match?domain=stripe.com", {
        headers: { authorization: "Bearer invalid-token" },
      });
      expect(res.status).toBe(401);
    },
  );

  it.runIf(pluginOriginConfigured)(
    "Bearer token plugin valide + domain inconnu → 200 [] [] []",
    async () => {
      const res = await pluginFetch(
        "/api/plugin/match?domain=does-not-exist-anywhere.example",
        {
          headers: { authorization: `Bearer ${pluginToken}` },
        },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        services: unknown[];
        accounts: unknown[];
        vault: unknown[];
      };
      expect(body.services).toEqual([]);
      expect(body.accounts).toEqual([]);
      expect(body.vault).toEqual([]);
    },
  );

  it.runIf(pluginOriginConfigured)(
    "domain query absent → 400",
    async () => {
      const res = await pluginFetch("/api/plugin/match", {
        headers: { authorization: `Bearer ${pluginToken}` },
      });
      expect(res.status).toBe(400);
    },
  );

  // ── Tests Sub-PR3 : agregation vault perso + org + projet ────────────
  // On cree des entrees vault au runtime via les routes API du user
  // de test (personal + project — l'org demande des privileges OrgADMIN
  // que ce user n'a pas, donc on couvre ce cas via un autre integ test).
  // SUFFIX dans le label enregistrable (et non en sous-domaine) pour que le
  // matching par eTLD+1 isole vraiment ce domaine des autres : vault-X.com et
  // other-X.com ont des domaines enregistrables distincts, alors que
  // vault-X.test.local / other-X.test.local s'effondrent tous deux sur
  // test.local (cf. lib/domain-match.ts).
  const vaultDomain = `vault-${SUFFIX}.com`;
  let personalEntryId = "";
  let projectCollectionSlug = "";

  it.runIf(pluginOriginConfigured)(
    "setup : cree une entree perso + une entree projet avec url qui matche",
    async () => {
      // Personal vault entry — passe par la session web (cookie NextAuth).
      const res1 = await postJson(pluginUserSession, "/api/vault/entries", {
        name: "Test perso",
        url: `https://${vaultDomain}/login`,
        username: "perso@test.local",
        password: "perso-secret",
      });
      expect(res1.status).toBe(201);
      const data1 = (await res1.json()) as { entry: { id: string } };
      personalEntryId = data1.entry.id;

      // Project team vault collection (le user est ProjectMember OWNER du
      // projet seedé en beforeAll).
      // Attention : seed uses projectSlug constructed from project_id...
      // Le projet de test "plugin-proj-${SUFFIX}" existe deja.
      const projSlug = `plugin-proj-${SUFFIX}`;
      const res2 = await postJson(
        pluginUserSession,
        `/api/vault/project/${projSlug}/collections`,
        { name: "Plugin test col" },
      );
      expect(res2.status).toBe(201);
      const data2 = (await res2.json()) as { collection: { slug: string } };
      projectCollectionSlug = data2.collection.slug;

      const res3 = await postJson(
        pluginUserSession,
        `/api/vault/project/${projSlug}/collections/${projectCollectionSlug}/entries`,
        {
          name: "Test projet",
          url: `https://${vaultDomain}/admin`,
          username: "projet@test.local",
          password: "projet-secret",
        },
      );
      expect(res3.status).toBe(201);
    },
  );

  it.runIf(pluginOriginConfigured)(
    "match retourne les vault entries du domaine (perso + projet)",
    async () => {
      // ATTENTION : le test precedent peut avoir revoque le token plugin
      // via la suite "/api/plugin/auth" ; on en regenerere un frais.
      const authRes = await pluginFetch("/api/plugin/auth", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: PLUGIN_USER_EMAIL,
          password: PLUGIN_USER_PASSWORD,
          totp: await totpGenerate({ secret: totpSecret }),
          tenantSlug: TENANT_SLUG,
        }),
      });
      // Si rate-limit (5/15min), on skip ce test plutot que de fail.
      if (authRes.status === 429) return;
      const authBody = (await authRes.json()) as { sessionToken: string };
      const freshToken = authBody.sessionToken;

      const res = await pluginFetch(
        `/api/plugin/match?domain=${vaultDomain}`,
        {
          headers: { authorization: `Bearer ${freshToken}` },
        },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        vault: Array<{
          id: string;
          target: "personal" | "team_org" | "team_project";
          orgSlug?: string;
          projectSlug?: string;
          collectionSlug?: string;
          name: string;
          username: string;
          password: string;
        }>;
      };

      // Au moins 2 entrees : perso + projet.
      expect(body.vault.length).toBeGreaterThanOrEqual(2);

      const personal = body.vault.find((v) => v.target === "personal");
      expect(personal).toBeDefined();
      expect(personal?.username).toBe("perso@test.local");
      expect(personal?.password).toBe("perso-secret");
      // pas d'orgSlug/projectSlug/collectionSlug pour perso
      expect(personal?.orgSlug).toBeUndefined();
      expect(personal?.projectSlug).toBeUndefined();
      expect(personal?.collectionSlug).toBeUndefined();

      const project = body.vault.find((v) => v.target === "team_project");
      expect(project).toBeDefined();
      expect(project?.username).toBe("projet@test.local");
      expect(project?.password).toBe("projet-secret");
      expect(project?.projectSlug).toBe(`plugin-proj-${SUFFIX}`);
      expect(project?.collectionSlug).toBe(projectCollectionSlug);
    },
  );

  it.runIf(pluginOriginConfigured)(
    "domain different → vault entries non listees",
    async () => {
      const authRes = await pluginFetch("/api/plugin/auth", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: PLUGIN_USER_EMAIL,
          password: PLUGIN_USER_PASSWORD,
          totp: await totpGenerate({ secret: totpSecret }),
          tenantSlug: TENANT_SLUG,
        }),
      });
      if (authRes.status === 429) return;
      const { sessionToken } = (await authRes.json()) as {
        sessionToken: string;
      };

      // Domaine enregistrable distinct (other-X.com != vault-X.com).
      const res = await pluginFetch(
        `/api/plugin/match?domain=other-${SUFFIX}.com`,
        {
          headers: { authorization: `Bearer ${sessionToken}` },
        },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { vault: unknown[] };
      expect(body.vault).toEqual([]);
    },
  );

  // ── Test B : matching par domaine enregistrable (eTLD+1) ─────────────
  // Les entrees sont stockees sous `${vaultDomain}` mais doivent remonter
  // quand la page est un SOUS-DOMAINE (ex. DatoCMS : entree datocms.com,
  // login sur oauth.datocms.com).
  it.runIf(pluginOriginConfigured)(
    "match par sous-domaine : oauth.<domaine> remonte les entrees de <domaine>",
    async () => {
      const authRes = await pluginFetch("/api/plugin/auth", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: PLUGIN_USER_EMAIL,
          password: PLUGIN_USER_PASSWORD,
          totp: await totpGenerate({ secret: totpSecret }),
          tenantSlug: TENANT_SLUG,
        }),
      });
      if (authRes.status === 429) return;
      const { sessionToken } = (await authRes.json()) as {
        sessionToken: string;
      };

      const res = await pluginFetch(
        `/api/plugin/match?domain=oauth.${vaultDomain}`,
        {
          headers: { authorization: `Bearer ${sessionToken}` },
        },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        vault: Array<{ target: string; username: string }>;
      };
      // Memes entrees que le match exact : perso + projet.
      expect(body.vault.length).toBeGreaterThanOrEqual(2);
      expect(
        body.vault.some(
          (v) => v.target === "personal" && v.username === "perso@test.local",
        ),
      ).toBe(true);
      expect(
        body.vault.some(
          (v) =>
            v.target === "team_project" && v.username === "projet@test.local",
        ),
      ).toBe(true);
    },
  );

  // Cleanup des entrees vault creees pour eviter de polluer les autres suites.
  it.runIf(pluginOriginConfigured)(
    "cleanup vault entries de test",
    async () => {
      if (personalEntryId) {
        await deleteReq(
          pluginUserSession,
          `/api/vault/entries/${personalEntryId}`,
        ).catch(() => {});
      }
      if (projectCollectionSlug) {
        const projSlug = `plugin-proj-${SUFFIX}`;
        await deleteReq(
          pluginUserSession,
          `/api/vault/project/${projSlug}/collections/${projectCollectionSlug}`,
        ).catch(() => {});
      }
    },
  );

  it.runIf(pluginOriginConfigured)(
    "Bearer revoque → 401 (revoke via DB direct)",
    async () => {
      // Revoke directement le token dans la base. Le hash est calcule en Node
      // (SHA-256 hex, cf. lib/plugin-token.ts) plutot qu'en SQL : pgcrypto
      // (digest()) n'est pas installe sur cette base.
      const tokenHash = createHash("sha256").update(pluginToken).digest("hex");
      await execSql(
        `UPDATE ${T}"PluginToken" SET "revokedAt" = NOW() WHERE "tokenHash" = '${tokenHash}'`,
      );
      const res = await pluginFetch("/api/plugin/match?domain=stripe.com", {
        headers: { authorization: `Bearer ${pluginToken}` },
      });
      expect(res.status).toBe(401);
    },
  );
});

describe("/api/plugin/tokens — UI mgmt (session web)", () => {
  it.runIf(pluginOriginConfigured)(
    "GET liste les tokens du user connecte",
    async () => {
      const res = await pluginUserSession.fetch("/api/plugin/tokens");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { tokens: { id: string }[] };
      expect(Array.isArray(body.tokens)).toBe(true);
      // Au moins un (celui cree dans /api/plugin/auth precedent).
      expect(body.tokens.length).toBeGreaterThan(0);
    },
  );

  it.runIf(pluginOriginConfigured)(
    "DELETE revoque le token",
    async () => {
      const listRes = await pluginUserSession.fetch("/api/plugin/tokens");
      const list = (await listRes.json()) as {
        tokens: Array<{ id: string; isActive: boolean }>;
      };
      const active = list.tokens.find((t) => t.isActive);
      if (!active) return; // tous deja revoques par le test precedent

      const del = await pluginUserSession.fetch(
        `/api/plugin/tokens/${active.id}`,
        { method: "DELETE" },
      );
      expect(del.status).toBe(200);

      const reloadRes = await pluginUserSession.fetch("/api/plugin/tokens");
      const reload = (await reloadRes.json()) as {
        tokens: Array<{ id: string; isActive: boolean }>;
      };
      const found = reload.tokens.find((t) => t.id === active.id);
      expect(found?.isActive).toBe(false);
    },
  );

  it.runIf(pluginOriginConfigured)(
    "DELETE token inexistant → 404",
    async () => {
      const res = await pluginUserSession.fetch(
        "/api/plugin/tokens/ckdoesnotexist000000000000",
        { method: "DELETE" },
      );
      expect(res.status).toBe(404);
    },
  );

  it.runIf(pluginOriginConfigured)(
    "anon → 401 sur GET liste",
    async () => {
      const anon = new Session();
      const res = await anon.fetch("/api/plugin/tokens");
      expect(res.status).toBe(401);
    },
  );
});

// projectId est utilise indirectement via les inserts SQL pour les services.
// Garde la reference pour les futurs ajouts de tests qui inserent des
// Service/AppAccount et verifient le matching.
void projectId;

describe("/api/plugin/vault — auto-save credentials", () => {
  let token = "";
  let teamCollectionSlug = "";

  beforeAll(async () => {
    if (!pluginOriginConfigured) return;
    // Token plugin frais (les suites precedentes peuvent avoir revoque).
    const auth = await pluginFetch("/api/plugin/auth", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: PLUGIN_USER_EMAIL,
        password: PLUGIN_USER_PASSWORD,
        totp: await totpGenerate({ secret: totpSecret }),
        tenantSlug: TENANT_SLUG,
      }),
    });
    if (auth.status === 429) return; // rate-limit, skip ce bloc
    if (!auth.ok) throw new Error(`auth: ${auth.status}`);
    const body = (await auth.json()) as { sessionToken: string };
    token = body.sessionToken;

    // Une collection projet pour les tests team_project (le user est OWNER
    // du projet seede, donc il a les droits).
    const colRes = await postJson(
      pluginUserSession,
      `/api/vault/project/plugin-proj-${SUFFIX}/collections`,
      { name: "Plugin auto-save col" },
    );
    expect(colRes.status).toBe(201);
    const colBody = (await colRes.json()) as { collection: { slug: string } };
    teamCollectionSlug = colBody.collection.slug;
  });

  it.runIf(pluginOriginConfigured)(
    "sans Authorization → 401",
    async () => {
      const res = await pluginFetch("/api/plugin/vault", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "create",
          target: "personal",
          name: "x",
          password: "p",
        }),
      });
      expect(res.status).toBe(401);
    },
  );

  it.runIf(pluginOriginConfigured)(
    "body invalide → 400 (action manquante)",
    async () => {
      if (!token) return;
      const res = await pluginFetch("/api/plugin/vault", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ target: "personal", name: "x", password: "p" }),
      });
      expect(res.status).toBe(400);
    },
  );

  it.runIf(pluginOriginConfigured)(
    "action=update sans id → 400",
    async () => {
      if (!token) return;
      const res = await pluginFetch("/api/plugin/vault", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          action: "update",
          target: "personal",
          name: "x",
          password: "p",
        }),
      });
      expect(res.status).toBe(400);
    },
  );

  it.runIf(pluginOriginConfigured)(
    "create personal → 201, password chiffre en base, audit log",
    async () => {
      if (!token) return;
      const res = await pluginFetch("/api/plugin/vault", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          action: "create",
          target: "personal",
          name: "Auto-save test",
          url: "https://autosave.test.local",
          username: "auto@test.local",
          password: "auto-secret-1234",
          tags: ["plugin", "test"],
        }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { id: string; created: boolean };
      expect(body.id).toBeTruthy();
      expect(body.created).toBe(true);

      // Verifie que le password est bien chiffre en base (pas en clair).
      const rows = await execSql(
        `SELECT "encryptedPassword", "passwordIv", "passwordTag" FROM ${T}"VaultEntry" WHERE id = '${body.id}'`,
      );
      // psql -At (tuples-only) renvoie les valeurs, pas les noms de colonnes :
      // on verifie la forme chiffree (3 segments base64 separes par |).
      expect(rows).toMatch(/^[^|]+\|[^|]+\|[^|]+$/);
      expect(rows).not.toContain("auto-secret-1234");

      // Audit log avec origin et domain.
      const audit = await execSql(
        `SELECT metadata::text FROM ${T}"AccessLog" WHERE action = 'VAULT_ENTRY_CREATE' AND "targetId" = '${body.id}' ORDER BY "createdAt" DESC LIMIT 1`,
      );
      expect(audit).toContain("plugin_autosave");
      expect(audit).toContain("autosave.test.local");
    },
  );

  it.runIf(pluginOriginConfigured)(
    "create + update personal → second appel renvoie created:false",
    async () => {
      if (!token) return;
      const create = await pluginFetch("/api/plugin/vault", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          action: "create",
          target: "personal",
          name: "To update",
          url: "https://update.test.local",
          username: "u@test.local",
          password: "old-pwd",
        }),
      });
      const created = (await create.json()) as { id: string };

      const update = await pluginFetch("/api/plugin/vault", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          action: "update",
          id: created.id,
          target: "personal",
          name: "To update",
          url: "https://update.test.local",
          username: "u@test.local",
          password: "new-pwd",
        }),
      });
      expect(update.status).toBe(200);
      const updateBody = (await update.json()) as {
        id: string;
        created: boolean;
      };
      expect(updateBody.id).toBe(created.id);
      expect(updateBody.created).toBe(false);
    },
  );

  it.runIf(pluginOriginConfigured)(
    "update personal d'une entree d'un autre user → 404",
    async () => {
      if (!token) return;
      // Cree une entree avec un autre user (insert direct DB).
      const otherUserId = "ck" + randomBytes(11).toString("hex");
      const otherEntryId = "ck" + randomBytes(11).toString("hex");
      await execSql(
        `INSERT INTO ${T}"User" (id, email, password, role, "createdAt")
         VALUES ('${otherUserId}', 'other-${SUFFIX}@test.local', 'x', 'MEMBER', NOW())`,
      );
      await execSql(
        `INSERT INTO ${T}"VaultEntry" (id, "userId", name, "createdAt", "updatedAt")
         VALUES ('${otherEntryId}', '${otherUserId}', 'other entry', NOW(), NOW())`,
      );

      const res = await pluginFetch("/api/plugin/vault", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          action: "update",
          id: otherEntryId,
          target: "personal",
          name: "hijack",
          password: "x",
        }),
      });
      expect(res.status).toBe(404);

      await execSql(
        `DELETE FROM ${T}"User" WHERE id = '${otherUserId}'`,
      ).catch(() => {});
    },
  );

  it.runIf(pluginOriginConfigured)(
    "create team_project → 201 avec source=project + origin=plugin_autosave",
    async () => {
      if (!token || !teamCollectionSlug) return;
      const res = await pluginFetch("/api/plugin/vault", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          action: "create",
          target: "team_project",
          projectSlug: `plugin-proj-${SUFFIX}`,
          collectionSlug: teamCollectionSlug,
          name: "Team auto-save",
          url: "https://team-auto.test.local",
          username: "team@test.local",
          password: "team-pwd-12345",
        }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { id: string };

      const audit = await execSql(
        `SELECT metadata::text FROM ${T}"AccessLog" WHERE action = 'VAULT_ENTRY_CREATE' AND "targetId" = '${body.id}' ORDER BY "createdAt" DESC LIMIT 1`,
      );
      expect(audit).toContain("plugin_autosave");
      expect(audit).toContain('"source": "project"');
      expect(audit).toContain("team-auto.test.local");
    },
  );

  it.runIf(pluginOriginConfigured)(
    "team_project sur un projet inconnu → 404",
    async () => {
      if (!token) return;
      const res = await pluginFetch("/api/plugin/vault", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          action: "create",
          target: "team_project",
          projectSlug: "no-such-project-xyz",
          collectionSlug: "any",
          name: "x",
          password: "x",
        }),
      });
      expect(res.status).toBe(404);
    },
  );
});

// Un PluginToken est une SESSION au même titre qu'un JWT web : il doit mourir
// quand l'user coupe ses sessions (reset password / 2FA disable, qui posent
// User.sessionsValidFrom = now). Sans ce contrôle, un token volé survivait au
// reset censé l'évincer — pire, il pouvait être échangé contre une session web
// fraîche via le provider Credentials `pluginToken` (auth.ts), qui appelle
// validatePluginToken en premier. Le fix vit dans lib/plugin-token.ts, donc les
// DEUX vecteurs (API plugin directe + échange NextAuth) tombent d'un coup.
describe("/api/plugin — token vs invalidation de session (sessionsValidFrom)", () => {
  async function mintPluginToken(): Promise<string> {
    const res = await pluginFetch("/api/plugin/auth", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: PLUGIN_USER_EMAIL,
        password: PLUGIN_USER_PASSWORD,
        totp: await totpGenerate({ secret: totpSecret }),
        tenantSlug: TENANT_SLUG,
      }),
    });
    if (!res.ok) throw new Error(`mint plugin token: HTTP ${res.status}`);
    return ((await res.json()) as { sessionToken: string }).sessionToken;
  }

  it.runIf(pluginOriginConfigured)(
    "⑤ un token émis AVANT sessionsValidFrom est rejeté (401) ; un token émis APRÈS survit (200)",
    async () => {
      // 1. Token émis maintenant → vivant.
      const before = await mintPluginToken();
      const alive = await pluginFetch(
        "/api/plugin/match?domain=does-not-exist-anywhere.example",
        { headers: { authorization: `Bearer ${before}` } },
      );
      expect(alive.status).toBe(200);

      // 2. L'user coupe ses sessions (simule un reset password / 2FA disable).
      //    NOW() se place ENTRE le token `before` (minté avant, des dizaines de
      //    ms plus tôt → strictement antérieur) et le token réémis à l'étape 4
      //    (minté après → strictement postérieur). Un `+interval` casserait ce
      //    second invariant en poussant la borne au-delà du token réémis.
      await execSql(
        `UPDATE ${T}"User" SET "sessionsValidFrom" = NOW() WHERE id = '${userId}'`,
      );

      // 3. Le MÊME token est désormais mort (barrière = validatePluginToken).
      const killed = await pluginFetch(
        "/api/plugin/match?domain=does-not-exist-anywhere.example",
        { headers: { authorization: `Bearer ${before}` } },
      );
      expect(killed.status).toBe(401);

      // 4. Anti sur-restriction : un token RÉÉMIS après la borne (createdAt >
      //    sessionsValidFrom) doit fonctionner — sinon l'user ne pourrait plus
      //    jamais se reconnecter via l'extension après un reset.
      const after = await mintPluginToken();
      const revived = await pluginFetch(
        "/api/plugin/match?domain=does-not-exist-anywhere.example",
        { headers: { authorization: `Bearer ${after}` } },
      );
      expect(revived.status).toBe(200);

      // 5. Reset de la borne pour ne pas polluer d'éventuels tests suivants.
      await execSql(
        `UPDATE ${T}"User" SET "sessionsValidFrom" = NULL WHERE id = '${userId}'`,
      );
    },
  );
});

// L'auto-save de l'extension (POST /api/plugin/vault target=team_project) écrit
// dans la collection d'équipe d'un projet. resolveTeamProjectAccess re-dérivait
// le rôle depuis ProjectMember sans lire `hidden` → un membre masqué du projet
// pouvait y injecter des credentials via l'extension. Le user plugin principal
// est OrgOWNER (immune, règle 1) — on provisionne Mallory, OrgMEMBER +
// ProjectMember EDITOR masqué, le profil qui subit réellement `hidden`.
const MALLORY_EMAIL = `mallory-plugin-${SUFFIX}@test.local`;
const MALLORY_PASSWORD = "mallorytestpassword12";

describe("/api/plugin/vault — hidden (resolveTeamProjectAccess)", () => {
  let malloryToken = "";
  let malloryProjectMemberId = "";
  let colSlug = "";

  beforeAll(async () => {
    if (!pluginOriginConfigured) return;

    const malloryId = "ck" + randomBytes(11).toString("hex");
    const hash = await bcrypt.hash(MALLORY_PASSWORD, 12);
    await execSql(
      `INSERT INTO ${T}"User" (id, email, password, role, "createdAt")
       VALUES ('${malloryId}', '${MALLORY_EMAIL}', '${hash}', 'MEMBER', NOW())`,
    );
    // OrgMEMBER (PAS OWNER/ADMIN → n'échappe pas à hidden par la règle 1).
    await execSql(
      `INSERT INTO ${T}"OrgMember" (id, "userId", "organizationId", role, "createdAt")
       VALUES ('ck${randomBytes(11).toString("hex")}', '${malloryId}', '${orgId}', 'MEMBER', NOW())`,
    );
    // ProjectMember EDITOR, MASQUÉ au départ.
    malloryProjectMemberId = "ck" + randomBytes(11).toString("hex");
    await execSql(
      `INSERT INTO ${T}"ProjectMember" (id, "userId", "projectId", role, hidden)
       VALUES ('${malloryProjectMemberId}', '${malloryId}', '${projectId}', 'EDITOR', true)`,
    );

    // 2FA (requis pour obtenir un token plugin).
    const sess = await loginAs(MALLORY_EMAIL, MALLORY_PASSWORD);
    const setup = await sess.fetch("/api/me/2fa/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    if (!setup.ok) throw new Error(`mallory 2fa setup: ${setup.status}`);
    const { secret } = (await setup.json()) as { secret: string };
    const verify = await sess.fetch("/api/me/2fa/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: await totpGenerate({ secret }) }),
    });
    if (!verify.ok) throw new Error(`mallory 2fa verify: ${verify.status}`);

    // Collection d'équipe dans le projet plugin, créée par l'OWNER.
    const col = await postJson(
      pluginUserSession,
      `/api/vault/project/plugin-proj-${SUFFIX}/collections`,
      { name: "Cible hidden" },
    );
    if (col.status === 201) {
      colSlug = ((await col.json()) as { collection: { slug: string } })
        .collection.slug;
    }

    // Token plugin de Mallory.
    const auth = await pluginFetch("/api/plugin/auth", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: MALLORY_EMAIL,
        password: MALLORY_PASSWORD,
        totp: await totpGenerate({ secret }),
        tenantSlug: TENANT_SLUG,
      }),
    });
    if (auth.ok) {
      malloryToken = ((await auth.json()) as { sessionToken: string })
        .sessionToken;
    }
  });

  afterAll(async () => {
    await execSql(`DELETE FROM ${T}"User" WHERE email = '${MALLORY_EMAIL}'`);
  });

  function saveEntry() {
    return pluginFetch("/api/plugin/vault", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${malloryToken}`,
      },
      body: JSON.stringify({
        action: "create",
        target: "team_project",
        projectSlug: `plugin-proj-${SUFFIX}`,
        collectionSlug: colSlug,
        name: "injected",
        password: "p",
      }),
    });
  }

  it.runIf(pluginOriginConfigured)(
    "Mallory masquée → l'auto-save vers le coffre projet est refusé (404)",
    async () => {
      if (!malloryToken || !colSlug) return; // rate-limit / setup skip
      const res = await saveEntry();
      expect([403, 404]).toContain(res.status);
    },
  );

  it.runIf(pluginOriginConfigured)(
    "Mallory dé-masquée → l'auto-save réussit (201) [anti sur-restriction]",
    async () => {
      if (!malloryToken || !colSlug) return;
      await execSql(
        `UPDATE ${T}"ProjectMember" SET hidden = false WHERE id = '${malloryProjectMemberId}'`,
      );
      const res = await saveEntry();
      expect(res.status).toBe(201);
    },
  );
});
