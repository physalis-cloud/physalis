// POST /api/projects/[slug]/[env]/secrets/import — import bulk d'un
// fichier .env (texte) vers les Secrets de l'environnement cible.
//
// Body : { envText, conflictPolicy, dryRun?, defaultCategory?, defaultTags? }
//
// Flow :
//   1. RBAC : EDITOR+ sur l'environnement (memes regles que POST single).
//   2. Parse via lib/env-parser (tolerant aux erreurs ligne par ligne).
//      Les commentaires pleine ligne remontent en `section` : un en-tete
//      reconnu (`# infra`, tel qu'ecrit par l'export) range la cle dans
//      cette categorie ; un commentaire libre n'a aucun effet et la cle
//      retombe sur `defaultCategory`.
//   3. Valide chaque cle contre le regex `[A-Z][A-Z0-9_]{0,127}`.
//   4. Lookup en batch des cles existantes pour distinguer creation vs
//      conflit.
//   5. Si dryRun → renvoie un resume (compteurs + listes de cles, JAMAIS
//      de valeurs).
//   6. Sinon execute :
//      - "skip"      : ignore les cles existantes
//      - "overwrite" : SecretVersion snapshot puis upsert (atomique par
//                       secret, en transaction).
//   7. Audit log unique avec metadata bulk (compteurs + conflictPolicy).
//      On reutilise l'action SECRET_CREATE (l'enum AccessAction n'a pas
//      de valeur bulk dediee — la metadata.bulk=true permet le filtrage).
//
// Securite : aucune valeur de secret n'est renvoyee, logguee, ou ecrite
// dans une erreur — uniquement les noms de cles.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { withTenantSchema } from "@/lib/tenant";
import { encrypt } from "@/lib/crypto";
import {
  isValidSecretKey,
  readJson,
  requireEnvironment,
} from "@/lib/api";
import {
  isValidCategory,
  resolveCategoryFromComment,
  type SecretCategory,
} from "@/lib/categories";
import { logAction } from "@/lib/audit";
import { createSecretVersion } from "@/lib/versioning";
import { normalizeTags, TAG_VALIDATION_ERROR } from "@/lib/tags";
import { parseEnv } from "@/lib/env-parser";
import { triggerSync } from "@/lib/sync/dispatch";

type Params = { params: Promise<{ slug: string; env: string }> };

// 100 KB : couvre un .env de prod realiste (clefs RSA / certs inclus),
// sans permettre un abus DoS.
const ENV_TEXT_MAX = 100 * 1024;

type Body = {
  envText?: string;
  conflictPolicy?: "skip" | "overwrite";
  dryRun?: boolean;
  defaultCategory?: string | null;
  defaultTags?: string[];
};

