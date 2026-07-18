// Handlers d'entries reutilisables entre les routes org/* et project/*.
// La logique d'acces (check des droits) est passee en parametre via le
// CollectionAccess deja resolu — la fonction se contente d'appliquer la
// validation, le chiffrement et l'audit.

import { NextResponse } from "next/server";
import type { ProjectRole, VaultRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { decrypt, encrypt } from "@/lib/crypto";
import { readJson } from "@/lib/api";
import { logAction } from "@/lib/audit";
import { isPlatformAdmin, hasDevPrivileges } from "@/lib/roles";
import {
  validateEntryCreate,
  validateEntryPatch,
  type EntryCreateBody,
  type EntryPatchBody,
} from "@/lib/vault-entries";
import { hasVaultRole, type CollectionAccess } from "@/lib/vault-access";
import {
  computeReminderNextAt,
  pushRotationHistory,
  type RotationHistoryEntry,
} from "@/lib/rotation-reminder";

// Rangs locaux pour le calcul du role effectif sur une collection cible
// (move entre collections). Doit rester en sync avec lib/vault-access.ts.
const VAULT_RANK_LOCAL: Record<VaultRole, number> = {
  VIEWER: 1,
  EDITOR: 2,
  OWNER: 3,
};
const PROJECT_TO_VAULT_LOCAL: Record<ProjectRole, VaultRole> = {
  VIEWER: "VIEWER",
  EDITOR: "EDITOR",
  OWNER: "OWNER",
};

const ENTRY_LIST_FIELDS = {
  id: true,
  name: true,
  url: true,
  username: true,
  tags: true,
  favorite: true,
  encryptedTotpSecret: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * Retire le champ encryptedTotpSecret du shape liste et le remplace par
 * un booleen `hasTotpSecret` (pratique pour l'UI : badge "2FA stocke" sans
 * lecture chiffree). Le secret reel est uniquement renvoye par revealEntry.
 */
function shapeForList<
  T extends { encryptedTotpSecret: string | null },
>(entry: T): Omit<T, "encryptedTotpSecret"> & { hasTotpSecret: boolean } {
  const { encryptedTotpSecret, ...rest } = entry;
  return { ...rest, hasTotpSecret: encryptedTotpSecret !== null };
}

/** Source pour les audit logs : "org" ou "project". */
function inferSource(access: CollectionAccess): "org" | "project" {
  return access.collection.organizationId !== null ? "org" : "project";
}

export async function listEntries(access: CollectionAccess, req: Request) {
  if (!hasVaultRole(access.role, "VIEWER")) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const url = new URL(req.url);
  const tag = url.searchParams.get("tag");
  const favoriteOnly = url.searchParams.get("favorite") === "true";
  const search = url.searchParams.get("search")?.trim().toLowerCase() ?? "";

  const where: {
    collectionId: string;
    favorite?: boolean;
    tags?: { has: string };
  } = { collectionId: access.collection.id };
  if (favoriteOnly) where.favorite = true;
  if (tag) where.tags = { has: tag };

  const entries = await prisma.teamVaultEntry.findMany({
    where,
    select: ENTRY_LIST_FIELDS,
    orderBy: [{ favorite: "desc" }, { name: "asc" }],
  });

  const filtered = search
    ? entries.filter(
        (e) =>
          e.name.toLowerCase().includes(search) ||
          (e.url ?? "").toLowerCase().includes(search) ||
          (e.username ?? "").toLowerCase().includes(search),
      )
    : entries;

  return NextResponse.json({ entries: filtered.map(shapeForList) });
}

export async function createEntry(access: CollectionAccess, req: Request) {
  if (!hasVaultRole(access.role, "EDITOR")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = (await readJson(req)) as EntryCreateBody | null;
  const v = validateEntryCreate(body);
  if (!v.ok) return v.error;

  let encryptedPassword: string | null = null;
  let passwordIv: string | null = null;
  let passwordTag: string | null = null;
  if (v.password !== null) {
    const payload = encrypt(v.password);
    encryptedPassword = payload.encryptedValue;
    passwordIv = payload.iv;
    passwordTag = payload.tag;
  }

  let encryptedTotpSecret: string | null = null;
  let totpSecretIv: string | null = null;
  let totpSecretTag: string | null = null;
  if (v.totpSecret !== null) {
    const payload = encrypt(v.totpSecret);
    encryptedTotpSecret = payload.encryptedValue;
    totpSecretIv = payload.iv;
    totpSecretTag = payload.tag;
  }

  const entry = await prisma.teamVaultEntry.create({
    data: {
      collectionId: access.collection.id,
      name: v.name,
      url: v.url,
      username: v.username,
      encryptedPassword,
      passwordIv,
      passwordTag,
      encryptedTotpSecret,
      totpSecretIv,
      totpSecretTag,
      tags: v.tags,
      favorite: v.favorite,
    },
    select: ENTRY_LIST_FIELDS,
  });

  logAction({
    action: "VAULT_ENTRY_CREATE",
    actor: { kind: "user", userId: access.user.id, email: access.user.email },
    organizationId: access.organizationId,
    projectId: access.projectId,
    targetType: "TeamVaultEntry",
    targetId: entry.id,
    metadata: {
      source: inferSource(access),
      collectionId: access.collection.id,
      collectionName: access.collection.name,
      hasPassword: encryptedPassword !== null,
      tagsCount: v.tags.length,
    },
    req,
  });

  return NextResponse.json({ entry: shapeForList(entry) }, { status: 201 });
}

export async function revealEntry(
  access: CollectionAccess,
  entryId: string,
  req: Request,
) {
  if (!hasVaultRole(access.role, "VIEWER")) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const entry = await prisma.teamVaultEntry.findFirst({
    where: { id: entryId, collectionId: access.collection.id },
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

  logAction({
    action: "VAULT_ENTRY_REVEAL",
    actor: { kind: "user", userId: access.user.id, email: access.user.email },
    organizationId: access.organizationId,
    projectId: access.projectId,
    targetType: "TeamVaultEntry",
    targetId: entry.id,
    metadata: {
      source: inferSource(access),
      collectionId: access.collection.id,
      name: entry.name,
    },
    req,
  });

  return NextResponse.json({
    entry: {
      id: entry.id,
      name: entry.name,
      url: entry.url,
      username: entry.username,
      password,
      totpSecret,
      tags: entry.tags,
      favorite: entry.favorite,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    },
  });
}

export async function patchEntry(
  access: CollectionAccess,
  entryId: string,
  req: Request,
) {
  if (!hasVaultRole(access.role, "EDITOR")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const existing = await prisma.teamVaultEntry.findFirst({
    where: { id: entryId, collectionId: access.collection.id },
    select: { id: true },
  });
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = (await readJson(req)) as EntryPatchBody | null;
  const v = validateEntryPatch(body);
  if (!v.ok) return v.error;

  // Construire le data Prisma : si password ou totpSecret est dans data,
  // mapper aux 3 colonnes correspondantes (encryptedX/Xiv/Xtag).
  const data: {
    name?: string;
    url?: string | null;
    username?: string | null;
    encryptedPassword?: string | null;
    passwordIv?: string | null;
    passwordTag?: string | null;
    encryptedTotpSecret?: string | null;
    totpSecretIv?: string | null;
    totpSecretTag?: string | null;
    tags?: string[];
    favorite?: boolean;
  } = {};
  if (v.data.name !== undefined) data.name = v.data.name;
  if ("url" in v.data) data.url = v.data.url ?? null;
  if ("username" in v.data) data.username = v.data.username ?? null;
  if ("password" in v.data) {
    if (v.data.password === null) {
      data.encryptedPassword = null;
      data.passwordIv = null;
      data.passwordTag = null;
    } else if (v.data.password !== undefined) {
      const payload = encrypt(v.data.password);
      data.encryptedPassword = payload.encryptedValue;
      data.passwordIv = payload.iv;
      data.passwordTag = payload.tag;
    }
  }
  if ("totpSecret" in v.data) {
    if (v.data.totpSecret === null) {
      data.encryptedTotpSecret = null;
      data.totpSecretIv = null;
      data.totpSecretTag = null;
    } else if (v.data.totpSecret !== undefined) {
      const payload = encrypt(v.data.totpSecret);
      data.encryptedTotpSecret = payload.encryptedValue;
      data.totpSecretIv = payload.iv;
      data.totpSecretTag = payload.tag;
    }
  }
  if (v.data.tags !== undefined) data.tags = v.data.tags;
  if (v.data.favorite !== undefined) data.favorite = v.data.favorite;

  // ─── Move vers une autre collection (same-scope) ────────────────────
  // Si targetCollectionId est present ET different de la collection
  // courante, on resout l'access sur la cible et on ajoute collectionId
  // dans le data. Contraintes :
  //   - Meme scope (org→org dans la meme org, project→project meme projet)
  //   - EDITOR+ requis sur la cible (calcul aligne avec les fonctions
  //     requireOrgCollectionAccess / requireProjectCollectionAccess
  //     dans lib/vault-access.ts)
  let movedFromCollectionId: string | null = null;
  if (
    v.data.targetCollectionId &&
    v.data.targetCollectionId !== access.collection.id
  ) {
    const sourceIsOrg = access.collection.organizationId !== null;
    const sourceIsProject = access.collection.projectId !== null;

    const target = await prisma.teamVaultCollection.findUnique({
      where: { id: v.data.targetCollectionId },
      select: {
        id: true,
        organizationId: true,
        projectId: true,
        organization: {
          select: {
            members: {
              where: { userId: access.user.id },
              select: { role: true },
            },
          },
        },
        project: {
          select: {
            members: {
              where: { userId: access.user.id },
              select: { role: true, hidden: true },
            },
            organization: {
              select: {
                members: {
                  where: { userId: access.user.id },
                  select: { role: true },
                },
              },
            },
          },
        },
        members: {
          where: { userId: access.user.id },
          select: { role: true },
        },
      },
    });
    // 404 (anti-leak) si la cible n'existe pas OU si elle n'est pas dans
    // le meme scope que la source.
    if (!target) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (
      sourceIsOrg &&
      target.organizationId !== access.collection.organizationId
    ) {
      return NextResponse.json(
        { error: "Target collection must be in the same organization" },
        { status: 400 },
      );
    }
    if (
      sourceIsProject &&
      target.projectId !== access.collection.projectId
    ) {
      return NextResponse.json(
        { error: "Target collection must be in the same project" },
        { status: 400 },
      );
    }

    // Calcul du role effectif sur la cible.
    let targetRole: VaultRole | null = null;
    if (sourceIsOrg) {
      const orgRole = target.organization?.members[0]?.role;
      const implicit: VaultRole | null =
        isPlatformAdmin(access.user.role) ||
        orgRole === "OWNER" ||
        orgRole === "ADMIN"
          ? "OWNER"
          : hasDevPrivileges(orgRole)
            ? "EDITOR"
            : null;
      const memberRole = target.members[0]?.role ?? null;
      if (implicit && memberRole) {
        targetRole =
          VAULT_RANK_LOCAL[implicit] >= VAULT_RANK_LOCAL[memberRole]
            ? implicit
            : memberRole;
      } else {
        targetRole = implicit ?? memberRole;
      }
    } else if (sourceIsProject) {
      const membership = target.project?.members[0];
      const orgRole = target.project?.organization?.members[0]?.role;
      if (
        isPlatformAdmin(access.user.role) ||
        orgRole === "OWNER" ||
        orgRole === "ADMIN"
      ) {
        // Regle 1 : OrgADMIN/OWNER ignorent hidden.
        targetRole = "OWNER";
      } else if (membership) {
        // Regle 2 : une ligne masquee bloque le deplacement vers ce projet,
        // sans retomber sur l'EDITOR implicite du DEV.
        if (!membership.hidden) targetRole = PROJECT_TO_VAULT_LOCAL[membership.role];
      } else if (hasDevPrivileges(orgRole)) {
        // Aligne avec requireProjectCollectionAccess : OrgDEV sans
        // ProjectMember explicite obtient EDITOR implicite (regle 4).
        targetRole = "EDITOR";
      }
    }

    if (!targetRole || !hasVaultRole(targetRole, "EDITOR")) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    movedFromCollectionId = access.collection.id;
    (data as typeof data & { collectionId?: string }).collectionId = target.id;
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ ok: true });
  }

  const updated = await prisma.teamVaultEntry.update({
    where: { id: existing.id },
    data,
    select: ENTRY_LIST_FIELDS,
  });

  logAction({
    action: "VAULT_ENTRY_UPDATE",
    actor: { kind: "user", userId: access.user.id, email: access.user.email },
    organizationId: access.organizationId,
    projectId: access.projectId,
    targetType: "TeamVaultEntry",
    targetId: updated.id,
    metadata: {
      source: inferSource(access),
      collectionId: access.collection.id,
      changedFields: v.changed,
      ...(movedFromCollectionId !== null
        ? {
            movedFromCollectionId,
            movedToCollectionId: v.data.targetCollectionId,
          }
        : {}),
    },
    req,
  });

  return NextResponse.json({ entry: shapeForList(updated) });
}

export async function deleteEntry(
  access: CollectionAccess,
  entryId: string,
  req: Request,
) {
  if (!hasVaultRole(access.role, "EDITOR")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const existing = await prisma.teamVaultEntry.findFirst({
    where: { id: entryId, collectionId: access.collection.id },
    select: { id: true, name: true },
  });
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  await prisma.teamVaultEntry.delete({ where: { id: existing.id } });

  logAction({
    action: "VAULT_ENTRY_DELETE",
    actor: { kind: "user", userId: access.user.id, email: access.user.email },
    organizationId: access.organizationId,
    projectId: access.projectId,
    targetType: "TeamVaultEntry",
    targetId: existing.id,
    metadata: {
      source: inferSource(access),
      collectionId: access.collection.id,
      name: existing.name,
    },
    req,
  });

  return NextResponse.json({ ok: true });
}

// ─── Rotation REMINDER (Phase B) ─────────────────────────────────────────
// Coffres équipe/org : rappel d'âge + rotation assistée sur le mot de passe
// (encryptedPassword). Pas de versioning → historique capé à 3 (rotationHistory).
// Stratégie implicite REMINDER : Physalis n'applique rien à la source.

export async function getEntryRotation(access: CollectionAccess, entryId: string) {
  if (!hasVaultRole(access.role, "VIEWER")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const entry = await prisma.teamVaultEntry.findFirst({
    where: { id: entryId, collectionId: access.collection.id },
    select: {
      rotationEnabled: true,
      rotationIntervalDays: true,
      rotationLastAt: true,
      rotationNextAt: true,
      rotationLastStatus: true,
      rotationHistory: true,
    },
  });
  if (!entry) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const history = Array.isArray(entry.rotationHistory) ? entry.rotationHistory : [];
  return NextResponse.json({
    rotation: {
      rotationEnabled: entry.rotationEnabled,
      rotationIntervalDays: entry.rotationIntervalDays,
      rotationLastAt: entry.rotationLastAt,
      rotationNextAt: entry.rotationNextAt,
      rotationLastStatus: entry.rotationLastStatus,
      historyCount: history.length,
    },
  });
}

export async function patchEntryRotation(
  access: CollectionAccess,
  entryId: string,
  req: Request,
) {
  if (!hasVaultRole(access.role, "EDITOR")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const entry = await prisma.teamVaultEntry.findFirst({
    where: { id: entryId, collectionId: access.collection.id },
    select: { id: true, name: true, rotationLastAt: true },
  });
  if (!entry) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = (await readJson(req)) as
    | { rotationEnabled?: boolean; rotationIntervalDays?: number | null }
    | null;
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  const enabled = Boolean(body.rotationEnabled);
  const intervalDays =
    enabled && body.rotationIntervalDays ? Number(body.rotationIntervalDays) : null;
  if (enabled && (!intervalDays || intervalDays < 1 || intervalDays > 3650)) {
    return NextResponse.json({ error: "Intervalle invalide (1–3650 jours)." }, { status: 400 });
  }
  const base = entry.rotationLastAt ?? new Date();
  const nextAt = enabled ? computeReminderNextAt(intervalDays, base) : null;

  await prisma.teamVaultEntry.update({
    where: { id: entry.id },
    data: { rotationEnabled: enabled, rotationIntervalDays: intervalDays, rotationNextAt: nextAt },
    select: { id: true },
  });

  logAction({
    action: "VAULT_ENTRY_UPDATE",
    actor: { kind: "user", userId: access.user.id, email: access.user.email },
    organizationId: access.organizationId,
    projectId: access.projectId,
    targetType: "TeamVaultEntry",
    targetId: entry.id,
    metadata: { source: inferSource(access), changedFields: ["rotationConfig"], rotationEnabled: enabled },
    req,
  });

  return NextResponse.json({ ok: true });
}

// POST assisté : newPassword → remplace encryptedPassword + snapshot l'ancien dans
// rotationHistory (cap 3) + bump. Sans newPassword = marquer roté (bump seul).
export async function rotateEntry(
  access: CollectionAccess,
  entryId: string,
  req: Request,
) {
  if (!hasVaultRole(access.role, "EDITOR")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const entry = await prisma.teamVaultEntry.findFirst({
    where: { id: entryId, collectionId: access.collection.id },
    select: {
      id: true,
      name: true,
      encryptedPassword: true,
      passwordIv: true,
      passwordTag: true,
      rotationIntervalDays: true,
      rotationHistory: true,
    },
  });
  if (!entry) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = (await readJson(req).catch(() => null)) as { newPassword?: string } | null;
  const newPassword =
    body && typeof body.newPassword === "string" && body.newPassword !== ""
      ? body.newPassword
      : null;

  const now = new Date();
  const nextAt = computeReminderNextAt(entry.rotationIntervalDays, now);

  const data: {
    rotationLastAt: Date;
    rotationNextAt: Date | null;
    rotationLastStatus: null;
    encryptedPassword?: string;
    passwordIv?: string;
    passwordTag?: string;
    rotationHistory?: RotationHistoryEntry[];
  } = { rotationLastAt: now, rotationNextAt: nextAt, rotationLastStatus: null };

  if (newPassword) {
    const payload = encrypt(newPassword);
    if (entry.encryptedPassword && entry.passwordIv && entry.passwordTag) {
      data.rotationHistory = pushRotationHistory(entry.rotationHistory, {
        encryptedValue: entry.encryptedPassword,
        iv: entry.passwordIv,
        tag: entry.passwordTag,
        rotatedAt: now.toISOString(),
      });
    }
    data.encryptedPassword = payload.encryptedValue;
    data.passwordIv = payload.iv;
    data.passwordTag = payload.tag;
  }

  await prisma.teamVaultEntry.update({ where: { id: entry.id }, data, select: { id: true } });

  logAction({
    action: "VAULT_ENTRY_UPDATE",
    actor: { kind: "user", userId: access.user.id, email: access.user.email },
    organizationId: access.organizationId,
    projectId: access.projectId,
    targetType: "TeamVaultEntry",
    targetId: entry.id,
    metadata: { source: inferSource(access), changedFields: ["rotation"], valueUpdated: Boolean(newPassword) },
    req,
  });

  return NextResponse.json({ ok: true, valueUpdated: Boolean(newPassword) });
}
