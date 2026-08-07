#!/usr/bin/env node
// scripts/check-encryption-readable.mjs
//
// Contrôle LECTURE SEULE : chaque valeur chiffrée de la base se déchiffre-t-elle
// avec l'`ENCRYPTION_KEY` courante ? N'écrit rien, ne déchiffre qu'en mémoire et
// n'affiche JAMAIS un clair — seulement des compteurs.
//
// ── Pourquoi ce script existe ──
// Le 2026-08-02, UNE ligne `admin.sso_configs` restée chiffrée sous l'ancienne
// clé (rotation K1→K2 du 01/08) a rendu la connexion impossible sur un tenant,
// mot de passe compris. Le re-keying s'était pourtant annoncé « 0 erreur ».
//
// La leçon n'est pas « il faut mieux rejouer le script » : c'est qu'une valeur
// indéchiffrable est INVISIBLE jusqu'à son prochain usage. Un secret de coffre
// consulté deux fois par an, un token d'agent de backup, une clé API email :
// tous peuvent être morts depuis des semaines sans qu'aucun écran ne l'indique.
// Ce script rend cet état observable à la demande, avant l'incident.
//
// Le registre des champs chiffrés est celui du re-keying (source unique) : un
// champ ajouté là est audité ici sans rien toucher.
//
// Usage :
//   node scripts/check-encryption-readable.mjs              # tous les schémas
//   node scripts/check-encryption-readable.mjs --schema admin
//   node scripts/check-encryption-readable.mjs --json       # sortie machine
//
// Code de sortie : 0 si tout est lisible, 1 s'il reste au moins une valeur
// illisible — utilisable tel quel dans un cron de surveillance.

import { PrismaClient } from "@prisma/client";
import {
  REGISTRY,
  EXCLUDED,
  parseKey,
  decryptWith,
  sqlColumn,
} from "./rekey-encryption.mjs";

const ARGS = process.argv.slice(2);
const JSON_OUT = ARGS.includes("--json");
const SCHEMA_ARG = (() => {
  const i = ARGS.indexOf("--schema");
  return i >= 0 ? ARGS[i + 1] : null;
})();

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/;

const prisma = new PrismaClient();

/** Schémas à parcourir : `admin` + tous les `client_<slug>` valides. */
async function listSchemas() {
  if (SCHEMA_ARG) return [SCHEMA_ARG];
  const rows = await prisma.$queryRawUnsafe(
    `SELECT schema_name FROM information_schema.schemata
     WHERE schema_name = 'admin' OR schema_name LIKE 'client_%'
     ORDER BY schema_name`,
  );
  return rows
    .map((r) => r.schema_name)
    .filter((s) => s === "admin" || SLUG_RE.test(s.replace(/^client_/, "")));
}

async function tableExists(schema, table) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT to_regclass($1) IS NOT NULL AS ok`,
    `"${schema}"."${table}"`,
  );
  return rows[0]?.ok === true;
}

/** Nom de table SQL d'une entrée du registre (modèles @@map compris). */
function tableOf(entry) {
  return entry.table ?? entry.model;
}

async function main() {
  const key = parseKey(process.env.ENCRYPTION_KEY, "ENCRYPTION_KEY");
  const schemas = await listSchemas();
  const findings = [];
  let checked = 0;

  for (const schema of schemas) {
    for (const entry of REGISTRY) {
      // Une entrée peut être scopée à un schéma précis (admin.sso_configs
      // n'existe pas dans les schémas tenant, et inversement).
      if (entry.schema && entry.schema !== schema) continue;
      if (!entry.schema && schema === "admin") continue;

      const table = tableOf(entry);
      if (!(await tableExists(schema, table))) continue;

      for (const triplet of entry.triplets) {
        // Champs Prisma → colonnes SQL (identité sauf `@map`). Résolu par le
        // même helper que le re-keying : une divergence entre les deux ferait
        // exactement l'angle mort qu'on cherche à fermer ici.
        const [valueCol, ivCol, tagCol] = triplet.map((f) => sqlColumn(entry, f));
        const rows = await prisma.$queryRawUnsafe(
          `SELECT "${valueCol}" AS v, "${ivCol}" AS iv, "${tagCol}" AS tag
           FROM "${schema}"."${table}"
           WHERE "${valueCol}" IS NOT NULL
             AND "${ivCol}" IS NOT NULL
             AND "${tagCol}" IS NOT NULL`,
        );

        let bad = 0;
        for (const row of rows) {
          checked++;
          try {
            // Le clair est produit puis immédiatement abandonné : on ne le
            // journalise pas, on ne le retourne pas. Seul le succès compte.
            decryptWith({ encryptedValue: row.v, iv: row.iv, tag: row.tag }, key);
          } catch {
            bad++;
          }
        }

        if (bad > 0) {
          findings.push({
            schema,
            table,
            column: valueCol,
            unreadable: bad,
            total: rows.length,
          });
        }
      }
    }
  }

  if (JSON_OUT) {
    console.log(JSON.stringify({ checked, findings, excluded: EXCLUDED }, null, 2));
  } else {
    console.log(`\n${checked} valeurs chiffrées contrôlées sur ${schemas.length} schéma(s).`);
    if (findings.length === 0) {
      console.log("✓ Toutes déchiffrables avec l'ENCRYPTION_KEY courante.\n");
    } else {
      console.log("\n✖ Valeurs ILLISIBLES (chiffrées sous une autre clé) :\n");
      for (const f of findings) {
        console.log(
          `  ${f.schema}.${f.table}.${f.column} — ${f.unreadable}/${f.total} illisible(s)`,
        );
      }
      console.log(
        "\n  Remède : rejouer `rekey-encryption.mjs` avec ENCRYPTION_KEY_OLD renseignée,\n" +
          "  ou ressaisir la valeur depuis l'interface si l'ancienne clé est perdue.\n",
      );
    }
    // Rappel explicite : ces tables sont chiffrées mais volontairement hors
    // périmètre (zero-knowledge, pas de tag GCM récupérable côté serveur).
    console.log(`Hors périmètre par conception : ${EXCLUDED.join(", ")}\n`);
  }

  await prisma.$disconnect();
  process.exit(findings.length === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("[check-encryption] échec :", err);
  await prisma.$disconnect();
  process.exit(2);
});
