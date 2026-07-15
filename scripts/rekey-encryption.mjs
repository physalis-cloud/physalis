#!/usr/bin/env node
//
// scripts/rekey-encryption.mjs
//
// Re-chiffre toutes les données AES-256-GCM de l'app sous une NOUVELLE clé
// maître, en lisant l'ancienne en parallèle. Sert la rotation planifiée et la
// récupération après compromission de `ENCRYPTION_KEY`.
//
// ⚠️ NE MODIFIE PAS LE SCHÉMA. Aucun DDL, aucune migration : on ne réécrit que
// le CONTENU des colonnes chiffrées existantes (triplet `valeur`/`iv`/`tag`).
// Le texte en clair déchiffré est strictement identique avant/après — l'app ne
// voit aucune différence, seuls les octets au repos changent (K1 → K2).
//
// Modèle de clé (cf. lib/crypto.ts) : clé maître globale unique, AES-256-GCM,
// IV 12 o, sans versioning dans le payload. La rotation EXIGE donc un re-keying :
// déchiffrer sous l'ancienne clé, rechiffrer sous la nouvelle.
//
// Sûreté :
//   - DRY-RUN PAR DÉFAUT (lecture seule). `--apply` pour écrire réellement.
//   - Idempotent / reprenable : une ligne déjà déchiffrable sous K2 est sautée
//     (l'auth GCM 128 bits rend un faux « déjà migré » négligeable).
//   - Transaction par lot ; une ligne illisible sous K1 ET K2 est LOGUÉE et
//     laissée intacte (jamais d'écrasement aveugle).
//   - Robuste au drift : table/colonnes absentes d'un schéma → sautées.
//
// EXCLUS (zero-knowledge, pas de tag GCM serveur — le serveur ne peut pas
// déchiffrer) : `OneTimeShare` (chiffré navigateur), `SecretRequest` (hybride
// ECDH/ML-KEM, déchiffré par le destinataire).
//
// Procédure ops :
//   1. Backup DB.
//   2. Générer K2 (`openssl rand -hex 32`).
//   3. Déployer avec ENCRYPTION_KEY=K2 et ENCRYPTION_KEY_OLD=K1 (le fallback de
//      lib/crypto rend tout lisible pendant la migration → zéro downtime).
//   4. Dry-run : node scripts/rekey-encryption.mjs
//   5. Appliquer : node scripts/rekey-encryption.mjs --apply
//   6. Une fois « 0 en attente » confirmé, retirer ENCRYPTION_KEY_OLD du déploiement.
//
// Usage :
//   node scripts/rekey-encryption.mjs                 # dry-run, tous les tenants
//   node scripts/rekey-encryption.mjs --apply         # écrit réellement
//   node scripts/rekey-encryption.mjs --tenant=argoweb
//   node scripts/rekey-encryption.mjs --include-public
//   node scripts/rekey-encryption.mjs --apply --yes --batch=500

import { PrismaClient } from "@prisma/client";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { fileURLToPath } from "node:url";
import readline from "node:readline";

const ALGORITHM = "aes-256-gcm";
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/;

// ─── Crypto (miroir de lib/crypto.ts) ───────────────────────────────
// Verrouillé par tests/lib/rekey-script-interop.test.ts : un payload produit
// par lib/crypto doit être déchiffrable ici et inversement. Si lib/crypto
// change de format, ce test casse → on est prévenu de la dérive.

export function parseKey(raw, label) {
  if (!raw) throw new Error(`${label} is not set`);
  const key = Buffer.from(raw, "hex");
  if (key.length !== 32) {
    throw new Error(`${label} must be 32 bytes (64 hex chars)`);
  }
  return key;
}

export function encryptWith(plaintext, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return {
    encryptedValue: encrypted.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
  };
}

