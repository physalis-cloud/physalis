// /api/orgs/[slug]/org-tokens — gestion des OrgToken (Phase 11c, étendu 11f.3).
//
// Tokens scopés à l'organisation, pour intégrations N8n / Make pérennes.
//
// RBAC :
//   - OrgADMIN+ : tout droit (allProjects, expiry libre, voit/gère tous les
//                 tokens de l'org)
//   - OrgDEV    : peut créer SES tokens avec restrictions :
//                 pas d'allProjects, projets dans ses ProjectMember
//                 uniquement, expiration obligatoire max 90j, quota 10/user.
//                 Voit/gère SEULEMENT ses propres tokens.
//   - OrgMEMBER : aucun accès (l'onglet n'apparaît même pas)
//
// Cf. docs/org-token.md pour la spec et lib/org-token-rbac.ts pour les
// constraintes.

import { NextResponse } from "next/server";
import type { OrgTokenScope } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { readJson, requireOrgMember } from "@/lib/api";
import { logAction } from "@/lib/audit";
import {
  generateOrgToken,
  tokenPrefixForUi,
} from "@/lib/integration-token";
import {
  DEV_TOKEN_CONSTRAINTS,
  orgTokenAccessLevel,
  validateDevTokenCreation,
} from "@/lib/org-token-rbac";
import { createHash } from "crypto";

const NAME_MAX = 100;
const DESC_MAX = 500;
const MAX_ACTIVE_TOKENS = 50;

const VALID_SCOPES: OrgTokenScope[] = [
  "SECRETS_READ",
  "SERVICES_READ",
  "ACCOUNTS_READ",
  "PROJECTS_LIST",
];

type Params = { params: Promise<{ slug: string }> };

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function validateScopes(input: unknown): OrgTokenScope[] | null {
  if (!Array.isArray(input)) return null;
  const out: OrgTokenScope[] = [];
  for (const s of input) {
    if (typeof s !== "string") return null;
    if (!VALID_SCOPES.includes(s as OrgTokenScope)) return null;
    if (!out.includes(s as OrgTokenScope)) out.push(s as OrgTokenScope);
  }
  return out;
}

export async function GET(_req: Request, { params }: Params) {
  const { slug } = await params;
  // DEV+ peut voir l'onglet ; le filtrage du contenu est appliqué selon
  // le rôle (DEV = ses propres tokens uniquement, ADMIN+ = tous).
  const access = await requireOrgMember(slug, "DEV");
  if ("error" in access) return access.error;

  const level = orgTokenAccessLevel(access.role);
  if (level === "denied") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const tokens = await prisma.orgToken.findMany({
    where: {
      organizationId: access.organization.id,
      // DEV ne voit que les tokens qu'il a créés.
      ...(level === "dev" ? { createdById: access.user.id } : {}),
    },
    select: {
      id: true,
      name: true,
      description: true,
      prefix: true,
      allProjects: true,
      allowedProjectIds: true,
      allowedScopes: true,
      expiresAt: true,
      lastUsedAt: true,
      revokedAt: true,
      createdAt: true,
      createdBy: { select: { email: true } },
    },
    orderBy: [{ revokedAt: "asc" }, { createdAt: "desc" }],
  });

  return NextResponse.json({
    accessLevel: level,
    devConstraints:
      level === "dev"
        ? {
            maxExpiresInDays: DEV_TOKEN_CONSTRAINTS.maxExpiresInDays,
            maxActiveTokensPerUser: DEV_TOKEN_CONSTRAINTS.maxActiveTokensPerUser,
          }
        : null,
    tokens: tokens.map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      prefix: t.prefix,
      allProjects: t.allProjects,
      allowedProjectIds: t.allowedProjectIds,
      allowedScopes: t.allowedScopes,
      expiresAt: t.expiresAt,
      lastUsedAt: t.lastUsedAt,
      revokedAt: t.revokedAt,
      createdAt: t.createdAt,
      createdByEmail: t.createdBy?.email ?? null,
    })),
  });
}

