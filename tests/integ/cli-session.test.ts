// C-0050 (agent-ssh), phase 2 — session CLI par flux d'appareil, contre la
// stack réelle.
//
// Prouve les cellules `cli_session × explicit_revoke` et
// `cli_session × password_reset` de la matrice de révocation
// (tests/lib/revocation-matrix.test.ts), et le contrat du flux figé côté CLI
// (physalis-cli/src/device.ts) : start → pending → slow_down → approbation →
// jeton rendu UNE fois → révocation.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes, createHash } from "node:crypto";
import {
  BASE_URL,
  Session,
  adminSession,
  postJson,
  deleteReq,
  TENANT_HOST,
  TENANT_SLUG,
  TENANT_SCHEMA,
} from "./helpers/api";
import { execSql, execSqlValue } from "./helpers/db";
import { cuid } from "./helpers/org";

const DEVICE_PREFIX = "integ-cli-";
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Requête CLI : pas de cookie, l'instance se lit sur l'hôte. IP propre au run.
 *  `x-forwarded-proto` simule le proxy de prod (NPM), qui le pose toujours. */
const cliIp = `10.77.${randomBytes(1)[0]}.${randomBytes(1)[0]}`;
function cli(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("x-forwarded-host", TENANT_HOST);
  headers.set("x-forwarded-proto", "https");
  headers.set("x-forwarded-for", cliIp);
  if (init.body) headers.set("content-type", "application/json");
  return fetch(`${BASE_URL}${path}`, { ...init, headers });
}

type Started = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
};

