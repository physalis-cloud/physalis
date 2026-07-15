#!/usr/bin/env node
//
// scripts/auto-apply-tenant-migrations.mjs
//
// Apply automatique au boot du container (avant `node server.js`) des
// migrations tenant non encore tracked. Évite la classe d'erreur "j'ai
// rebuild mais oublié d'apply la migration sur les tenants existants
// → 500 sur tous les endpoints qui touchent les tables modifiées".
//
// Stratégie :
//   1. Liste toutes les migrations dans prisma/migrations/
//   2. Filtre les ADMIN_ONLY_MIGRATIONS (déjà appliquées par
//      `prisma migrate deploy` au schéma public)
//   3. Pour chaque schéma tenant `client_<slug>` :
//      a. Crée la table `_tenant_migration_log` si absente
//      b. SELECT les migrations déjà appliquées
//      c. Apply chaque migration non encore tracked → INSERT dans le log
//
// Bootstrap (1ère exécution sur un tenant) :
//   Toutes les migrations actuelles n'utilisent pas forcément `IF NOT
//   EXISTS` (les anciennes migrations Prisma ne le font pas). Rejouer
//   bêtement toutes les migrations sur un tenant déjà provisionné
//   échouerait sur les CREATE TABLE / ADD CONSTRAINT.
//
//   Stratégie : si `_tenant_migration_log` est VIDE, on considère que le
//   tenant a déjà toutes les migrations actuelles appliquées (via le
//   provisioning historique de `provisionClientSchema`) — on backfill le
//   log sans rejouer. Pré-requis : avant le 1er déploiement de ce script,
//   l'opérateur doit avoir appliqué manuellement les migrations en attente
//   via `scripts/apply-tenant-migration.mjs` (le user l'a fait pour
//   user_tokens et org_tokens).
//
//   Boots suivants : seules les nouvelles migrations (non encore loggées)
//   sont apply.
//
// Échec sur un tenant : log + continue les autres. Exit code != 0 si au
// moins un échec — le container ne démarrera pas (alerte l'opérateur).

import { PrismaClient } from "@prisma/client";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

const MIGRATIONS_DIR = join(process.cwd(), "prisma", "migrations");
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/;

// Garder en sync avec lib/provisioning.ts et apply-tenant-migration.mjs.
const ADMIN_ONLY_MIGRATIONS = new Set([
  "20260505000000_add_admin_schema",
  "20260505010000_role_superadmin",
  "20260505020000_plan_free",
  "20260505030000_trial_ends_at_nullable",
  "20260505040000_phase6_token_index",
  "20260506000000_client_comped",
  "20260507000000_password_reset_tokens",
  "20260508000000_stripe_billing",
  "20260508100000_billing_addons",
  "20260509000000_lifecycle_emails",
  "20260509130000_token_kind_user_enum",
  "20260510000000_token_kind_org_enum",
  "20260613120000_dedicated_instances",
  "20260614120000_cicd_multiprovider_admin",
  "20260614150000_account_pending_deletion",
  "20260616120000_client_bonus_quotas",
  "20260625120000_sso_config_admin",
  "20260626120000_sso_v2_multi_provider",
  "20260626160000_client_social_login_enabled",
]);

const prisma = new PrismaClient();