export async function POST(req: Request, { params }: Params) {
  const { slug } = await params;
  const access = await requireOrgMember(slug, "DEV");
  if ("error" in access) return access.error;

  const level = orgTokenAccessLevel(access.role);
  if (level === "denied") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = (await readJson(req)) as
    | {
        name?: string;
        description?: string | null;
        scopes?: string[];
        allProjects?: boolean;
        allowedProjectIds?: string[];
        expiresInDays?: number | null;
      }
    | null;

  const name = String(body?.name ?? "").trim();
  if (!name || name.length > NAME_MAX) {
    return NextResponse.json(
      { error: `name required (1-${NAME_MAX} chars)` },
      { status: 400 },
    );
  }

  const description =
    typeof body?.description === "string" && body.description.trim()
      ? body.description.trim().slice(0, DESC_MAX)
      : null;

  const scopes = validateScopes(body?.scopes);
  if (!scopes || scopes.length === 0) {
    return NextResponse.json(
      { error: "At least one scope is required (SECRETS_READ, SERVICES_READ, ACCOUNTS_READ, PROJECTS_LIST)" },
      { status: 400 },
    );
  }

  // `expiresInDays` vient de `readJson` non typé. On le valide/normalise ICI,
  // une fois, AVANT la garde RBAC DEV et la persistance — qui divergeaient :
  // la garde utilisait `> 90` (laxiste : `"abc" > 90` = false → passait), la
  // persistance `typeof === "number"` (→ expiresAt = null). Un DEV postant
  // `"abc"` obtenait donc un token ÉTERNEL, contournant maxExpiresInDays.
  // null/undefined = pas d'expiration (autorisé ADMIN, rejeté DEV par la garde).
  let expiresInDays: number | null;
  const rawExpiry = body?.expiresInDays;
  if (rawExpiry === null || rawExpiry === undefined) {
    expiresInDays = null;
  } else if (typeof rawExpiry === "number" && Number.isFinite(rawExpiry)) {
    const days = Math.floor(rawExpiry);
    if (days < 1 || days > 365) {
      return NextResponse.json(
        { error: "expiresInDays must be 1-365 or null" },
        { status: 400 },
      );
    }
    expiresInDays = days;
  } else {
    return NextResponse.json(
      { error: "expiresInDays must be a number (1-365) or null" },
      { status: 400 },
    );
  }

  const allProjects = body?.allProjects === true;
  let allowedProjectIds: string[] = [];

  if (!allProjects) {
    if (!Array.isArray(body?.allowedProjectIds) || body.allowedProjectIds.length === 0) {
      return NextResponse.json(
        { error: "allowedProjectIds must contain at least one project id (or set allProjects=true)" },
        { status: 400 },
      );
    }
    // Vérifie que tous les IDs appartiennent à l'org (security check —
    // empêche un OrgADMIN de créer un token pour un projet d'une autre org).
    const validProjects = await prisma.project.findMany({
      where: {
        organizationId: access.organization.id,
        id: { in: body.allowedProjectIds },
      },
      select: { id: true },
    });
    if (validProjects.length !== body.allowedProjectIds.length) {
      return NextResponse.json(
        { error: "Some allowedProjectIds do not belong to this organization" },
        { status: 400 },
      );
    }
    allowedProjectIds = validProjects.map((p) => p.id);
  }

  // ─── RBAC DEV : applique les contraintes additionnelles ─────────
  // (allProjects interdit, projets dans memberships, expiry obligatoire ≤ 90j)
  if (level === "dev") {
    const memberships = await prisma.projectMember.findMany({
      where: {
        userId: access.user.id,
        project: { organizationId: access.organization.id },
        // `hidden: true` = projet masqué pour ce DEV → requireProjectMember lui
        // répond 403 (règle 2). Sans ce filtre il pouvait émettre un token vers
        // un projet que l'UI lui ferme, puis en lire les secrets via
        // /api/integrations/credentials — élévation de privilège.
        hidden: false,
      },
      select: { projectId: true },
    });
    const devMemberProjectIds = memberships.map((m) => m.projectId);

    const rbacError = validateDevTokenCreation({
      allProjects,
      allowedProjectIds,
      expiresInDays,
      scopes,
      devMemberProjectIds,
    });
    if (rbacError) {
      return NextResponse.json(
        { error: rbacError.error },
        { status: rbacError.code },
      );
    }
  }

  let expiresAt: Date | null = null;
  if (expiresInDays !== null) {
    expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);
  }

  // Quota : DEV = 10/user, ADMIN = 50/org. Compte les tokens actifs
  // (non révoqués, non expirés).
  if (level === "dev") {
    const userActiveCount = await prisma.orgToken.count({
      where: {
        organizationId: access.organization.id,
        createdById: access.user.id,
        revokedAt: null,
      },
    });
    if (userActiveCount >= DEV_TOKEN_CONSTRAINTS.maxActiveTokensPerUser) {
      return NextResponse.json(
        {
          error: `Trop de tokens actifs (max ${DEV_TOKEN_CONSTRAINTS.maxActiveTokensPerUser} par DEV). Révoque-en avant d'en créer un nouveau.`,
        },
        { status: 400 },
      );
    }
  } else {
    const activeCount = await prisma.orgToken.count({
      where: { organizationId: access.organization.id, revokedAt: null },
    });
    if (activeCount >= MAX_ACTIVE_TOKENS) {
      return NextResponse.json(
        { error: `Trop de tokens actifs (max ${MAX_ACTIVE_TOKENS}). Révoque-en avant d'en créer un nouveau.` },
        { status: 400 },
      );
    }
  }

  const rawToken = generateOrgToken();
  const tokenHash = hashToken(rawToken);
  const prefix = tokenPrefixForUi(rawToken);

  const created = await prisma.orgToken.create({
    data: {
      organizationId: access.organization.id,
      name,
      description,
      tokenHash,
      prefix,
      allProjects,
      allowedProjectIds,
      allowedScopes: scopes,
      expiresAt,
      createdById: access.user.id,
    },
    select: {
      id: true,
      name: true,
      description: true,
      prefix: true,
      allProjects: true,
      allowedProjectIds: true,
      allowedScopes: true,
      expiresAt: true,
      createdAt: true,
    },
  });

  logAction({
    action: "ORG_TOKEN_CREATE",
    actor: { kind: "user", userId: access.user.id, email: access.user.email },
    organizationId: access.organization.id,
    targetType: "OrgToken",
    targetId: created.id,
    metadata: {
      name,
      scopes,
      allProjects,
      projectCount: allProjects ? null : allowedProjectIds.length,
      hasExpiry: expiresAt !== null,
      creatorRole: access.role,
    },
    req,
  });

  // Le token brut est retourné UNE SEULE FOIS ici. Jamais stocké en clair,
  // jamais ré-affichable.
  return NextResponse.json({ token: rawToken, orgToken: created }, { status: 201 });
}