async function start(name: string): Promise<Started> {
  const res = await cli("/api/cli/device/start", {
    method: "POST",
    body: JSON.stringify({ deviceName: `${DEVICE_PREFIX}${name}`, kind: "HUMAN" }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as Started;
}

function poll(deviceCode: string): Promise<Response> {
  return cli("/api/cli/device/poll", {
    method: "POST",
    body: JSON.stringify({ deviceCode }),
  });
}

/** Oublie le dernier poll : évite d'attendre l'intervalle entre deux assertions. */
async function resetPollClock(userCode: string): Promise<void> {
  await execSql(
    `UPDATE "${TENANT_SCHEMA}"."CliDeviceAuthorization" SET "lastPolledAt" = NULL WHERE "userCode" = '${userCode}'`,
  );
}

async function approveAndGetToken(admin: Session, name: string): Promise<string> {
  const s = await start(name);
  const decided = await postJson(admin, "/api/cli/device/decide", { code: s.userCode, approve: true });
  expect(decided.status).toBe(200);
  const res = await poll(s.deviceCode);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { token: string };
  return body.token;
}

function logout(token: string): Promise<Response> {
  return cli("/api/cli/session", {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` },
  });
}

let admin: Session;
let adminUserId = "";
let previousValidFrom = "";

beforeAll(async () => {
  admin = await adminSession();
  adminUserId = await execSqlValue(
    `SELECT id FROM "${TENANT_SCHEMA}"."User" WHERE email = 'admin@artpotentiel.fr'`,
  );
  previousValidFrom = await execSqlValue(
    `SELECT COALESCE("sessionsValidFrom"::text, '') FROM "${TENANT_SCHEMA}"."User" WHERE id = '${adminUserId}'`,
  );
});

afterAll(async () => {
  await execSql(
    `UPDATE "${TENANT_SCHEMA}"."User" SET "sessionsValidFrom" = ${
      previousValidFrom ? `'${previousValidFrom}'` : "NULL"
    } WHERE id = '${adminUserId}'`,
  );
  await execSql(
    `DELETE FROM admin.token_index WHERE kind = 'CLI' AND tenant_slug = '${TENANT_SLUG}'
       AND token_hash IN (SELECT "tokenHash" FROM "${TENANT_SCHEMA}"."CliSession" WHERE "deviceName" LIKE '${DEVICE_PREFIX}%')`,
  );
  await execSql(`DELETE FROM "${TENANT_SCHEMA}"."CliSession" WHERE "deviceName" LIKE '${DEVICE_PREFIX}%'`);
  await execSql(
    `DELETE FROM "${TENANT_SCHEMA}"."CliDeviceAuthorization" WHERE "deviceName" LIKE '${DEVICE_PREFIX}%'`,
  );
});

describe("flux d'appareil — parcours nominal", () => {
  it("start → pending → slow_down → approbation → jeton rendu une seule fois", async () => {
    const s = await start("nominal");
    expect(s.userCode).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
    expect(s.deviceCode).toMatch(/^[0-9a-f]{64}$/);
    expect(s.verificationUri).toBe(`https://${TENANT_HOST}/account/cli`);
    expect(s.verificationUriComplete).toBe(`${s.verificationUri}?code=${s.userCode}`);
    expect(s.interval).toBe(5);

    // Avant décision : en attente, puis trop rapide.
    let res = await poll(s.deviceCode);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "authorization_pending" });
    res = await poll(s.deviceCode);
    expect(await res.json()).toEqual({ error: "slow_down" });

    // La page d'approbation montre la demande, pour que l'utilisateur la reconnaisse.
    const lookup = await admin.fetch(`/api/cli/device?code=${s.userCode.toLowerCase().replace("-", " ")}`);
    expect(lookup.status).toBe(200);
    const { device } = (await lookup.json()) as { device: { deviceName: string; ip: string } };
    expect(device.deviceName).toBe(`${DEVICE_PREFIX}nominal`);
    expect(device.ip).toBe(cliIp);

    const decided = await postJson(admin, "/api/cli/device/decide", { code: s.userCode, approve: true });
    expect(decided.status).toBe(200);

    // Une demande décidée ne se re-décide pas.
    const again = await postJson(admin, "/api/cli/device/decide", { code: s.userCode, approve: false });
    expect(again.status).toBe(404);

    await resetPollClock(s.userCode);
    res = await poll(s.deviceCode);
    expect(res.status).toBe(200);
    const grant = (await res.json()) as { token: string; expiresAt: number; email: string };
    expect(grant.token).toMatch(/^sv_cli_[0-9a-f]{64}$/);
    expect(grant.email).toBe("admin@artpotentiel.fr");
    const hours = (grant.expiresAt * 1000 - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(11.9);
    expect(hours).toBeLessThanOrEqual(12);

    // Seul le hash est stocké.
    const stored = await execSqlValue(
      `SELECT "tokenHash" FROM "${TENANT_SCHEMA}"."CliSession" WHERE "deviceName" = '${DEVICE_PREFIX}nominal'`,
    );
    expect(stored).toBe(sha256(grant.token));

    // Le jeton n'est rendu qu'une fois : le poll suivant voit une demande consommée.
    await resetPollClock(s.userCode);
    res = await poll(s.deviceCode);
    expect(await res.json()).toEqual({ error: "expired_token" });
  });

  it("refus dans le navigateur → access_denied, et aucune session créée", async () => {
    const s = await start("refus");
    const decided = await postJson(admin, "/api/cli/device/decide", { code: s.userCode, approve: false });
    expect(decided.status).toBe(200);
    const res = await poll(s.deviceCode);
    expect(await res.json()).toEqual({ error: "access_denied" });
    const count = await execSqlValue(
      `SELECT count(*) FROM "${TENANT_SCHEMA}"."CliSession" WHERE "deviceName" = '${DEVICE_PREFIX}refus'`,
    );
    expect(count).toBe("0");
  });

  it("un code appareil inconnu ou malformé → expired_token", async () => {
    const res = await poll(randomBytes(32).toString("hex"));
    expect(await res.json()).toEqual({ error: "expired_token" });
    const bad = await poll("pas-un-code");
    expect(bad.status).toBe(400);
  });

  it("une instance inconnue (hôte sans tenant) est refusée", async () => {
    const res = await fetch(`${BASE_URL}/api/cli/device/start`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": cliIp },
      body: JSON.stringify({ deviceName: `${DEVICE_PREFIX}inconnue` }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "unknown_instance" });
  });

  it("approuver exige une session web ; un code invalide ou inconnu est refusé", async () => {
    const anon = new Session();
    expect((await postJson(anon, "/api/cli/device/decide", { code: "BCDF-GHJK", approve: true })).status).toBe(401);
    expect((await postJson(admin, "/api/cli/device/decide", { code: "AEIO-U123", approve: true })).status).toBe(400);
    expect((await postJson(admin, "/api/cli/device/decide", { code: "BCDF-GHJK", approve: "oui" })).status).toBe(400);
    expect((await postJson(admin, "/api/cli/device/decide", { code: "ZZZZ-ZZZZ", approve: true })).status).toBe(404);
  });
});

describe("pages", () => {
  it("/account/cli s'affiche pour un utilisateur connecté, en français", async () => {
    const res = await admin.fetch("/fr/account/cli?code=BCDF-GHJK", {
      headers: { "x-forwarded-host": TENANT_HOST },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Connecter un terminal");
    expect(html).toContain("Code affiché dans le terminal");
  });
});

describe("révocation (matrice cli_session)", () => {
  it("explicit_revoke — physalis logout : 204 puis 401", async () => {
    const token = await approveAndGetToken(admin, "logout");
    expect((await logout(token)).status).toBe(204);
    expect((await logout(token)).status).toBe(401);
  });

  it("explicit_revoke — depuis /account : la session listée se coupe", async () => {
    const token = await approveAndGetToken(admin, "compte");
    const list = await admin.fetch("/api/cli/sessions");
    expect(list.status).toBe(200);
    const { sessions } = (await list.json()) as {
      sessions: { id: string; deviceName: string; isActive: boolean; tokenHash?: string }[];
    };
    const mine = sessions.find((x) => x.deviceName === `${DEVICE_PREFIX}compte`);
    expect(mine?.isActive).toBe(true);
    expect(mine && "tokenHash" in mine).toBe(false);

    expect((await deleteReq(admin, `/api/cli/sessions/${mine!.id}`)).status).toBe(200);
    expect((await logout(token)).status).toBe(401);
  });

  it("explicit_revoke — l'id d'une session inconnue → 404", async () => {
    expect((await deleteReq(admin, "/api/cli/sessions/ck-inexistant")).status).toBe(404);
  });

  it("password_reset — une session antérieure à sessionsValidFrom est refusée", async () => {
    const token = await approveAndGetToken(admin, "reset");
    // Reculer la session d'une heure puis poser la borne entre les deux : même
    // effet qu'un reset de mot de passe survenu après l'émission, sans couper
    // la session web de l'admin utilisée par le reste du fichier.
    await execSql(
      `UPDATE "${TENANT_SCHEMA}"."CliSession" SET "createdAt" = NOW() - interval '1 hour'
         WHERE "tokenHash" = '${sha256(token)}'`,
    );
    await execSql(
      `UPDATE "${TENANT_SCHEMA}"."User" SET "sessionsValidFrom" = NOW() - interval '30 minutes'
         WHERE id = '${adminUserId}'`,
    );
    expect((await logout(token)).status).toBe(401);
  });
});

// ─── Phase 2b (T-0287) : physalis run avec la session de l'utilisateur ────────

const RUN = `cli-run-${Date.now()}`;
let projectA = "";
let projectB = "";
let memberId = "";

async function createProjectWithSecret(name: string, value: string): Promise<string> {
  const res = await postJson(admin, "/api/projects", { name });
  if (res.status !== 201) throw new Error(`setup project failed: ${res.status}`);
  const { project } = (await res.json()) as { project: { slug: string } };
  const sec = await postJson(admin, `/api/projects/${project.slug}/development/secrets`, {
    key: "API_KEY",
    value,
  });
  if (sec.status !== 201 && sec.status !== 200) throw new Error(`setup secret failed: ${sec.status}`);
  return project.slug;
}

/** Session CLI posée en base (sans flux d'appareil) pour un utilisateur donné. */
async function seedCliSession(userId: string, kind = "HUMAN"): Promise<string> {
  const token = "sv_cli_" + randomBytes(32).toString("hex");
  await execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."CliSession" (id, "tokenHash", "userId", kind, "deviceName", "expiresAt", "createdAt")
     VALUES ('${cuid()}', '${sha256(token)}', '${userId}', '${kind}', '${DEVICE_PREFIX}${kind.toLowerCase()}-seed', NOW() + interval '12 hours', NOW())`,
  );
  await execSql(
    `INSERT INTO admin.token_index (token_hash, tenant_slug, kind, created_at)
     VALUES ('${sha256(token)}', '${TENANT_SLUG}', 'CLI', NOW())`,
  );
  return token;
}

function readSecrets(token: string, slug: string, env = "development"): Promise<Response> {
  return fetch(`${BASE_URL}/api/secrets/${slug}/${env}`, {
    headers: { authorization: `Bearer ${token}`, "x-forwarded-for": cliIp },
  });
}

async function orgOf(slug: string): Promise<string> {
  return execSqlValue(`SELECT "organizationId" FROM "${TENANT_SCHEMA}"."Project" WHERE slug = '${slug}'`);
}

async function projectIdOf(slug: string): Promise<string> {
  return execSqlValue(`SELECT id FROM "${TENANT_SCHEMA}"."Project" WHERE slug = '${slug}'`);
}

describe("physalis run — une session, tous les projets de l'utilisateur (T-0287)", () => {
  beforeAll(async () => {
    projectA = await createProjectWithSecret(`${RUN}-a`, "valeur-a");
    projectB = await createProjectWithSecret(`${RUN}-b`, "valeur-b");
    memberId = cuid();
    await execSql(
      `INSERT INTO "${TENANT_SCHEMA}"."User" (id, email, "createdAt")
       VALUES ('${memberId}', '${RUN}-member@test.local', NOW())`,
    );
    expect(await execSqlValue(`SELECT count(*) FROM "${TENANT_SCHEMA}"."User" WHERE id = '${memberId}'`)).toBe("1");
  });

  afterAll(async () => {
    for (const slug of [projectA, projectB]) {
      if (slug) await deleteReq(admin, `/api/projects/${slug}`);
    }
    if (memberId) await execSql(`DELETE FROM "${TENANT_SCHEMA}"."User" WHERE id = '${memberId}'`);
  });

  it("un seul login lit deux projets différents, sans token par projet", async () => {
    const token = await approveAndGetToken(admin, "run");
    const a = await readSecrets(token, projectA);
    expect(a.status).toBe(200);
    expect(await a.json()).toEqual({ secrets: { API_KEY: "valeur-a" } });
    const b = await readSecrets(token, projectB);
    expect(await b.json()).toEqual({ secrets: { API_KEY: "valeur-b" } });
  });

  it("projet ou environnement inexistant → 404", async () => {
    const token = await approveAndGetToken(admin, "run-404");
    expect((await readSecrets(token, `${RUN}-inexistant`)).status).toBe(404);
    expect((await readSecrets(token, projectA, "nulle-part")).status).toBe(404);
  });

  it("org_member_removal / project_hidden : les droits sont re-dérivés à chaque requête", async () => {
    const token = await seedCliSession(memberId);
    const orgId = await orgOf(projectA);
    const projectId = await projectIdOf(projectA);

    // Pas membre de l'org → 403.
    expect((await readSecrets(token, projectA)).status).toBe(403);

    // MEMBER de l'org sans ligne projet → 403 (un MEMBER doit être ajouté explicitement).
    await execSql(
      `INSERT INTO "${TENANT_SCHEMA}"."OrgMember" (id, "userId", "organizationId", role, "createdAt")
       VALUES ('${cuid()}', '${memberId}', '${orgId}', 'MEMBER', NOW())`,
    );
    expect((await readSecrets(token, projectA)).status).toBe(403);

    // Ligne VIEWER visible → lecture.
    await execSql(
      `INSERT INTO "${TENANT_SCHEMA}"."ProjectMember" (id, "userId", "projectId", role, hidden)
       VALUES ('${cuid()}', '${memberId}', '${projectId}', 'VIEWER', false)`,
    );
    const ok = await readSecrets(token, projectA);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ secrets: { API_KEY: "valeur-a" } });
    // …mais pas l'autre projet, où il n'a pas de ligne.
    expect((await readSecrets(token, projectB)).status).toBe(403);

    // hidden = BARRIÈRE d'accès.
    await execSql(
      `UPDATE "${TENANT_SCHEMA}"."ProjectMember" SET hidden = true WHERE "userId" = '${memberId}' AND "projectId" = '${projectId}'`,
    );
    expect((await readSecrets(token, projectA)).status).toBe(403);

    // Retrait de l'org → 403, même avec une ligne projet visible.
    await execSql(
      `UPDATE "${TENANT_SCHEMA}"."ProjectMember" SET hidden = false WHERE "userId" = '${memberId}' AND "projectId" = '${projectId}'`,
    );
    expect((await readSecrets(token, projectA)).status).toBe(200);
    await execSql(
      `DELETE FROM "${TENANT_SCHEMA}"."OrgMember" WHERE "userId" = '${memberId}' AND "organizationId" = '${orgId}'`,
    );
    expect((await readSecrets(token, projectA)).status).toBe(403);
  });

  it("une session « agent IA » sans périmètre ne lit rien", async () => {
    const token = await seedCliSession(adminUserId, "AI");
    expect((await readSecrets(token, projectA)).status).toBe(403);
  });

  it("une session révoquée ne lit plus rien", async () => {
    const token = await approveAndGetToken(admin, "run-revoque");
    expect((await readSecrets(token, projectA)).status).toBe(200);
    expect((await logout(token)).status).toBe(204);
    expect((await readSecrets(token, projectA)).status).toBe(401);
  });

  it("physalis pull (T-0288) : .env de dev accepté et tracé comme export, production refusée", async () => {
    const token = await approveAndGetToken(admin, "pull");
    const pull = (env: string) =>
      fetch(`${BASE_URL}/api/secrets/${projectA}/${env}?purpose=pull`, {
        headers: { authorization: `Bearer ${token}`, "x-forwarded-for": cliIp },
      });

    const dev = await pull("development");
    expect(dev.status).toBe(200);
    expect(await dev.json()).toEqual({ secrets: { API_KEY: "valeur-a" } });
    const purpose = await execSqlValue(
      `SELECT metadata->>'purpose' FROM "${TENANT_SCHEMA}"."AccessLog"
         WHERE action = 'SECRET_EXPORT' AND metadata->>'via' = 'cli_session'
         ORDER BY "createdAt" DESC LIMIT 1`,
    );
    expect(purpose).toBe("pull");

    // La production ne se télécharge pas en clair, même avec tous les droits…
    const prod = await pull("production");
    expect(prod.status).toBe(403);
    expect(await prod.json()).toEqual({ error: "Forbidden", reason: "pull_non_dev_environment" });
    // …mais reste lisible en mémoire par physalis run (scénario S3 bis).
    expect((await readSecrets(token, projectA, "production")).status).toBe(200);
  });

  it("agent IA (T-0289) : l'humain coche un périmètre, l'agent ne lit que lui", async () => {
    // 1. La CLI demande une session IA.
    const res = await cli("/api/cli/device/start", {
      method: "POST",
      body: JSON.stringify({ deviceName: `${DEVICE_PREFIX}ia`, kind: "AI" }),
    });
    const s = (await res.json()) as Started;

    // 2. La page d'approbation la montre comme IA, avec ce qui peut être ouvert :
    //    environnements de dev seulement.
    const lookup = await admin.fetch(`/api/cli/device?code=${s.userCode}`);
    const { device, selectable } = (await lookup.json()) as {
      device: { kind: string };
      selectable: { slug: string; environments: string[] }[];
    };
    expect(device.kind).toBe("AI");
    const a = selectable.find((p) => p.slug === projectA);
    expect(a?.environments).toContain("development");
    expect(a?.environments).not.toContain("production");
    expect(a?.environments).not.toContain("staging");

    // 3. Approuver sans périmètre, ou avec la production → refusé.
    const decide = (scope: unknown) =>
      postJson(admin, "/api/cli/device/decide", { code: s.userCode, approve: true, scope });
    expect((await decide(undefined)).status).toBe(400);
    expect((await decide([{ project: projectA, environments: ["production"] }])).status).toBe(400);
    expect((await decide([{ project: `${RUN}-inexistant`, environments: ["development"] }])).status).toBe(400);
    expect((await decide([{ project: projectA, environments: ["development"] }])).status).toBe(200);

    await resetPollClock(s.userCode);
    const grant = (await (await poll(s.deviceCode)).json()) as { token: string };
    expect(grant.token).toMatch(/^sv_cli_/);

    // 4. L'agent lit ce qui a été coché…
    const ok = await readSecrets(grant.token, projectA);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ secrets: { API_KEY: "valeur-a" } });
    // …et rien d'autre, même là où l'humain a tous les droits.
    expect((await readSecrets(grant.token, projectA, "production")).status).toBe(403);
    expect((await readSecrets(grant.token, projectB)).status).toBe(403);
    // Jamais de .env en clair pour un agent.
    const pull = await fetch(`${BASE_URL}/api/secrets/${projectA}/development?purpose=pull`, {
      headers: { authorization: `Bearer ${grant.token}`, "x-forwarded-for": cliIp },
    });
    expect(await pull.json()).toEqual({ error: "Forbidden", reason: "pull_ai_session" });

    // 5. Le journal distingue l'agent, et la liste des sessions montre son périmètre.
    const via = await execSqlValue(
      `SELECT metadata->>'via' FROM "${TENANT_SCHEMA}"."AccessLog"
         WHERE action = 'SECRET_FETCH_BULK' ORDER BY "createdAt" DESC LIMIT 1`,
    );
    expect(via).toBe("ai_session");
    const list = (await (await admin.fetch("/api/cli/sessions")).json()) as {
      sessions: { deviceName: string; kind: string; aiScope: string[] | null }[];
    };
    const mine = list.sessions.find((x) => x.deviceName === `${DEVICE_PREFIX}ia`);
    expect(mine?.kind).toBe("AI");
    expect(mine?.aiScope).toEqual([`${projectA}/development`]);
  });

  it("le journal attribue la lecture à l'utilisateur, via la session CLI", async () => {
    const via = await execSqlValue(
      `SELECT metadata->>'via' FROM "${TENANT_SCHEMA}"."AccessLog"
         WHERE action = 'SECRET_FETCH_BULK' AND metadata->>'via' = 'cli_session'
         ORDER BY "createdAt" DESC LIMIT 1`,
    );
    expect(via).toBe("cli_session");
  });
});
