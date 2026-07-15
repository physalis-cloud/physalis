// Seed d'une fixture de perf : admin + org + projet + N secrets + token machine.
// Écrit perf/.fixture.json consommé par les scripts k6 (TOKEN, SLUG, BASE_URL).
//
// Pourquoi ce seed : la hot path mesurée est GET /api/secrets/<slug>/<env>
// (Bearer sv_…) — elle exige un projet/env peuplé de secrets et un token scopé.
// `POST /api/projects` exige un admin AVEC org → on provisionne l'org en SQL
// (comme les helpers integ) puis on crée projet/secrets/token via l'API (qui
// gère le chiffrement et le hash du token).
//
// Usage : node perf/seed.mjs   (env : PERF_BASE_URL, PERF_TENANT, PERF_SECRETS)
// Teardown : node perf/teardown.mjs

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import bcrypt from "bcryptjs";

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));

const BASE_URL = process.env.PERF_BASE_URL ?? "http://localhost:3006";
const TENANT = process.env.PERF_TENANT ?? "test";
const SCHEMA = `client_${TENANT}`;
const DB_CONTAINER = process.env.PERF_DB_CONTAINER ?? "physalis-db";
const SECRET_COUNT = Number(process.env.PERF_SECRETS ?? 50);

const cuid = () => "ck" + randomBytes(11).toString("hex");

async function psql(sql) {
  const { stdout } = await execFileAsync("docker", [
    "exec", DB_CONTAINER, "psql", "-U", "physalis", "-d", "physalis", "-AtX", "-c", sql,
  ]);
  return stdout.trim();
}

// --- petit client HTTP avec jar de cookies (login NextAuth credentials) ---
const cookies = new Map();
function cookieHeader() {
  return [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}
function absorb(res) {
  for (const sc of res.headers.getSetCookie?.() ?? []) {
    const [pair] = sc.split(";");
    const i = pair.indexOf("=");
    if (i > 0) cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
}
async function api(path, init = {}) {
  const headers = new Headers(init.headers);
  if (cookies.size) headers.set("cookie", cookieHeader());
  const res = await fetch(`${BASE_URL}${path}`, { ...init, headers, redirect: "manual" });
  absorb(res);
  return res;
}

async function login(email, password) {
  const csrfRes = await api("/api/auth/csrf");
  const { csrfToken } = await csrfRes.json();
  const body = new URLSearchParams({ csrfToken, email, password, tenantSlug: TENANT }).toString();
  const res = await api("/api/auth/callback/credentials", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (res.status !== 302) throw new Error(`login HTTP ${res.status}`);
}

async function postJson(path, payload) {
  return api(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

async function main() {
  const stamp = Date.now();
  const email = `perf-admin-${stamp}@test.local`;
  const password = "perf-admin-pw-12345";
  const userId = cuid();
  const orgId = cuid();
  const orgSlug = `perf-org-${stamp}`;

  console.log(`[seed] admin ${email} + org ${orgSlug} (SQL)`);
  const hash = bcrypt.hashSync(password, 10);
  await psql(
    `INSERT INTO "${SCHEMA}"."User" (id,email,password,"createdAt") ` +
    `VALUES ('${userId}','${email}','${hash}',NOW())`,
  );
  await psql(
    `INSERT INTO "${SCHEMA}"."Organization" (id,name,slug,"createdAt") ` +
    `VALUES ('${orgId}','${orgSlug}','${orgSlug}',NOW())`,
  );
  await psql(
    `INSERT INTO "${SCHEMA}"."OrgMember" (id,"userId","organizationId",role,"createdAt") ` +
    `VALUES ('${cuid()}','${userId}','${orgId}','OWNER',NOW())`,
  );

  console.log("[seed] login");
  await login(email, password);

  console.log("[seed] création projet");
  const projRes = await postJson("/api/projects", { name: `perf-${stamp}` });
  if (projRes.status !== 201) throw new Error(`projet HTTP ${projRes.status}: ${await projRes.text()}`);
  const { project } = await projRes.json();
  const slug = project.slug;

  console.log(`[seed] insertion de ${SECRET_COUNT} secrets dans production`);
  for (let i = 0; i < SECRET_COUNT; i++) {
    const r = await postJson(`/api/projects/${slug}/production/secrets`, {
      key: `PERF_KEY_${i}`,
      value: `perf-value-${i}-${randomBytes(8).toString("hex")}`,
    });
    if (r.status !== 201 && r.status !== 200) {
      throw new Error(`secret #${i} HTTP ${r.status}: ${await r.text()}`);
    }
  }

  console.log("[seed] création token machine");
  const tokRes = await postJson("/api/tokens", {
    project: slug,
    environment: "production",
    name: "perf-token",
  });
  if (tokRes.status !== 201) throw new Error(`token HTTP ${tokRes.status}: ${await tokRes.text()}`);
  const { token } = await tokRes.json();

  const fixture = {
    baseUrl: BASE_URL,
    tenant: TENANT,
    slug,
    env: "production",
    token,
    secretCount: SECRET_COUNT,
    // pour le teardown
    adminEmail: email,
    orgId,
    projectSlug: slug,
  };
  writeFileSync(join(HERE, ".fixture.json"), JSON.stringify(fixture, null, 2));
  console.log(`\n[seed] OK → perf/.fixture.json`);
  console.log(`  endpoint : GET ${BASE_URL}/api/secrets/${slug}/production`);
  console.log(`  secrets  : ${SECRET_COUNT}`);
}

main().catch((e) => {
  console.error("[seed] ÉCHEC:", e.message);
  process.exit(1);
});