export async function POST(req: Request, { params }: Params) {
  const { slug, env } = await params;
  const access = await requireEnvironment(slug, env, "EDITOR");
  if ("error" in access) return access.error;

  const body = (await readJson(req)) as Body | null;
  if (!body || typeof body.envText !== "string") {
    return NextResponse.json(
      { error: "envText (string) is required" },
      { status: 400 },
    );
  }
  if (body.envText.length > ENV_TEXT_MAX) {
    return NextResponse.json(
      { error: `envText too large (max ${ENV_TEXT_MAX} bytes)` },
      { status: 413 },
    );
  }
  const conflictPolicy =
    body.conflictPolicy === "overwrite" ? "overwrite" : "skip";
  const dryRun = body.dryRun === true;

  // Categorie par defaut : meme regle que POST single (null / absent /
  // "" → null ; sinon valide vs SECRET_CATEGORIES).
  let defaultCategory: SecretCategory | null = null;
  if (
    body.defaultCategory !== undefined &&
    body.defaultCategory !== null &&
    body.defaultCategory !== ""
  ) {
    if (!isValidCategory(body.defaultCategory)) {
      return NextResponse.json(
        { error: "Invalid defaultCategory" },
        { status: 400 },
      );
    }
    defaultCategory = body.defaultCategory;
  }

  const defaultTags = normalizeTags(body.defaultTags);
  if (defaultTags === null) {
    return NextResponse.json({ error: TAG_VALIDATION_ERROR }, { status: 400 });
  }

  // Parse — tolerant : on recupere les entries valides + les erreurs
  // ligne a ligne pour les afficher dans la preview.
  const parsed = parseEnv(body.envText);

  // Separation valid / invalid selon la regex stricte de l'app, et
  // resolution de la categorie de chaque entree :
  //   - en-tete de section reconnu → cette categorie (`detected`)
  //   - sinon                      → `defaultCategory` du dialogue
  // La distinction compte : sur une cle DEJA existante, seule une
  // categorie detectee est appliquee. Le defaut du dialogue ne doit
  // jamais ecraser un rangement fait a la main dans l'UI.
  type Entry = {
    key: string;
    value: string;
    category: SecretCategory | null;
    detected: boolean;
  };
  const valid: Entry[] = [];
  const invalid: { key: string; reason: string }[] = [];
  for (const e of parsed.entries) {
    if (!isValidSecretKey(e.key)) {
      invalid.push({
        key: e.key,
        reason: "Nom invalide (doit matcher [A-Z][A-Z0-9_]{0,127})",
      });
      continue;
    }
    const hint = resolveCategoryFromComment(e.section);
    valid.push({
      key: e.key,
      value: e.value,
      category:
        hint === null ? defaultCategory : hint === "none" ? null : hint,
      detected: hint !== null,
    });
  }

  // Lookup en batch des cles deja existantes dans l'environnement.
  const existingRows =
    valid.length === 0
      ? []
      : await prisma.secret.findMany({
          where: {
            environmentId: access.environment.id,
            key: { in: valid.map((v) => v.key) },
          },
          select: {
            id: true,
            key: true,
            category: true,
            encryptedValue: true,
            iv: true,
            tag: true,
          },
        });
  const existingByKey = new Map(existingRows.map((r) => [r.key, r]));

  // Tri pour la preview / l'execution :
  const toCreate = valid.filter((v) => !existingByKey.has(v.key));
  const conflicting = valid.filter((v) => existingByKey.has(v.key));
  const toUpdate = conflictPolicy === "overwrite" ? conflicting : [];
  const toSkip = conflictPolicy === "skip" ? conflicting : [];

  // Repartition par categorie de ce qui sera REELLEMENT ecrit — l'user
  // doit voir le rangement avant de valider. `_none` = sans categorie,
  // `fallback` = entrees sans en-tete reconnu (donc rangees par le
  // menu deroulant du dialogue).
  const written = [...toCreate, ...toUpdate];
  const byCategory: Record<string, number> = {};
  let fallback = 0;
  for (const v of written) {
    if (!v.detected) {
      fallback++;
      continue;
    }
    const bucket = v.category ?? "_none";
    byCategory[bucket] = (byCategory[bucket] ?? 0) + 1;
  }

  // ─── dryRun : renvoie le resume sans toucher la base ──────────────
  if (dryRun) {
    return NextResponse.json({
      dryRun: true,
      summary: {
        parsed: parsed.entries.length,
        toCreate: toCreate.length,
        toUpdate: toUpdate.length,
        toSkip: toSkip.length,
        invalid: invalid.length,
        parseErrors: parsed.errors.length,
      },
      categories: { byCategory, fallback },
      // On renvoie uniquement les NOMS — jamais les valeurs.
      keys: {
        toCreate: toCreate.map((v) => v.key),
        toUpdate: toUpdate.map((v) => v.key),
        toSkip: toSkip.map((v) => v.key),
        invalid,
      },
      parseErrors: parsed.errors,
    });
  }

  // ─── Execution reelle ─────────────────────────────────────────────
  // On enchaine N transactions courtes (une par secret) plutot qu'une
  // mega-transaction : meilleur isolement, plus tolerant aux echecs
  // partiels. Si une transaction echoue, on continue et on rapporte
  // dans `failed`.
  const failed: { key: string; reason: string }[] = [];
  let created = 0;
  let updated = 0;

  for (const v of toCreate) {
    try {
      const payload = encrypt(v.value);
      await prisma.secret.create({
        data: {
          key: v.key,
          environmentId: access.environment.id,
          category: v.category,
          tags: defaultTags,
          ...payload,
        },
        select: { id: true },
      });
      created++;
    } catch {
      // Ne JAMAIS echo la valeur dans le rapport d'erreur.
      failed.push({ key: v.key, reason: "Creation echouee" });
    }
  }

  let recategorized = 0;
  for (const v of toUpdate) {
    const existing = existingByKey.get(v.key);
    if (!existing) continue; // safety
    // Le .env fait autorite en mode "overwrite" : si son en-tete range
    // la cle ailleurs, on realigne la categorie avec la valeur. Sans
    // en-tete reconnu, on ne touche a rien (cf. commentaire plus haut).
    const movesCategory = v.detected && existing.category !== v.category;
    try {
      const payload = encrypt(v.value);
      // withTenantSchema, pas prisma.$transaction : cf. F5.1 (lib/prisma.ts).
      await withTenantSchema(access.tenantSlug, async (tx) => {
        await createSecretVersion({
          tx,
          secretId: existing.id,
          encryptedValue: existing.encryptedValue,
          iv: existing.iv,
          tag: existing.tag,
          createdById: access.user.id,
        });
        await tx.secret.update({
          where: { id: existing.id },
          data: movesCategory ? { ...payload, category: v.category } : payload,
          select: { id: true },
        });
      });
      updated++;
      if (movesCategory) recategorized++;
    } catch {
      failed.push({ key: v.key, reason: "Mise a jour echouee" });
    }
  }

  // Audit log unique avec metadata bulk. Aucune valeur n'est loggee
  // (uniquement compteurs + cles, donc safe).
  logAction({
    action: "SECRET_CREATE",
    actor: { kind: "user", userId: access.user.id, email: access.user.email },
    organizationId: access.project.organizationId,
    projectId: access.project.id,
    environmentId: access.environment.id,
    targetType: "Secret",
    targetId: null,
    metadata: {
      bulk: true,
      conflictPolicy,
      parsed: parsed.entries.length,
      created,
      updated,
      recategorized,
      skipped: toSkip.length,
      invalid: invalid.length,
      parseErrors: parsed.errors.length,
      failed: failed.length,
      createdKeys: toCreate.map((v) => v.key),
      updatedKeys: toUpdate.map((v) => v.key),
    },
    req,
  });

  // Sync sortante (fire-and-forget) — uniquement si l'import a modifié l'env.
  if (created > 0 || updated > 0) {
    void triggerSync(access.tenantSlug, access.environment.id, "secret_import", {
      userId: access.user.id,
      email: access.user.email,
    });
  }

  return NextResponse.json({
    dryRun: false,
    summary: {
      parsed: parsed.entries.length,
      created,
      updated,
      recategorized,
      skipped: toSkip.length,
      invalid: invalid.length,
      parseErrors: parsed.errors.length,
      failed: failed.length,
    },
    categories: { byCategory, fallback },
    keys: {
      created: toCreate.map((v) => v.key),
      updated: toUpdate.map((v) => v.key),
      skipped: toSkip.map((v) => v.key),
      invalid,
      failed,
    },
    parseErrors: parsed.errors,
  });
}