export function decryptWith(payload, key) {
  const decipher = createDecipheriv(
    ALGORITHM,
    key,
    Buffer.from(payload.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(payload.encryptedValue, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

/** Re-chiffre un payload de K1 vers K2. Retourne :
 *   - null  → déjà sous K2 (rien à faire, idempotent)
 *   - {encryptedValue,iv,tag} → re-chiffré sous K2
 *  Lève si illisible sous K1 ET K2 (laisser l'appelant logguer + sauter). */
export function rekeyPayload(payload, newKey, oldKey) {
  try {
    decryptWith(payload, newKey);
    return null; // déjà migré
  } catch {
    // pas sous K2 → doit être sous K1
  }
  const plain = decryptWith(payload, oldKey); // lève si ni K1 ni K2
  return encryptWith(plain, newKey);
}

// ─── Registre explicite des champs chiffrés lib/crypto ──────────────
// Invariant : un champ re-keyable a un triplet (valeur, iv, tag). Tout champ
// SANS colonne `tag` GCM est exclu (= zero-knowledge). Cross-vérifié contre le
// schéma par tests/lib/rekey-registry.test.ts.
export const REGISTRY = [
  {
    model: "User",
    triplets: [["twoFactorSecret", "twoFactorIv", "twoFactorTag"]],
  },
  {
    model: "ProjectBackupConfig",
    triplets: [["agentTokenEnc", "agentTokenIv", "agentTokenTag"]],
  },
  { model: "ProjectEmailConfig", triplets: [["encryptedKey", "iv", "tag"]] },
  { model: "Server", triplets: [["encryptedKey", "iv", "tag"]] },
  { model: "OrgSecret", triplets: [["encryptedValue", "iv", "tag"]] },
  { model: "OrgSecretVersion", triplets: [["encryptedValue", "iv", "tag"]] },
  { model: "CiConnectionSecret", triplets: [["encryptedValue", "iv", "tag"]] },
  {
    model: "Service",
    triplets: [
      ["encryptedData", "iv", "tag"],
      ["dbPwEncrypted", "dbPwIv", "dbPwTag"],
    ],
  },
  { model: "AppAccount", triplets: [["encryptedData", "iv", "tag"]] },
  { model: "Secret", triplets: [["encryptedValue", "iv", "tag"]] },
  { model: "SecretVersion", triplets: [["encryptedValue", "iv", "tag"]] },
  {
    model: "VaultEntry",
    triplets: [
      ["encryptedPassword", "passwordIv", "passwordTag"],
      ["encryptedTotpSecret", "totpSecretIv", "totpSecretTag"],
    ],
  },
  {
    model: "TeamVaultEntry",
    triplets: [
      ["encryptedPassword", "passwordIv", "passwordTag"],
      ["encryptedTotpSecret", "totpSecretIv", "totpSecretTag"],
    ],
  },
  { model: "Api", triplets: [["jwtSecret", "jwtSecretIv", "jwtSecretTag"]] },
  // admin.sso_configs : client secret OIDC du SSO Enterprise. Vit dans le schéma
  // `admin` (pas tenant) et la table est @@map("sso_configs") → on précise
  // `schema`/`table` pour que le script cible le bon endroit (le `model` reste le
  // nom Prisma, attendu par le garde-fou rekey-registry.test.ts).
  {
    model: "SsoConfig",
    schema: "admin",
    table: "sso_configs",
    triplets: [["clientSecret", "clientSecretIv", "clientSecretTag"]],
  },
];

// Tables chiffrées volontairement NON re-keyées (documenté pour l'audit).
export const EXCLUDED = ["OneTimeShare", "SecretRequest"];

// ─── DB helpers ─────────────────────────────────────────────────────

async function listTenantSchemas(prisma) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT schema_name FROM information_schema.schemata
     WHERE schema_name LIKE 'client_%' ORDER BY schema_name`,
  );
  return rows
    .map((r) => r.schema_name)
    .filter((s) => SLUG_RE.test(s.replace(/^client_/, "")));
}

async function tableExists(prisma, schema, table) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT to_regclass($1) IS NOT NULL AS ok`,
    `"${schema}"."${table}"`,
  );
  return rows[0]?.ok === true;
}

async function presentColumns(prisma, schema, table) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = $2`,
    schema,
    table,
  );
  return new Set(rows.map((r) => r.column_name));
}

// ─── Re-key d'un (schéma, modèle, triplet) ──────────────────────────

async function rekeyTriplet(
  prisma,
  opts,
  schema,
  table,
  [vCol, ivCol, tagCol],
) {
  const { newKey, oldKey, apply, batch } = opts;
  const fq = `"${schema}"."${table}"`;
  const stats = { scanned: 0, migrated: 0, current: 0, errors: 0 };
  let lastId = "";

  for (;;) {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, "${vCol}" AS v, "${ivCol}" AS iv, "${tagCol}" AS tag
       FROM ${fq}
       WHERE "${vCol}" IS NOT NULL AND "${ivCol}" IS NOT NULL
         AND "${tagCol}" IS NOT NULL AND id > $1
       ORDER BY id ASC LIMIT $2`,
      lastId,
      batch,
    );
    if (rows.length === 0) break;
    lastId = rows[rows.length - 1].id;

    const updates = [];
    for (const row of rows) {
      stats.scanned++;
      let next;
      try {
        next = rekeyPayload(
          { encryptedValue: row.v, iv: row.iv, tag: row.tag },
          newKey,
          oldKey,
        );
      } catch {
        stats.errors++;
        console.error(
          `  ⚠️  ${schema}.${table}.${vCol} id=${row.id} : illisible sous K1 ET K2 → laissé intact`,
        );
        continue;
      }
      if (next === null) {
        stats.current++; // déjà sous K2
        continue;
      }
      stats.migrated++;
      updates.push({ id: row.id, next });
    }

    if (apply && updates.length > 0) {
      await prisma.$transaction(async (tx) => {
        for (const u of updates) {
          await tx.$executeRawUnsafe(
            `UPDATE ${fq} SET "${vCol}" = $1, "${ivCol}" = $2, "${tagCol}" = $3 WHERE id = $4`,
            u.next.encryptedValue,
            u.next.iv,
            u.next.tag,
            u.id,
          );
        }
      });
    }
  }
  return stats;
}

