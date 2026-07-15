// POST /api/projects/[slug]/[env]/secrets/import — import bulk d'un
// fichier .env (texte) vers les Secrets de l'environnement cible.
//
// Body : { envText, conflictPolicy, dryRun?, defaultCategory?, defaultTags? }
//
// Flow :
//   1. RBAC : EDITOR+ sur l'environnement (memes regles que POST single).
//   2. Parse via lib/env-parser (tolerant aux erreurs ligne par ligne).
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
import { encrypt } from "@/lib/crypto";
import {
  isValidSecretKey,
  readJson,
  requireEnvironment,
} from "@/lib/api";
import { isValidCategory } from "@/lib/categories";
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
  let defaultCategory: string | null = null;
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

  // Separation valid / invalid selon la regex stricte de l'app.
  const valid: { key: string; value: string }[] = [];
  const invalid: { key: string; reason: string }[] = [];
  for (const e of parsed.entries) {
    if (!isValidSecretKey(e.key)) {
      invalid.push({
        key: e.key,
        reason: "Nom invalide (doit matcher [A-Z][A-Z0-9_]{0,127})",
      });
    } else {
      valid.push(e);
    }
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
          category: defaultCategory,
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

  for (const v of toUpdate) {
    const existing = existingByKey.get(v.key);
    if (!existing) continue; // safety
    try {
      const payload = encrypt(v.value);
      await prisma.$transaction(async (tx) => {
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
          data: { ...payload },
          select: { id: true },
        });
      });
      updated++;
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
      skipped: toSkip.length,
      invalid: invalid.length,
      parseErrors: parsed.errors.length,
      failed: failed.length,
    },
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
