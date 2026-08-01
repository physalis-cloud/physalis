// /api/vault/entries/[id] — GET reveal (avec password déchiffré),
// PATCH partiel (avec re-encrypt si password change), DELETE.
//
// PATCH gère aussi le CHANGEMENT DE TYPE (cf. lib/vault-entry-types.ts) :
// une entrée LOGIN n'ayant qu'un nom et un mot de passe peut devenir un
// SECRET, une LIST ou une NOTE. La valeur unique est déplacée d'une colonne
// à l'autre CÔTÉ SERVEUR — le client n'a pas besoin d'avoir chargé le clair
// pour convertir, et rien ne peut se perdre en route.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { decrypt, encrypt } from "@/lib/crypto";
import { estimateStrength } from "@/lib/password-strength";
import { readJson, requireUser } from "@/lib/api";
import { logAction } from "@/lib/audit";
import { parseTotpInput } from "@/lib/otpauth-parse";
import {
  CARRIES,
  conversionBlocker,
  isVaultEntryType,
  normalizeEntryType,
  typeHasPasswordStrength,
  validateListItems,
  validateNoteText,
  VAULT_ENTRY_TYPES,
  VAULT_TYPE_LIMITS,
  type VaultEntryType,
  type VaultListItem,
} from "@/lib/vault-entry-types";
import { decryptPayload, encryptPayload } from "@/lib/vault-entry-payload";

const NAME_MAX = 200;
const URL_MAX = 2048;
const USERNAME_MAX = 200;
const PASSWORD_MAX = 4096;
const TOTP_SECRET_MAX = 512;
const TAG_MAX = 50;
const TAGS_MAX = 20;

type Params = { params: Promise<{ id: string }> };