// ─── CLI ────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = argv.slice(2);
  const tenant = args
    .find((a) => a.startsWith("--tenant="))
    ?.slice("--tenant=".length);
  const batchArg = args
    .find((a) => a.startsWith("--batch="))
    ?.slice("--batch=".length);
  return {
    apply: args.includes("--apply"),
    yes: args.includes("--yes"),
    includePublic: args.includes("--include-public"),
    tenant,
    batch: Math.max(1, Math.min(2000, Number(batchArg) || 200)),
  };
}

async function confirm(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (a) => {
      rl.close();
      resolve(a.trim().toLowerCase());
    });
  });
}

async function main() {
  const cli = parseArgs(process.argv);

  if (cli.tenant && !SLUG_RE.test(cli.tenant)) {
    console.error(`Slug tenant invalide : ${cli.tenant}`);
    process.exit(1);
  }

  // Garde clés : deux clés valides et DISTINCTES requises.
  let newKey, oldKey;
  try {
    newKey = parseKey(process.env.ENCRYPTION_KEY, "ENCRYPTION_KEY");
    oldKey = parseKey(process.env.ENCRYPTION_KEY_OLD, "ENCRYPTION_KEY_OLD");
  } catch (e) {
    console.error(`✖ ${e.message}`);
    console.error(
      "  Le re-keying exige ENCRYPTION_KEY (nouvelle, K2) ET ENCRYPTION_KEY_OLD (ancienne, K1).",
    );
    process.exit(1);
  }
  if (newKey.length === oldKey.length && timingSafeEqual(newKey, oldKey)) {
    console.error("✖ ENCRYPTION_KEY == ENCRYPTION_KEY_OLD : rien à roter.");
    process.exit(1);
  }

  const prisma = new PrismaClient();
  try {
    const tenantSchemas = await listTenantSchemas(prisma);
    let schemas = cli.tenant
      ? tenantSchemas.filter((s) => s === `client_${cli.tenant}`)
      : tenantSchemas;
    if (cli.includePublic && !cli.tenant) schemas = ["public", ...schemas];
    // Le schéma `admin` (control plane : admin.sso_configs…) est inclus dans
    // toute rotation GLOBALE (≠ run ciblé `--tenant`). Ses secrets vivent live
    // et DOIVENT roter — contrairement à `public` (reliquats), donc non opt-in.
    if (!cli.tenant) schemas = ["admin", ...schemas];

    if (schemas.length === 0) {
      console.error("Aucun schéma cible trouvé.");
      process.exit(1);
    }

    const mode = cli.apply ? "APPLIQUER (écriture)" : "DRY-RUN (lecture seule)";
    console.log(`\n🔑 Re-keying ENCRYPTION_KEY — mode : ${mode}`);
    console.log(`   Schémas (${schemas.length}) : ${schemas.join(", ")}`);
    console.log(`   Lot : ${cli.batch} | Exclus : ${EXCLUDED.join(", ")}\n`);

    if (cli.apply && !cli.yes) {
      console.log(
        "⚠️  Écriture réelle des données chiffrées. Assure-toi d'avoir un BACKUP DB.",
      );
      const a = await confirm('   Taper "rekey" pour confirmer : ');
      if (a !== "rekey") {
        console.log("Annulé.");
        process.exit(0);
      }
    }

    const totals = { scanned: 0, migrated: 0, current: 0, errors: 0 };
    for (const schema of schemas) {
      for (const { model, triplets, table: tableOverride } of REGISTRY) {
        // Nom de table SQL : `table` si précisé (modèle @@map, ex. sso_configs),
        // sinon le nom du modèle (cas général où table == modèle). La présence
        // de la table dans le schéma courant route automatiquement chaque entrée
        // (admin.sso_configs n'existe qu'en `admin`, User qu'en public/client_*).
        const table = tableOverride ?? model;
        if (!(await tableExists(prisma, schema, table))) continue;
        const cols = await presentColumns(prisma, schema, table);
        for (const triplet of triplets) {
          if (!triplet.every((c) => cols.has(c))) continue; // drift : colonnes absentes
          const s = await rekeyTriplet(
            prisma,
            { ...cli, newKey, oldKey },
            schema,
            table,
            triplet,
          );
          if (s.scanned > 0) {
            const verb = cli.apply ? "migré" : "à migrer";
            console.log(
              `  ${schema}.${model}.${triplet[0]} : ${s.scanned} scannés, ${s.migrated} ${verb}, ${s.current} déjà K2, ${s.errors} erreurs`,
            );
          }
          for (const k of Object.keys(totals)) totals[k] += s[k];
        }
      }
    }

    console.log(
      `\n── TOTAL ── ${totals.scanned} scannés | ${totals.migrated} ${cli.apply ? "migrés" : "à migrer"} | ${totals.current} déjà K2 | ${totals.errors} erreurs`,
    );
    if (!cli.apply && totals.migrated > 0) {
      console.log("→ Relancer avec --apply pour écrire.");
    }
    if (cli.apply && totals.errors === 0 && totals.migrated > 0) {
      console.log(
        "✅ Migration terminée. Vérifier un dry-run à 0 à migrer, puis retirer ENCRYPTION_KEY_OLD.",
      );
    }
    if (totals.errors > 0) process.exitCode = 2;
  } finally {
    await prisma.$disconnect();
  }
}

// N'exécute main() que lancé directement (pas à l'import depuis les tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
