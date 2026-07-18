// PATCH/DELETE d'un OrgToken (Phase 11c).
//
// PATCH : update partiel des champs name / description / allowedScopes /
// allProjects / allowedProjectIds. Le tokenHash et l'expiration sont
// figés à la création.
//
// DELETE : révocation soft (revokedAt = now()). Le token cesse de
// fonctionner immédiatement (validateIntegrationToken refuse les revoked).

import { NextResponse } from "next/server";
import type { OrgTokenScope } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { readJson, requireOrgMember } from "@/lib/api";
import { logAction } from "@/lib/audit";
import {
  orgTokenAccessLevel,
  validateDevTokenCreation,
} from "@/lib/org-token-rbac";

const NAME_MAX = 100;
const DESC_MAX = 500;

const VALID_SCOPES: OrgTokenScope[] = [
  "SECRETS_READ",
  "SERVICES_READ",
  "ACCOUNTS_READ",
  "PROJECTS_LIST",
];

type Params = { params: Promise<{ slug: string; id: string }> };

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

export async function PATCH(req: Request, { params }: Params) {
  const { slug, id } = await params;
  const access = await requireOrgMember(slug, "DEV");
  if ("error" in access) return access.error;

  const level = orgTokenAccessLevel(access.role);
  if (level === "denied") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const existing = await prisma.orgToken.findFirst({
    where: {
      id,
      organizationId: access.organization.id,
      // DEV ne peut PATCH que ses propres tokens.
      ...(level === "dev" ? { createdById: access.user.id } : {}),
    },
    select: {
      id: true,
      name: true,
      description: true,
      allProjects: true,
      allowedProjectIds: true,
      allowedScopes: true,
      expiresAt: true,
    },
  });
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = (await readJson(req)) as
    | {
        name?: string;
        description?: string | null;
        scopes?: string[];
        allProjects?: boolean;
        allowedProjectIds?: string[];
      }
    | null;
  if (!body) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const data: {
    name?: string;
    description?: string | null;
    allowedScopes?: OrgTokenScope[];
    allProjects?: boolean;
    allowedProjectIds?: string[];
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
    if (v !== existing.name) {
      data.name = v;
      changed.push("name");
    }
  }

  if ("description" in body) {
    const v =
      body.description === null || body.description === ""
        ? null
        : typeof body.description === "string"
          ? body.description.trim().slice(0, DESC_MAX) || null
          : null;
    if (v !== existing.description) {
      data.description = v;
      changed.push("description");
    }
  }

  if ("scopes" in body) {
    const scopes = validateScopes(body.scopes);
    if (!scopes || scopes.length === 0) {
      return NextResponse.json(
        { error: "At least one scope is required" },
        { status: 400 },
      );
    }
    const sameScopes =
      scopes.length === existing.allowedScopes.length &&
      scopes.every((s, i) => s === existing.allowedScopes[i]);
    if (!sameScopes) {
      data.allowedScopes = scopes;
      changed.push("scopes");
    }
  }

  // allProjects + allowedProjectIds sont liés. Si l'un change, on traite
  // les deux ensemble pour valider la cohérence.
  if ("allProjects" in body || "allowedProjectIds" in body) {
    const nextAllProjects =
      "allProjects" in body
        ? body.allProjects === true
        : existing.allProjects;

    let nextProjectIds: string[] = existing.allowedProjectIds;
    if ("allowedProjectIds" in body) {
      if (!Array.isArray(body.allowedProjectIds)) {
        return NextResponse.json(
          { error: "allowedProjectIds must be an array" },
          { status: 400 },
        );
      }
      nextProjectIds = body.allowedProjectIds;
    }

    if (!nextAllProjects && nextProjectIds.length === 0) {
      return NextResponse.json(
        { error: "Either allProjects=true or allowedProjectIds non-empty" },
        { status: 400 },
      );
    }

    if (!nextAllProjects) {
      // Vérifie ownership des projets cibles.
      const validProjects = await prisma.project.findMany({
        where: {
          organizationId: access.organization.id,
          id: { in: nextProjectIds },
        },
        select: { id: true },
      });
      if (validProjects.length !== nextProjectIds.length) {
        return NextResponse.json(
          { error: "Some allowedProjectIds do not belong to this organization" },
          { status: 400 },
        );
      }
    }

    // Validation DEV : pas d'allProjects, projets dans memberships.
    if (level === "dev") {
      const memberships = await prisma.projectMember.findMany({
        where: {
          userId: access.user.id,
          project: { organizationId: access.organization.id },
          // Cf. POST : un projet masqué ne doit pas pouvoir être ajouté aux
          // allowedProjectIds, sinon l'update rouvre ce que le create ferme.
          hidden: false,
        },
        select: { projectId: true },
      });
      const devMemberProjectIds = memberships.map((m) => m.projectId);
      const finalIds = nextAllProjects ? [] : nextProjectIds;

      // Calcule l'expiresInDays à partir d'expiresAt existant pour valider
      // que le token reste conforme. Si l'expiresAt est expiré ou null,
      // on rejette (DEV ne doit jamais avoir de token sans expiry).
      const expiresInDays =
        existing.expiresAt &&
        existing.expiresAt.getTime() > Date.now()
          ? Math.ceil(
              (existing.expiresAt.getTime() - Date.now()) /
                (24 * 60 * 60 * 1000),
            )
          : null;

      const rbacError = validateDevTokenCreation({
        allProjects: nextAllProjects,
        allowedProjectIds: finalIds,
        expiresInDays,
        scopes: existing.allowedScopes,
        devMemberProjectIds,
      });
      if (rbacError) {
        return NextResponse.json(
          { error: rbacError.error },
          { status: rbacError.code },
        );
      }
    }

    if (nextAllProjects !== existing.allProjects) {
      data.allProjects = nextAllProjects;
      changed.push("allProjects");
    }
    // Si allProjects=true, on vide allowedProjectIds pour clarté.
    const finalIds = nextAllProjects ? [] : nextProjectIds;
    const sameIds =
      finalIds.length === existing.allowedProjectIds.length &&
      finalIds.every((p, i) => p === existing.allowedProjectIds[i]);
    if (!sameIds) {
      data.allowedProjectIds = finalIds;
      changed.push("allowedProjectIds");
    }
  }

  if (changed.length === 0) {
    return NextResponse.json({ ok: true, orgToken: existing });
  }

  const updated = await prisma.orgToken.update({
    where: { id: existing.id },
    data,
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
    },
  });

  return NextResponse.json({ ok: true, orgToken: updated });
}

export async function DELETE(req: Request, { params }: Params) {
  const { slug, id } = await params;
  const access = await requireOrgMember(slug, "DEV");
  if ("error" in access) return access.error;

  const level = orgTokenAccessLevel(access.role);
  if (level === "denied") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const existing = await prisma.orgToken.findFirst({
    where: {
      id,
      organizationId: access.organization.id,
      // DEV ne peut révoquer que ses propres tokens. ADMIN peut tout.
      ...(level === "dev" ? { createdById: access.user.id } : {}),
    },
    select: { id: true, name: true, revokedAt: true },
  });
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (existing.revokedAt) {
    return NextResponse.json({ ok: true, alreadyRevoked: true });
  }

  await prisma.orgToken.update({
    where: { id: existing.id },
    data: { revokedAt: new Date() },
  });

  logAction({
    action: "ORG_TOKEN_REVOKE",
    actor: { kind: "user", userId: access.user.id, email: access.user.email },
    organizationId: access.organization.id,
    targetType: "OrgToken",
    targetId: existing.id,
    metadata: { name: existing.name },
    req,
  });

  return NextResponse.json({ ok: true });
}
