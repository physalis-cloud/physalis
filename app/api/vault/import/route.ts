// /api/vault/import — import bulk d'entrées dans le coffre perso (V2.0).
//
// Body : { csv: string, dryRun?: boolean }
//   - csv : contenu brut d'un export Bitwarden / Chrome / générique
//   - dryRun : si true, ne crée rien, juste valide + renvoie le preview
//
// Réponse :
//   { ok: true, format, imported: number, collectionsCreated: number,
//     dryRun: boolean, sample: ImportedEntry[] (5 premières) }
//
// Détails :
// - Création des collections folder→VaultCollection idempotente (find ou create)
// - Chaque entry chiffrée avec encrypt() avant insert
// - Pas de transaction globale : on commit batch par batch (50 par 50)
//   pour éviter de tenir une longue tx + rollback partiel acceptable
//   (un retry rejouera les manquants — l'user verra le "imported: N").
// - Pas d'audit individuel (volume) — un seul audit IMPORT_BULK avec count.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { encrypt } from "@/lib/crypto";
import { estimateStrength } from "@/lib/password-strength";
import { readJson, requireUser, slugify } from "@/lib/api";
import { logAction } from "@/lib/audit";
import { parseImport, type ImportedEntry } from "@/lib/csv-import";
import { parseTotpInput } from "@/lib/otpauth-parse";
import { typeHasPasswordStrength } from "@/lib/vault-entry-types";
import { encryptPayload } from "@/lib/vault-entry-payload";

const CSV_MAX = 5_000_000; // 5 MB safety

export async function POST(req: Request) {
  const userRes = await requireUser();
  if ("error" in userRes) return userRes.error;
  const { user } = userRes;

  const body = (await readJson(req)) as
    | { csv?: string; dryRun?: boolean }
    | null;
  const csv = typeof body?.csv === "string" ? body.csv : "";
  const dryRun = body?.dryRun === true;

  if (!csv) {
    return NextResponse.json({ error: "csv required" }, { status: 400 });
  }
  if (csv.length > CSV_MAX) {
    return NextResponse.json(
      { error: `csv too large (max ${CSV_MAX / 1_000_000} MB)` },
      { status: 413 },
    );
  }

  const parsed = parseImport(csv);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  if (dryRun) {
    return NextResponse.json({
      ok: true,
      format: parsed.format,
      imported: parsed.entries.length,
      collectionsCreated: 0,
      dryRun: true,
      sample: parsed.entries.slice(0, 5),
    });
  }

  // Résolution des collections (find or create par slug). Cache mémoire
  // pour éviter N requêtes find pour le même folder.
  const collectionCache = new Map<string, string>(); // slug → id
  let collectionsCreated = 0;

  // Précharge les collections existantes du user (1 seul SELECT).
  const existing = await prisma.vaultCollection.findMany({
    where: { userId: user.id },
    select: { id: true, slug: true },
  });
  for (const c of existing) collectionCache.set(c.slug, c.id);

  async function resolveCollection(name: string | null): Promise<string | null> {
    if (!name) return null;
    const slug = slugify(name);
    if (!slug) return null;
    const cached = collectionCache.get(slug);
    if (cached) return cached;
    const created = await prisma.vaultCollection.create({
      data: { userId: user.id, name: name.slice(0, 80), slug },
      select: { id: true },
    });
    collectionCache.set(slug, created.id);
    collectionsCreated++;
    return created.id;
  }

  let imported = 0;
  for (const e of parsed.entries) {
    const collectionId = await resolveCollection(e.collectionName);
    const data = buildCreateData(e, user.id, collectionId);
    if (!data) continue;
    try {
      await prisma.vaultEntry.create({ data });
      imported++;
    } catch {
      // Skip silently sur les erreurs individuelles (entry malformée
      // post-validation, etc.) — l'user verra "imported: N < total".
    }
  }

  logAction({
    action: "VAULT_ENTRY_CREATE",
    actor: { kind: "user", userId: user.id, email: user.email },
    targetType: "VaultEntry",
    metadata: {
      source: "personal_import",
      format: parsed.format,
      imported,
      collectionsCreated,
    },
    req,
  });

  return NextResponse.json({
    ok: true,
    format: parsed.format,
    imported,
    collectionsCreated,
    dryRun: false,
  });
}

function buildCreateData(
  e: ImportedEntry,
  userId: string,
  collectionId: string | null,
) {
  if (!e.name) return null;

  let encryptedPassword: string | null = null;
  let passwordIv: string | null = null;
  let passwordTag: string | null = null;
  let passwordStrength: number | null = null;
  if (e.password) {
    const payload = encrypt(e.password);
    encryptedPassword = payload.encryptedValue;
    passwordIv = payload.iv;
    passwordTag = payload.tag;
    passwordStrength = typeHasPasswordStrength(e.type)
      ? estimateStrength(e.password).score
      : null;
  }

  // Notes sécurisées : le contenu part dans le blob chiffré, comme pour une
  // NOTE créée depuis l'UI.
  const payloadColumns = encryptPayload(e.type, { text: e.text ?? undefined });

  let encryptedTotpSecret: string | null = null;
  let totpSecretIv: string | null = null;
  let totpSecretTag: string | null = null;
  if (e.totpSecret) {
    const parsedTotp = parseTotpInput(e.totpSecret);
    if (parsedTotp) {
      const payload = encrypt(parsedTotp);
      encryptedTotpSecret = payload.encryptedValue;
      totpSecretIv = payload.iv;
      totpSecretTag = payload.tag;
    }
  }

  return {
    userId,
    collectionId,
    type: e.type,
    name: e.name,
    url: e.url,
    username: e.username,
    encryptedPassword,
    passwordIv,
    passwordTag,
    passwordStrength,
    encryptedTotpSecret,
    totpSecretIv,
    totpSecretTag,
    ...payloadColumns,
    favorite: e.favorite,
  };
}