async function listTenantSchemas() {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT schema_name FROM information_schema.schemata
     WHERE schema_name LIKE 'client_%'
     ORDER BY schema_name`,
  );
  return rows
    .map((r) => r.schema_name)
    .filter((s) => SLUG_RE.test(s.replace(/^client_/, "")));
}

async function listMigrations() {
  const entries = await readdir(MIGRATIONS_DIR, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => !ADMIN_ONLY_MIGRATIONS.has(name))
    .sort();
}

async function readMigrationSql(name) {
  const path = join(MIGRATIONS_DIR, name, "migration.sql");
  await stat(path);
  return readFile(path, "utf8");
}

async function getAppliedSet(schema) {
  // Crée la table de tracking si absente. Pas besoin de migration dédiée :
  // la 1ère exécution du script crée la table sur tous les tenants.
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      `SET LOCAL search_path TO "${schema}", public`,
    );
    await tx.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "_tenant_migration_log" (
        "name" TEXT PRIMARY KEY,
        "applied_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
  });

  const rows = await prisma.$queryRawUnsafe(
    `SELECT name FROM "${schema}"."_tenant_migration_log"`,
  );
  return new Set(rows.map((r) => r.name));
}

/** Backfill le log avec toutes les migrations actuelles, sans les rejouer.
 *  À appeler quand le log est vide (1ère exécution sur un tenant existant). */
async function backfillLog(schema, migrations) {
  if (migrations.length === 0) return;
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      `SET LOCAL search_path TO "${schema}", public`,
    );
    for (const name of migrations) {
      await tx.$executeRawUnsafe(
        `INSERT INTO "${schema}"."_tenant_migration_log" ("name") VALUES ($1)
         ON CONFLICT (name) DO NOTHING`,
        name,
      );
    }
  });
}

async function applyMigrationOnSchema(schema, name, sql) {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      `SET LOCAL search_path TO "${schema}", public`,
    );
    const stmts = splitTopLevelStatements(sql);
    for (const stmt of stmts) {
      const trimmed = stmt.trim();
      if (!trimmed) continue;
      await tx.$executeRawUnsafe(trimmed);
    }
    await tx.$executeRawUnsafe(
      `INSERT INTO "${schema}"."_tenant_migration_log" ("name") VALUES ($1)
       ON CONFLICT (name) DO NOTHING`,
      name,
    );
  });
}

/** Split SQL sur les `;` top-level — préserve les `$$ ... $$` blocks.
 *  Copie de la logique éprouvée de apply-tenant-migration.mjs. */
function splitTopLevelStatements(sql) {
  const noBlock = sql.replace(/\/\*[\s\S]*?\*\//g, "");
  const noLine = noBlock
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx >= 0 ? line.slice(0, idx) : line;
    })
    .join("\n");

  const out = [];
  let buf = "";
  let i = 0;
  let dollarTag = null;

  while (i < noLine.length) {
    const ch = noLine[i];
    if (ch === "$") {
      const m = noLine.slice(i).match(/^\$([a-zA-Z0-9_]*)\$/);
      if (m) {
        const tag = m[0];
        if (dollarTag === null) dollarTag = tag;
        else if (dollarTag === tag) dollarTag = null;
        buf += tag;
        i += tag.length;
        continue;
      }
    }
    if (ch === ";" && dollarTag === null) {
      out.push(buf);
      buf = "";
      i++;
      continue;
    }
    buf += ch;
    i++;
  }
  if (buf.trim()) out.push(buf);
  return out;
}

async function main() {
  const start = Date.now();
  const tenantSchemas = await listTenantSchemas();
  const migrations = await listMigrations();

  if (tenantSchemas.length === 0) {
    console.log("[auto-tenant-migrations] No tenant schemas found, skipping.");
    return;
  }

  let totalApplied = 0;
  let totalSkipped = 0;
  let totalBootstrapped = 0;
  let failedSchemas = [];

  for (const schema of tenantSchemas) {
    let applied;
    try {
      applied = await getAppliedSet(schema);
    } catch (err) {
      console.error(
        `[auto-tenant-migrations] ✗ ${schema}: cannot read migration log: ${err.message}`,
      );
      failedSchemas.push(schema);
      continue;
    }

    // Bootstrap : log vide → backfill avec toutes les migrations actuelles
    // (le tenant a été provisionné via provisionClientSchema qui a déjà
    // tout appliqué). Évite de tenter un replay sur des CREATE TABLE non
    // idempotents.
    if (applied.size === 0) {
      try {
        await backfillLog(schema, migrations);
        totalBootstrapped += migrations.length;
        console.log(
          `[auto-tenant-migrations] ${schema}: bootstrapped log with ${migrations.length} existing migration(s)`,
        );
        continue;
      } catch (err) {
        console.error(
          `[auto-tenant-migrations] ✗ ${schema}: bootstrap failed: ${err.message}`,
        );
        failedSchemas.push(schema);
        continue;
      }
    }

    const pending = migrations.filter((m) => !applied.has(m));
    if (pending.length === 0) {
      totalSkipped += migrations.length;
      continue;
    }

    console.log(
      `[auto-tenant-migrations] ${schema}: ${pending.length} migration(s) to apply`,
    );
    for (const name of pending) {
      try {
        const sql = await readMigrationSql(name);
        await applyMigrationOnSchema(schema, name, sql);
        totalApplied++;
        console.log(`  → ${name}: ✓`);
      } catch (err) {
        console.error(`  → ${name}: ✗ ${err.message}`);
        failedSchemas.push(`${schema}/${name}`);
        // On continue : les migrations idempotentes peuvent être rejouées
        // à la prochaine fois. Le caller décidera de bloquer ou non le
        // boot via l'exit code.
      }
    }
  }

  const ms = Date.now() - start;
  console.log(
    `[auto-tenant-migrations] done in ${ms}ms — ${totalApplied} applied, ${totalBootstrapped} bootstrapped, ${totalSkipped} already up-to-date${
      failedSchemas.length ? `, ${failedSchemas.length} failed` : ""
    }.`,
  );

  if (failedSchemas.length > 0) {
    console.error(
      `[auto-tenant-migrations] Failed: ${failedSchemas.join(", ")}`,
    );
    process.exit(1);
  }
}

main()
  .catch((err) => {
    console.error("[auto-tenant-migrations] Fatal:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
