// Teardown de la fixture de perf seedée par seed.mjs : supprime le projet
// (cascade envs/secrets/tokens), l'org, l'admin jetable et ses AccessLog,
// puis efface perf/.fixture.json.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, rmSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, ".fixture.json");

const TENANT = process.env.PERF_TENANT ?? "test";
const SCHEMA = `client_${TENANT}`;
const DB_CONTAINER = process.env.PERF_DB_CONTAINER ?? "physalis-db";

async function psql(sql) {
  await execFileAsync("docker", [
    "exec", DB_CONTAINER, "psql", "-U", "physalis", "-d", "physalis", "-AtX", "-c", sql,
  ]);
}

if (!existsSync(FIXTURE)) {
  console.log("[teardown] pas de perf/.fixture.json — rien à nettoyer");
  process.exit(0);
}

const f = JSON.parse(readFileSync(FIXTURE, "utf8"));

// Projet → cascade (Environment/Secret/MachineToken via FK ON DELETE CASCADE).
await psql(`DELETE FROM "${SCHEMA}"."Project" WHERE slug = '${f.projectSlug}'`);
await psql(`DELETE FROM "${SCHEMA}"."Organization" WHERE id = '${f.orgId}'`);
await psql(
  `DELETE FROM "${SCHEMA}"."AccessLog" WHERE "actorUserEmail" = '${f.adminEmail}'`,
);
await psql(`DELETE FROM "${SCHEMA}"."User" WHERE email = '${f.adminEmail}'`);

rmSync(FIXTURE);
console.log(`[teardown] OK — projet/org/admin (${f.adminEmail}) supprimés`);