function normalizeTags(input: unknown): string[] | null {
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

export async function GET(req: Request, { params }: Params) {
  const userRes = await requireUser();
  if ("error" in userRes) return userRes.error;
  const { user } = userRes;
  const { id } = await params;

  const entry = await prisma.vaultEntry.findFirst({
    where: { id, userId: user.id },
  });
  if (!entry) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  let password: string | null = null;
  if (entry.encryptedPassword && entry.passwordIv && entry.passwordTag) {
    password = decrypt({
      encryptedValue: entry.encryptedPassword,
      iv: entry.passwordIv,
      tag: entry.passwordTag,
    });
  }

  let totpSecret: string | null = null;
  if (
    entry.encryptedTotpSecret &&
    entry.totpSecretIv &&
    entry.totpSecretTag
  ) {
    totpSecret = decrypt({
      encryptedValue: entry.encryptedTotpSecret,
      iv: entry.totpSecretIv,
      tag: entry.totpSecretTag,
    });
  }

  // Charge utile LIST / NOTE — même révélation tout-ou-rien que le mot de
  // passe (un seul blob par entrée, pas de reveal par item).
  const payload = decryptPayload(entry);

  logAction({
    action: "VAULT_ENTRY_REVEAL",
    actor: { kind: "user", userId: user.id, email: user.email },
    targetType: "VaultEntry",
    targetId: entry.id,
    metadata: { source: "personal", type: entry.type, name: entry.name },
    req,
  });

  return NextResponse.json({
    entry: {
      id: entry.id,
      type: normalizeEntryType(entry.type),
      name: entry.name,
      url: entry.url,
      username: entry.username,
      password,
      totpSecret,
      items: payload.items ?? [],
      text: payload.text ?? "",
      itemCount: entry.itemCount,
      tags: entry.tags,
      favorite: entry.favorite,
      collectionId: entry.collectionId,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    },
  });
}

// ─── Changement de type ──────────────────────────────────────────────────

/** Valeur unique portée par une entrée, quel que soit son type. C'est ce qui
 *  survit à toutes les conversions (chacun des 4 types sait en porter une). */
function readSingleValue(
  entry: {
    encryptedPassword: string | null;
    passwordIv: string | null;
    passwordTag: string | null;
    encryptedData: string | null;
    dataIv: string | null;
    dataTag: string | null;
  },
  type: VaultEntryType,
): string {
  if (CARRIES[type].password) {
    if (!entry.encryptedPassword || !entry.passwordIv || !entry.passwordTag) {
      return "";
    }
    return decrypt({
      encryptedValue: entry.encryptedPassword,
      iv: entry.passwordIv,
      tag: entry.passwordTag,
    });
  }
  const payload = decryptPayload(entry);
  if (type === "LIST") return payload.items?.[0]?.value ?? "";
  if (type === "NOTE") return payload.text ?? "";
  return "";
}

export async function PATCH(req: Request, { params }: Params) {
  const userRes = await requireUser();
  if ("error" in userRes) return userRes.error;
  const { user } = userRes;
  const { id } = await params;

  const existing = await prisma.vaultEntry.findFirst({
    where: { id, userId: user.id },
  });
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

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
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const currentType = normalizeEntryType(existing.type);
  if (body.type !== undefined && !isVaultEntryType(body.type)) {
    return NextResponse.json(
      { error: `type must be one of ${VAULT_ENTRY_TYPES.join(", ")}` },
      { status: 400 },
    );
  }
  const nextType: VaultEntryType = isVaultEntryType(body.type)
    ? body.type
    : currentType;
  const typeChanged = nextType !== currentType;
  const carries = CARRIES[nextType];

  // Une conversion n'est permise que si la cible sait porter tout ce que la
  // source contient déjà — sinon on refuse plutôt que de perdre une URL, un
  // login ou un secret 2FA en silence.
  if (typeChanged) {
    const blocker = conversionBlocker(
      {
        type: currentType,
        url: existing.url,
        username: existing.username,
        hasTotpSecret: existing.encryptedTotpSecret !== null,
        itemCount: existing.itemCount,
      },
      nextType,
    );
    if (blocker) {
      return NextResponse.json(
        {
          error: `cannot convert ${currentType} to ${nextType}: entry has a ${blocker} the target type cannot hold`,
          code: "type_change_not_allowed",
          blocker,
        },
        { status: 400 },
      );
    }
  }

  const data: {
    type?: string;
    name?: string;
    url?: string | null;
    username?: string | null;
    encryptedPassword?: string | null;
    passwordIv?: string | null;
    passwordTag?: string | null;
    passwordStrength?: number | null;
    encryptedTotpSecret?: string | null;
    totpSecretIv?: string | null;
    totpSecretTag?: string | null;
    encryptedData?: string | null;
    dataIv?: string | null;
    dataTag?: string | null;
    itemCount?: number | null;
    tags?: string[];
    favorite?: boolean;
    collectionId?: string | null;
  } = {};
  const changed: string[] = [];

  if (typeof body.name === "string") {
    const v = body.name.trim();
    if (!v || v.length > NAME_MAX) {
      return NextResponse.json(
        { error: `name must be 1-${NAME_MAX} chars` },
        { status: 400 },
      );
    }
    data.name = v;
    changed.push("name");
  }
  // Les champs étrangers au type CIBLE sont ignorés ici : c'est le bloc de
  // conversion, plus bas, qui les met à NULL une bonne fois.
  if ("url" in body && carries.url) {
    if (body.url === null || body.url === "") {
      data.url = null;
    } else if (typeof body.url === "string") {
      data.url = body.url.trim().slice(0, URL_MAX) || null;
    }
    changed.push("url");
  }
  if ("username" in body && carries.username) {
    if (body.username === null || body.username === "") {
      data.username = null;
    } else if (typeof body.username === "string") {
      data.username = body.username.trim().slice(0, USERNAME_MAX) || null;
    }
    changed.push("username");
  }
  if ("password" in body && carries.password) {
    if (body.password === null || body.password === "") {
      data.encryptedPassword = null;
      data.passwordIv = null;
      data.passwordTag = null;
      data.passwordStrength = null;
    } else if (typeof body.password === "string") {
      if (body.password.length > PASSWORD_MAX) {
        return NextResponse.json(
          { error: `password must be <= ${PASSWORD_MAX} chars` },
          { status: 400 },
        );
      }
      const payload = encrypt(body.password);
      data.encryptedPassword = payload.encryptedValue;
      data.passwordIv = payload.iv;
      data.passwordTag = payload.tag;
      // Recalculé sur le clair (jamais depuis le chiffré), et pour le seul
      // type LOGIN — scorer une clé d'API polluerait le filtre « faibles ».
      data.passwordStrength = typeHasPasswordStrength(nextType)
        ? estimateStrength(body.password).score
        : null;
    }
    changed.push("password");
  }
  if ("totpSecret" in body && carries.totp) {
    if (body.totpSecret === null || body.totpSecret === "") {
      data.encryptedTotpSecret = null;
      data.totpSecretIv = null;
      data.totpSecretTag = null;
    } else if (typeof body.totpSecret === "string") {
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
      data.encryptedTotpSecret = payload.encryptedValue;
      data.totpSecretIv = payload.iv;
      data.totpSecretTag = payload.tag;
    }
    changed.push("totpSecret");
  }
  if ("tags" in body) {
    const tags = normalizeTags(body.tags);
    if (tags === null) {
      return NextResponse.json(
        {
          error: `tags must be a string array of <= ${TAGS_MAX} entries, each <= ${TAG_MAX} chars`,
        },
        { status: 400 },
      );
    }
    data.tags = tags;
    changed.push("tags");
  }
  if (typeof body.favorite === "boolean") {
    data.favorite = body.favorite;
    changed.push("favorite");
  }
  if ("collectionId" in body) {
    if (body.collectionId === null || body.collectionId === "") {
      data.collectionId = null;
    } else if (typeof body.collectionId === "string") {
      // Vérifie l'ownership de la collection cible (pas de leak cross-user).
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
      data.collectionId = col.id;
    }
    changed.push("collectionId");
  }

  // ─── Charge utile LIST / NOTE fournie par le client ───────────────────
  let items: VaultListItem[] | undefined;
  let text: string | undefined;
  if ("items" in body && carries.items) {
    const parsed = validateListItems(body.items);
    if (parsed === null) {
      return NextResponse.json(
        {
          error: `items must be an array of <= ${VAULT_TYPE_LIMITS.itemsMax} {label,value}, label <= ${VAULT_TYPE_LIMITS.itemLabelMax} chars, value <= ${VAULT_TYPE_LIMITS.itemValueMax} chars`,
        },
        { status: 400 },
      );
    }
    items = parsed;
    changed.push("items");
  }
  if ("text" in body && carries.text) {
    const parsed = validateNoteText(body.text);
    if (parsed === null) {
      return NextResponse.json(
        { error: `text must be a string of <= ${VAULT_TYPE_LIMITS.noteTextMax} chars` },
        { status: 400 },
      );
    }
    text = parsed;
    changed.push("text");
  }

  // ─── Conversion de type ───────────────────────────────────────────────
  // La valeur unique est déplacée d'une colonne à l'autre ICI, côté serveur :
  // le client convertit sans avoir chargé le clair, et rien ne se perd. Si
  // le body fournit déjà la valeur cible (l'user a édité en même temps),
  // c'est lui qui gagne.
  if (typeChanged) {
    data.type = nextType;
    changed.push("type");

    const keepsPassword = CARRIES[currentType].password && carries.password;
    const value = keepsPassword
      ? ""
      : readSingleValue(existing, currentType);

    if (!carries.url) data.url = null;
    if (!carries.username) data.username = null;
    if (!carries.totp) {
      data.encryptedTotpSecret = null;
      data.totpSecretIv = null;
      data.totpSecretTag = null;
    }

    if (!carries.password) {
      data.encryptedPassword = null;
      data.passwordIv = null;
      data.passwordTag = null;
      data.passwordStrength = null;
    } else if (!keepsPassword && data.encryptedPassword === undefined) {
      // LIST/NOTE → LOGIN/SECRET : la valeur devient le mot de passe.
      if (value.length > PASSWORD_MAX) {
        return NextResponse.json(
          {
            error: `cannot convert ${currentType} to ${nextType}: value exceeds ${PASSWORD_MAX} chars`,
            code: "type_change_not_allowed",
            blocker: "value",
          },
          { status: 400 },
        );
      }
      if (value.length === 0) {
        data.encryptedPassword = null;
        data.passwordIv = null;
        data.passwordTag = null;
        data.passwordStrength = null;
      } else {
        const enc = encrypt(value);
        data.encryptedPassword = enc.encryptedValue;
        data.passwordIv = enc.iv;
        data.passwordTag = enc.tag;
        data.passwordStrength = typeHasPasswordStrength(nextType)
          ? estimateStrength(value).score
          : null;
      }
    } else if (keepsPassword && !typeHasPasswordStrength(nextType)) {
      // LOGIN → SECRET : le mot de passe reste en place, mais son score de
      // force n'a plus de sens.
      data.passwordStrength = null;
    }

    if (carries.items && items === undefined) {
      items = value ? [{ label: existing.name, value }] : [];
    }
    if (carries.text && text === undefined) {
      text = value;
    }
  }

  if (items !== undefined || text !== undefined) {
    const columns = encryptPayload(nextType, { items, text });
    data.encryptedData = columns.encryptedData;
    data.dataIv = columns.dataIv;
    data.dataTag = columns.dataTag;
    data.itemCount = columns.itemCount;
  } else if (typeChanged && !carries.items && !carries.text) {
    // LIST/NOTE → LOGIN/SECRET : pas de blob orphelin sur la ligne.
    data.encryptedData = null;
    data.dataIv = null;
    data.dataTag = null;
    data.itemCount = null;
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ ok: true });
  }

  const updated = await prisma.vaultEntry.update({
    where: { id: existing.id },
    data,
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
    action: "VAULT_ENTRY_UPDATE",
    actor: { kind: "user", userId: user.id, email: user.email },
    targetType: "VaultEntry",
    targetId: updated.id,
    metadata: {
      source: "personal",
      type: nextType,
      ...(typeChanged ? { previousType: currentType } : {}),
      changedFields: changed,
    },
    req,
  });

  return NextResponse.json({ entry: updated });
}

export async function DELETE(req: Request, { params }: Params) {
  const userRes = await requireUser();
  if ("error" in userRes) return userRes.error;
  const { user } = userRes;
  const { id } = await params;

  const existing = await prisma.vaultEntry.findFirst({
    where: { id, userId: user.id },
    select: { id: true, name: true },
  });
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  await prisma.vaultEntry.delete({ where: { id: existing.id } });

  logAction({
    action: "VAULT_ENTRY_DELETE",
    actor: { kind: "user", userId: user.id, email: user.email },
    targetType: "VaultEntry",
    targetId: existing.id,
    metadata: { source: "personal", name: existing.name },
    req,
  });

  return NextResponse.json({ ok: true });
}
