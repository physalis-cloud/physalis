// PATCH /api/projects/[slug]/members/[userId]
//
// Modifie l'etat d'un OrgMember sur le projet :
//   - hidden : boolean (le projet est masque pour cet user)
//   - role : "VIEWER" | "EDITOR" | "OWNER"
//
// Comportement :
//   - Cible un OrgMember de l'org du projet. 404 sinon (anti-leak).
//   - Refuse de modifier un OrgADMIN/OWNER (toujours OWNER implicite, son
//     hidden serait ignore — on bloque pour eviter la confusion).
//   - Cree la ligne ProjectMember si absente, sinon update.
//   - Audit `PROJECT_MEMBER_VISIBILITY_CHANGE` ou `PROJECT_MEMBER_ROLE_CHANGE`.

import { NextResponse } from "next/server";
import type { ProjectRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { readJson, requireProjectMember } from "@/lib/api";
import { hasDevPrivileges } from "@/lib/roles";
import { logAction } from "@/lib/audit";

export const runtime = "nodejs";

type Params = { params: Promise<{ slug: string; userId: string }> };

type Body = {
  hidden?: boolean;
  role?: ProjectRole;
};

const ROLES: ProjectRole[] = ["VIEWER", "EDITOR", "OWNER"];

export async function PATCH(req: Request, { params }: Params) {
  const { slug, userId } = await params;
  const access = await requireProjectMember(slug, "OWNER", { feature: "multi_users" });
  if ("error" in access) return access.error;

  const body = (await readJson(req)) as Body | null;
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  if (
    typeof body.hidden !== "boolean" &&
    (typeof body.role !== "string" || !ROLES.includes(body.role))
  ) {
    return NextResponse.json(
      { error: "hidden (boolean) or role (VIEWER|EDITOR|OWNER) required" },
      { status: 400 },
    );
  }

  // Verifie que l'user cible est bien OrgMember de l'org du projet.
  const orgMember = await prisma.orgMember.findFirst({
    where: { userId, organizationId: access.project.organizationId },
    select: { role: true, user: { select: { email: true } } },
  });
  if (!orgMember) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (orgMember.role === "OWNER" || orgMember.role === "ADMIN") {
    return NextResponse.json(
      {
        error:
          "Cannot modify OrgADMIN/OWNER on project — they always have implicit OWNER access",
      },
      { status: 400 },
    );
  }

  // Lit l'etat existant.
  const existing = await prisma.projectMember.findUnique({
    where: {
      userId_projectId: { userId, projectId: access.project.id },
    },
  });

  const nextHidden =
    typeof body.hidden === "boolean" ? body.hidden : existing?.hidden ?? false;
  const nextRole: ProjectRole =
    typeof body.role === "string" ? body.role : existing?.role ?? "VIEWER";

  // §4 — « pas de ligne » signifie VIEWER implicite UNIQUEMENT pour un rôle
  // disposant d'un accès projet implicite (OrgDEV/ADMIN_DEV, règle 4). Pour un
  // OrgMEMBER (règle 5), l'absence de ligne = AUCUN accès → « Autoriser l'accès »
  // DOIT créer une ligne (sinon no-op = le membre reste sans accès).
  const hasImplicitAccess = hasDevPrivileges(orgMember.role);

  // Optimisation : on ne crée pas de ligne pour rien quand l'état cible EST le
  // default effectif (hidden=false, role=VIEWER) ET que le rôle a déjà cet accès
  // implicite. Si une ligne existe, on update (pas de delete → historique
  // d'audit préservé).
  let updated;
  if (existing) {
    updated = await prisma.projectMember.update({
      where: { id: existing.id },
      data: { hidden: nextHidden, role: nextRole },
    });
  } else if (nextHidden || nextRole !== "VIEWER" || !hasImplicitAccess) {
    updated = await prisma.projectMember.create({
      data: {
        projectId: access.project.id,
        userId,
        hidden: nextHidden,
        role: nextRole,
      },
    });
  } else {
    // Defaut, pas de changement effectif — on ne cree rien. 200 idempotent.
    return NextResponse.json({ ok: true, noop: true });
  }

  // §2.15 — masquer un membre EST le geste de retrait d'acces projet (il n'y a
  // pas de DELETE). Comme le retrait d'org (§2.7), on revoque les MachineTokens
  // que la cible a crees sur CE projet : sinon un `curl -H 'Authorization:
  // Bearer sv_...' /api/secrets/<projet>/<env>` continue de lire les secrets
  // alors que toutes les surfaces web renvoient 403 (validateToken ne teste que
  // revokedAt, jamais l'appartenance du createur). Revocation PERMANENTE : redonner
  // l'acces plus tard n'exhume pas les anciens tokens. Ordre : la ligne masquee
  // est ecrite AVANT la revocation, pour ne jamais revoquer les tokens d'un
  // membre resté actif si la seconde ecriture echoue.
  let revokedTokenCount = 0;
  let revokedOrgTokenCount = 0;
  if (nextHidden) {
    const revoked = await prisma.machineToken.updateMany({
      where: {
        createdById: userId,
        projectId: access.project.id,
        revokedAt: null,
      },
      data: { revokedAt: new Date() },
    });
    revokedTokenCount = revoked.count;

    // §2.19 — même geste pour les OrgToken de FORME DEV (allProjects=false +
    // expiration) que la cible a créés en couvrant CE projet : leur portée n'est
    // validée qu'à l'émission, donc masquer le projet ne les re-scope pas. On ne
    // touche PAS les tokens de forme institutionnelle (allProjects / sans
    // expiration). ⚠️ Comme à l'offboarding, un token scopé+expirant créé par un
    // ADMIN a la même forme et sera aussi révoqué (over-révocation fail-safe).
    const revokedOrg = await prisma.orgToken.updateMany({
      where: {
        createdById: userId,
        organizationId: access.project.organizationId,
        allProjects: false,
        expiresAt: { not: null },
        allowedProjectIds: { has: access.project.id },
        revokedAt: null,
      },
      data: { revokedAt: new Date() },
    });
    revokedOrgTokenCount = revokedOrg.count;
  }

  // Audit : on log soit visibility soit role selon ce qui a change.
  const visibilityChanged =
    typeof body.hidden === "boolean" &&
    (existing?.hidden ?? false) !== body.hidden;
  const roleChanged =
    typeof body.role === "string" && (existing?.role ?? "VIEWER") !== body.role;

  if (visibilityChanged) {
    logAction({
      action: "PROJECT_MEMBER_VISIBILITY_CHANGE",
      actor: { kind: "user", userId: access.user.id, email: access.user.email },
      organizationId: access.project.organizationId,
      projectId: access.project.id,
      targetType: "ProjectMember",
      targetId: updated.id,
      metadata: {
        targetUserId: userId,
        targetEmail: orgMember.user.email,
        hidden: nextHidden,
        cascadedRevokedTokens: revokedTokenCount,
        cascadedRevokedOrgTokens: revokedOrgTokenCount,
      },
      req,
    });
  }
  if (roleChanged) {
    logAction({
      action: "PROJECT_MEMBER_ROLE_CHANGE",
      actor: { kind: "user", userId: access.user.id, email: access.user.email },
      organizationId: access.project.organizationId,
      projectId: access.project.id,
      targetType: "ProjectMember",
      targetId: updated.id,
      metadata: {
        targetUserId: userId,
        targetEmail: orgMember.user.email,
        from: existing?.role ?? "VIEWER",
        to: nextRole,
      },
      req,
    });
  }

  return NextResponse.json({ ok: true });
}
