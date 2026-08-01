// /api/vault/entries — coffre personnel (cf. docs/coffres.md)
//
// Toutes les routes sont scopées sur req.user — un user ne voit JAMAIS
// les entrees d'un autre, meme un admin global. Aucun partage en V1.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { encrypt } from "@/lib/crypto";
import { estimateStrength } from "@/lib/password-strength";
import { readJson, requireUser } from "@/lib/api";
import { logAction } from "@/lib/audit";
import { parseTotpInput } from "@/lib/otpauth-parse";
import {
  CARRIES,
  isVaultEntryType,
  normalizeEntryType,
  typeHasPasswordStrength,
  validateListItems,
  validateNoteText,
  VAULT_ENTRY_TYPES,
  VAULT_TYPE_LIMITS,
  type VaultEntryType,
} from "@/lib/vault-entry-types";
import { encryptPayload } from "@/lib/vault-entry-payload";

const NAME_MAX = 200;
const URL_MAX = 2048;
const USERNAME_MAX = 200;
const PASSWORD_MAX = 4096;
const TOTP_SECRET_MAX = 512;
const TAG_MAX = 50;
const TAGS_MAX = 20;

function normalizeTags(input: unknown): string[] | null {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) return null;
  if (input.length > TAGS_MAX) return null;
  const out: string[] = [];
  for (const raw of input) {
    if (typeof raw !== "string") return null;
    const t = raw.trim();
    if (!t) continue;
    if (t.length > TAG_MAX) return null;
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

export async function GET(req: Request) {
  const userRes = await requireUser();
  if ("error" in userRes) return userRes.error;
  const { user } = userRes;

  const url = new URL(req.url);
  const tag = url.searchParams.get("tag");
  const favoriteOnly = url.searchParams.get("favorite") === "true";
  const search = url.searchParams.get("search")?.trim().toLowerCase() ?? "";
  // collectionId : "none" → entries sans collection (NULL en DB)
  //                "<id>" → entries de cette collection (vérif owner via where userId)
  //                absent → toutes les entries
  const collectionParam = url.searchParams.get("collectionId");

  const where: {
    userId: string;
    favorite?: boolean;
    tags?: { has: string };
    collectionId?: string | null;
  } = { userId: user.id };
  if (favoriteOnly) where.favorite = true;
  if (tag) where.tags = { has: tag };
  if (collectionParam === "none") where.collectionId = null;
  else if (collectionParam) where.collectionId = collectionParam;

  // sort : "name" (défaut, favoris en haut puis A→Z), "recent" (récents
  // d'abord), "favorite_first" (favoris en haut puis récents), "strength"
  // (plus faibles d'abord — entries sans mot de passe reléguées en fin).
  const sort = url.searchParams.get("sort") ?? "name";
  const orderBy =
    sort === "recent"
      ? [{ updatedAt: "desc" as const }]
      : sort === "favorite_first"
        ? [{ favorite: "desc" as const }, { updatedAt: "desc" as const }]
        : sort === "strength"
          ? [
              { passwordStrength: { sort: "asc" as const, nulls: "last" as const } },
              { name: "asc" as const },
            ]
          : [{ favorite: "desc" as const }, { name: "asc" as const }];

  const entries = await prisma.vaultEntry.findMany({
    where,
    select: {
      id: true,
      type: true,
      name: true,
      url: true,
      username: true,
      tags: true,
      favorite: true,
      passwordStrength: true,
      encryptedTotpSecret: true,
      itemCount: true,
      collectionId: true,
      createdAt: true,
      updatedAt: true,
    },
    orderBy,
  });

  // Recherche full-text simple cote app (volume faible : coffre perso < 500 entrees).
  const filtered = search
    ? entries.filter(
        (e) =>
          e.name.toLowerCase().includes(search) ||
          (e.url ?? "").toLowerCase().includes(search) ||
          (e.username ?? "").toLowerCase().includes(search),
      )
    : entries;

  // Convertit encryptedTotpSecret en booleen pour le shape liste. Le `type`
  // est normalise ICI : le client indexe dessus (CARRIES, formulaires) et ne
  // doit jamais recevoir une valeur hors des 4 formes connues.
  const shaped = filtered.map(
    ({ encryptedTotpSecret, type, ...rest }) => ({
      ...rest,
      type: normalizeEntryType(type),
      hasTotpSecret: encryptedTotpSecret !== null,
    }),
  );

  return NextResponse.json({ entries: shaped });
}

export async function POST(req: Request) {
  const userRes = await requireUser();
  if ("error" in userRes) return userRes.error;
  const { user } = userRes;

  const body = (await readJson(req)) as
    | {
        type?: string;
        name?: string;
        url?: string | null;
        username?: string | null;
        password?: string | null;
        totpSecret?: string | null;
        items?: unknown;
        text?: unknown;
        tags?: string[];
        favorite?: boolean;
        collectionId?: string | null;
      }
    | null;
  if (!body || typeof body.name !== "string") {
    return NextResponse.json(
      { error: "name is required" },
      { status: 400 },
    );
  }

  // `type` absent → LOGIN (compat : l'extension et les anciens clients ne
  // l'envoient pas). Un type PRÉSENT mais inconnu est une erreur, pas un
  // fallback silencieux.
  if (body.type !== undefined && !isVaultEntryType(body.type)) {
    return NextResponse.json(
      { error: `type must be one of ${VAULT_ENTRY_TYPES.join(", ")}` },
      { status: 400 },
    );
  }
  const type: VaultEntryType = isVaultEntryType(body.type) ? body.type : "LOGIN";
  const carries = CARRIES[type];

  const name = body.name.trim();
  if (!name || name.length > NAME_MAX) {
    return NextResponse.json(
      { error: `name must be 1-${NAME_MAX} chars` },
      { status: 400 },
    );
  }

  // Les champs étrangers au type sont ignorés, pas persistés : une NOTE ne
  // garde pas d'URL fantôme même si le client en envoie une.
  const url =
    carries.url && typeof body.url === "string" && body.url.trim()
      ? body.url.trim().slice(0, URL_MAX)
      : null;
  const username =
    carries.username && typeof body.username === "string" && body.username.trim()
      ? body.username.trim().slice(0, USERNAME_MAX)
      : null;
  const tags = normalizeTags(body.tags);
  if (tags === null) {
    return NextResponse.json(
      {
        error: `tags must be a string array of <= ${TAGS_MAX} entries, each <= ${TAG_MAX} chars`,
      },
      { status: 400 },
    );
  }
  const favorite = body.favorite === true;

  // Collection optionnelle. On vérifie qu'elle appartient bien à l'user.
  let collectionId: string | null = null;
  if (typeof body.collectionId === "string" && body.collectionId.length > 0) {
    const col = await prisma.vaultCollection.findFirst({
      where: { id: body.collectionId, userId: user.id },
      select: { id: true },
    });
    if (!col) {
      return NextResponse.json(
        { error: "collectionId not found" },
        { status: 400 },
      );
    }
    collectionId = col.id;
  }

  let encryptedPassword: string | null = null;
  let passwordIv: string | null = null;
  let passwordTag: string | null = null;
  // Score de force calculé sur le clair, avant chiffrement (jamais recalculé
  // depuis la valeur chiffrée). NULL si pas de mot de passe — et jamais
  // calculé hors LOGIN (une clé d'API n'est pas un mot de passe faible).
  let passwordStrength: number | null = null;
  if (
    carries.password &&
    typeof body.password === "string" &&
    body.password.length > 0
  ) {
    if (body.password.length > PASSWORD_MAX) {
      return NextResponse.json(
        { error: `password must be <= ${PASSWORD_MAX} chars` },
        { status: 400 },
      );
    }
    const payload = encrypt(body.password);
    encryptedPassword = payload.encryptedValue;
    passwordIv = payload.iv;
    passwordTag = payload.tag;
    if (typeHasPasswordStrength(type)) {
      passwordStrength = estimateStrength(body.password).score;
    }
  }

  // Charge utile chiffrée des types LIST / NOTE.
  let payloadColumns;
  if (type === "LIST") {
    const items = validateListItems(body.items ?? []);
    if (items === null) {
      return NextResponse.json(
        {
          error: `items must be an array of <= ${VAULT_TYPE_LIMITS.itemsMax} {label,value}, label <= ${VAULT_TYPE_LIMITS.itemLabelMax} chars, value <= ${VAULT_TYPE_LIMITS.itemValueMax} chars`,
        },
        { status: 400 },
      );
    }
    payloadColumns = encryptPayload(type, { items });
  } else if (type === "NOTE") {
    const text = validateNoteText(body.text ?? "");
    if (text === null) {
      return NextResponse.json(
        { error: `text must be a string of <= ${VAULT_TYPE_LIMITS.noteTextMax} chars` },
        { status: 400 },
      );
    }
    payloadColumns = encryptPayload(type, { text });
  } else {
    payloadColumns = encryptPayload(type, {});
  }

  let encryptedTotpSecret: string | null = null;
  let totpSecretIv: string | null = null;
  let totpSecretTag: string | null = null;
  if (
    carries.totp &&
    typeof body.totpSecret === "string" &&
    body.totpSecret.length > 0
  ) {
    if (body.totpSecret.length > TOTP_SECRET_MAX) {
      return NextResponse.json(
        { error: `totpSecret must be <= ${TOTP_SECRET_MAX} chars` },
        { status: 400 },
      );
    }
    const parsed = parseTotpInput(body.totpSecret);
    if (!parsed) {
      return NextResponse.json(
        { error: "totpSecret must be a base32 secret or an otpauth:// URL" },
        { status: 400 },
      );
    }
    const payload = encrypt(parsed);
    encryptedTotpSecret = payload.encryptedValue;
    totpSecretIv = payload.iv;
    totpSecretTag = payload.tag;
  }

  const entry = await prisma.vaultEntry.create({
    data: {
      userId: user.id,
      collectionId,
      type,
      name,
      url,
      username,
      encryptedPassword,
      passwordIv,
      passwordTag,
      passwordStrength,
      encryptedTotpSecret,
      totpSecretIv,
      totpSecretTag,
      ...payloadColumns,
      tags,
      favorite,
    },
    select: {
      id: true,
      type: true,
      name: true,
      url: true,
      username: true,
      tags: true,
      favorite: true,
      passwordStrength: true,
      itemCount: true,
      collectionId: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  logAction({
    action: "VAULT_ENTRY_CREATE",
    actor: { kind: "user", userId: user.id, email: user.email },
    targetType: "VaultEntry",
    targetId: entry.id,
    metadata: {
      source: "personal",
      type,
      hasPassword: encryptedPassword !== null,
      tagsCount: tags.length,
    },
    req,
  });

  return NextResponse.json({ entry }, { status: 201 });
}
