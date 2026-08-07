// GET /api/me/export
//
// Export RGPD (article 20 — droit à la portabilité). Renvoie un dump
// JSON downloadable contenant toutes les données personnelles de
// l'utilisateur connecté + les données co-détenues sur lesquelles il
// a un rôle (orgs dont il est OWNER, ressources des projets dont il
// est membre, etc.).
//
// Choix UX :
//   - Les secrets et VaultEntry perso sont DÉCHIFFRÉS dans l'export.
//     C'est l'objectif d'un export RGPD : l'utilisateur récupère ses
//     données dans un format utilisable.
//   - Les emails des autres utilisateurs (membres d'orgs, OrgMember
//     d'autres users) sont remplacés par leur userId pour respecter
//     leur propre vie privée. L'utilisateur ne reçoit PAS un dump
//     complet du tenant, juste de SES données et de ce qu'il voit.
//   - Format JSON pretty-printed (indent 2).
//
// Auth : user authentifié. Disponible pour tous les rôles tenant.
// Rate-limit : 1 export / 15 min / user (export peut être lourd).
//
// Jumeau SELF-HOST : `tenantSlug` est retiré de bout en bout. En mono-tenant
// la session le porte TOUJOURS à `null` (cf. lib/api.ts), donc la garde
// `!userId || !tenantSlug` de la version SaaS était vraie à chaque appel :
// l'export RGPD répondait 401 sur toute instance auto-hébergée. Le slug ne
// servait par ailleurs qu'à nommer le fichier — il n'y a qu'une instance ici,
// le nom reste sans ambiguïté sans lui.

import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { decrypt } from "@/lib/crypto";
import { rateLimit } from "@/lib/rate-limit";
import {
  normalizeEntryType,
  type VaultPayload,
} from "@/lib/vault-entry-types";
import { decryptPayload } from "@/lib/vault-entry-payload";

type EncryptedField = {
  encryptedValue: string;
  iv: string;
  tag: string;
};

function safeDecrypt(field: EncryptedField | null): string | null {
  if (!field?.encryptedValue || !field.iv || !field.tag) return null;
  try {
    return decrypt(field);
  } catch (err) {
    console.error("[me/export] decrypt failed:", err);
    return "[DECRYPT_FAILED]";
  }
}

/** Charge utile LIST / NOTE d'une VaultEntry. Même tolérance que safeDecrypt :
 *  un blob illisible ne doit pas faire échouer tout l'export. */
function safeDecryptPayload(row: {
  encryptedData: string | null;
  dataIv: string | null;
  dataTag: string | null;
}): VaultPayload {
  try {
    return decryptPayload(row);
  } catch (err) {
    console.error("[me/export] vault payload decrypt failed:", err);
    return {};
  }
}

/**
 * Charge le coffre personnel (VaultEntry) de l'user, mots de passe
 * déchiffrés. Partagé entre l'export complet et l'export scope=personal.
 */
async function loadPersonalVaultEntries(userId: string) {
  const vaultEntries = await prisma.vaultEntry.findMany({
    where: { userId },
    select: {
      id: true,
      type: true,
      name: true,
      url: true,
      username: true,
      encryptedPassword: true,
      passwordIv: true,
      passwordTag: true,
      encryptedData: true,
      dataIv: true,
      dataTag: true,
      tags: true,
      favorite: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  return vaultEntries.map((v) => {
    // Charge utile des types LIST / NOTE. Sans ça, l'export RGPD — le seul
    // endpoint qui déchiffre par conception — perdrait en silence tout le
    // contenu des entrées qui ne sont pas des logins.
    const type = normalizeEntryType(v.type);
    const payload = safeDecryptPayload(v);
    return {
      id: v.id,
      type,
      name: v.name,
      url: v.url,
      username: v.username,
      password:
        v.encryptedPassword && v.passwordIv && v.passwordTag
          ? safeDecrypt({
              encryptedValue: v.encryptedPassword,
              iv: v.passwordIv,
              tag: v.passwordTag,
            })
          : null,
      ...(type === "LIST" ? { items: payload.items ?? [] } : {}),
      ...(type === "NOTE" ? { text: payload.text ?? "" } : {}),
      tags: v.tags,
      favorite: v.favorite,
      createdAt: v.createdAt,
      updatedAt: v.updatedAt,
    };
  });
}

/** Construit la réponse JSON downloadable (Content-Disposition attachment). */
function buildDownload(payload: unknown, email: string): Response {
  const json = JSON.stringify(payload, null, 2);
  const filename = `physalis-export-${email.replace(/[^a-z0-9]/gi, "_")}-${new Date().toISOString().slice(0, 10)}.json`;
  return new Response(json, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store, max-age=0",
    },
  });
}

/**
 * Horodate le dernier export réussi (`User.dataExportedAt`). Alimente le
 * compteur « X membres sur Y ont récupéré leurs données » et la règle du
 * plancher qui ouvre la purge immédiate à l'owner (cf.
 * docs/steps-docs/todo/suppression-compte.md).
 *
 * Best-effort DÉLIBÉRÉ : si l'écriture échoue, on sert quand même le fichier.
 * Perdre la trace comptable d'un export est bénin ; refuser à quelqu'un la
 * récupération de ses données parce qu'un UPDATE a échoué ne l'est pas.
 */
async function markDataExported(userId: string): Promise<void> {
  await prisma.user
    .update({ where: { id: userId }, data: { dataExportedAt: new Date() } })
    .catch((err) => {
      console.warn(
        `[me/export] marquage dataExportedAt échoué pour ${userId}:`,
        err,
      );
    });
}

export async function GET(req: Request) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Anti-abus : 1 export / 15min / user.
  const limited = rateLimit(req, `me-export:${userId}`, {
    max: 1,
    windowMs: 15 * 60_000,
  });
  if (limited) return limited;

  // ─── 1. User principal (perso) ──────────────────────────────────────
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      role: true,
      twoFactorEnabled: true,
      createdAt: true,
    },
  });
  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  // ─── Export "coffre personnel" (scope=personal) ─────────────────────
  // Utilisé par les membres non owner/admin : ne contient QUE le profil +
  // le coffre personnel (VaultEntry déchiffré). N'expose AUCUNE donnée
  // d'org / projet / secret co-détenue. (Dispo pour tous les rôles.)
  const scope = new URL(req.url).searchParams.get("scope");
  if (scope === "personal") {
    const vaultEntriesExported = await loadPersonalVaultEntries(userId);
    const personalPayload = {
      exportedAt: new Date().toISOString(),
      exportFormat: "physalis-rgpd-v1",
      scope: "personal",
      description:
        "Export RGPD (art. 20). Profil + coffre personnel uniquement (VaultEntry déchiffrés).",
      user,
      vaultEntries: vaultEntriesExported,
    };
    await markDataExported(userId);
    return buildDownload(personalPayload, user.email);
  }

  // ─── 2. Memberships d'org (les orgs où l'user est membre) ───────────
  const orgMemberships = await prisma.orgMember.findMany({
    where: { userId },
    select: {
      role: true,
      createdAt: true,
      organization: {
        select: {
          id: true,
          name: true,
          slug: true,
          createdAt: true,
        },
      },
    },
  });
  const ownerOrgIds = orgMemberships
    .filter((m) => m.role === "OWNER" || m.role === "ADMIN")
    .map((m) => m.organization.id);

  // ─── 3. Projets accessibles ─────────────────────────────────────────
  // Un user voit : projets des orgs où il est ADMIN/OWNER (tous), +
  // projets où il a un ProjectMember explicite (DEV/MEMBER).
  const projectsViaOrgRole =
    ownerOrgIds.length > 0
      ? await prisma.project.findMany({
          where: { organizationId: { in: ownerOrgIds } },
          select: { id: true, name: true, slug: true, organizationId: true, createdAt: true },
        })
      : [];
  const projectsViaMember = await prisma.projectMember.findMany({
    // `hidden: true` = projet masqué pour cet user → requireProjectMember lui
    // répond 403 (règle 2). Sans ce filtre, l'export RGPD servait les secrets
    // DÉCHIFFRÉS d'un projet que l'UI lui ferme — l'endpoint le plus permissif
    // du code (seul à déchiffrer par conception) était le seul à ne pas filtrer.
    where: { userId, hidden: false },
    select: {
      role: true,
      project: {
        select: {
          id: true,
          name: true,
          slug: true,
          organizationId: true,
          createdAt: true,
        },
      },
    },
  });
  const projectIdSet = new Set([
    ...projectsViaOrgRole.map((p) => p.id),
    ...projectsViaMember.map((m) => m.project.id),
  ]);
  const projectIds = Array.from(projectIdSet);

  // ─── 4. Environments + Secrets (déchiffrés) ─────────────────────────
  const environments =
    projectIds.length > 0
      ? await prisma.environment.findMany({
          where: { projectId: { in: projectIds } },
          select: {
            id: true,
            name: true,
            url: true,
            projectId: true,
            secrets: {
              select: {
                key: true,
                encryptedValue: true,
                iv: true,
                tag: true,
                createdAt: true,
              },
            },
          },
        })
      : [];
  const environmentsExported = environments.map((e) => ({
    id: e.id,
    name: e.name,
    url: e.url,
    projectId: e.projectId,
    secrets: e.secrets.map((s) => ({
      key: s.key,
      value: safeDecrypt(s),
      createdAt: s.createdAt,
    })),
  }));

  // ─── 5. OrgSecrets (s'il a accès via OrgMember role >= DEV) ─────────
  const devPlusOrgIds = orgMemberships
    .filter(
      (m) =>
        m.role === "OWNER" ||
        m.role === "ADMIN" ||
        m.role === "ADMIN_DEV" ||
        m.role === "DEV",
    )
    .map((m) => m.organization.id);
  const orgSecrets =
    devPlusOrgIds.length > 0
      ? await prisma.orgSecret.findMany({
          where: { organizationId: { in: devPlusOrgIds } },
          select: {
            key: true,
            encryptedValue: true,
            iv: true,
            tag: true,
            organizationId: true,
            createdAt: true,
          },
        })
      : [];
  const orgSecretsExported = orgSecrets.map((s) => ({
    key: s.key,
    value: safeDecrypt(s),
    organizationId: s.organizationId,
    createdAt: s.createdAt,
  }));

  // ─── 6. Coffre personnel (VaultEntry) — DÉCHIFFRÉ ────────────────────
  const vaultEntriesExported = await loadPersonalVaultEntries(userId);

  // ─── 7. AccessLog (actions de l'user) ───────────────────────────────
  const accessLogs = await prisma.accessLog.findMany({
    where: { actorUserId: userId },
    orderBy: { createdAt: "desc" },
    take: 5000, // cap pour éviter un dump énorme
    select: {
      action: true,
      organizationId: true,
      projectId: true,
      environmentId: true,
      secretKey: true,
      ipAddress: true,
      userAgent: true,
      metadata: true,
      createdAt: true,
    },
  });

  // ─── 8. MachineTokens créés par l'user ──────────────────────────────
  const machineTokens = await prisma.machineToken.findMany({
    where: { createdById: userId },
    select: {
      id: true,
      name: true,
      projectId: true,
      environmentId: true,
      lastUsedAt: true,
      revokedAt: true,
      createdAt: true,
    },
  });

  // ─── 9. PluginTokens (sessions navigateur) ──────────────────────────
  const pluginTokens = await prisma.pluginToken.findMany({
    where: { userId },
    select: {
      id: true,
      userAgent: true,
      lastUsedAt: true,
      expiresAt: true,
      createdAt: true,
    },
  });

  // ─── 10. Invitations émises ou reçues ───────────────────────────────
  const invitations = await prisma.invitation.findMany({
    where: {
      OR: [{ invitedById: userId }, { email: user.email }],
    },
    select: {
      id: true,
      email: true,
      organizationId: true,
      role: true,
      acceptedAt: true,
      expiresAt: true,
      invitedById: true,
      createdAt: true,
    },
  });

  // ─── 11. Construction de l'export ───────────────────────────────────
  const exportPayload = {
    exportedAt: new Date().toISOString(),
    exportFormat: "physalis-rgpd-v1",
    description:
      "Export RGPD (art. 20 — droit à la portabilité). Données personnelles + ressources co-détenues où vous avez un rôle. Les secrets et VaultEntry sont déchiffrés.",
    user,
    orgMemberships: orgMemberships.map((m) => ({
      role: m.role,
      createdAt: m.createdAt,
      organization: m.organization,
    })),
    projects: Array.from(projectIdSet).map((id) => {
      const fromOrg = projectsViaOrgRole.find((p) => p.id === id);
      const fromMember = projectsViaMember.find((m) => m.project.id === id);
      const project = fromOrg ?? fromMember?.project;
      return {
        ...project,
        accessVia: fromOrg
          ? "org_role"
          : `project_member_${fromMember?.role ?? "?"}`,
      };
    }),
    environments: environmentsExported,
    orgSecrets: orgSecretsExported,
    vaultEntries: vaultEntriesExported,
    accessLogs,
    machineTokens,
    pluginTokens,
    invitations,
  };

  await markDataExported(userId);
  return buildDownload(exportPayload, user.email);
}
