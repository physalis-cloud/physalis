// PUT /api/orgs/[slug]/members/[userId]/project-access
//
// #2 — pose EN BLOC les accès projet d'un membre d'org (modale « Droits d'accès »).
// Réservé OWNER/ADMIN d'org. Ne gère QUE les lignes ProjectMember EXPLICITES et
// NON MASQUÉES : c'est l'outil de « donner accès à ces projets avec ce rôle ».
//
// ── Ce que cet endpoint ne fait PAS, à dessein ──
//   • Le rôle d'org : il a ses propres gardes critiques (dernier OWNER, seul un
//     OWNER promeut OWNER) dans PATCH members/[userId]. Les dupliquer ici serait
//     la dérive que les tripwires §4/audit interdisent. La modale appelle les
//     deux endpoints.
//   • Les barrières (`hidden=true`, §2.15) : elles se posent/retirent dans le
//     panneau membres du projet, avec sa cascade de révocation de tokens propre.
//     Ici on ne crée jamais de barrière ; on ne touche pas une ligne masquée
//     absente du set désiré (elle reste bloquante).
//
// ── Sémantique de réconciliation (rôle cible DEV/ADMIN_DEV/MEMBER) ──
//   désiré + pas de ligne         → create {hidden:false, role}
//   désiré + ligne (même masquée) → update {hidden:false, role}  (re-grant OWNER/ADMIN)
//   non désiré + ligne non masquée → delete
//   non désiré + ligne masquée    → intacte
//
// Retirer une ligne peut retirer un accès (OrgMEMBER : pas d'accès implicite) ou
// simplement retomber sur l'accès implicite (DEV/ADMIN_DEV : EDITOR partout,
// règle 4). On ne révoque les MachineTokens de la cible sur le projet QUE dans
// le premier cas — miroir de projects/[slug]/members/[userId] qui ne révoque
// qu'au masquage, jamais à une simple bascule de rôle.
//
// Écritures séquentielles sur le client ambient `prisma` (tenant-aware), comme
// projects/[slug]/members/[userId] : même primitive, aucun jumeau overlay requis.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { readJson, requireOrgMember } from "@/lib/api";
import { hasDevPrivileges } from "@/lib/roles";
import { effectiveProjectRole } from "@/lib/project-access";
import { parseInvitationProjectAccess } from "@/lib/invitation-project-access";
import { logAction } from "@/lib/audit";

export const runtime = "nodejs";

type Params = { params: Promise<{ slug: string; userId: string }> };

// GET — état courant : projets de l'org + accès EXPLICITE du membre, pour
// pré-remplir la modale « Droits d'accès ». Réservé OWNER/ADMIN.
export async function GET(_req: Request, { params }: Params) {
  const { slug, userId } = await params;
  const access = await requireOrgMember(slug, "ADMIN");
  if ("error" in access) return access.error;

  const target = await prisma.orgMember.findUnique({
    where: {
      userId_organizationId: { userId, organizationId: access.organization.id },
    },
    select: { role: true, user: { select: { role: true } } },
  });
  if (!target) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const projects = await prisma.project.findMany({
    where: { organizationId: access.organization.id },
    select: { id: true, slug: true, name: true },
    orderBy: { name: "asc" },
  });
  const memberships = await prisma.projectMember.findMany({
    where: { userId, projectId: { in: projects.map((p) => p.id) } },
    select: { projectId: true, role: true, hidden: true },
  });
  const pmByProject = new Map(memberships.map((m) => [m.projectId, m]));

  const items = projects.map((p) => {
    const pm = pmByProject.get(p.id) ?? null;
    // §4 — accès effectif canonique (ne PAS re-dériver côté client).
    const effective = effectiveProjectRole({
      orgRole: target.role,
      membership: pm ? { role: pm.role, hidden: pm.hidden } : null,
      platformRole: target.user.role,
    });
    return {
      id: p.id,
      slug: p.slug,
      name: p.name,
      // Ligne EXPLICITE non masquée = ce que la modale peut poser/retirer.
      explicit: Boolean(pm && !pm.hidden),
      explicitRole: pm && !pm.hidden ? pm.role : null,
      hidden: Boolean(pm?.hidden),
      hasAccess: effective !== null,
      effectiveRole: effective,
    };
  });

  return NextResponse.json({ orgRole: target.role, projects: items });
}

export async function PUT(req: Request, { params }: Params) {
  const { slug, userId } = await params;
  const access = await requireOrgMember(slug, "ADMIN", { feature: "multi_users" });
  if ("error" in access) return access.error;

  const body = (await readJson(req)) as { projectAccess?: unknown } | null;
  // parse défensif partagé avec l'invitation : {projectId, role∈VIEWER|EDITOR|OWNER},
  // dédupliqué, entrées malformées ignorées.
  const desired = parseInvitationProjectAccess(body?.projectAccess);

  // La cible doit être membre de CETTE org.
  const target = await prisma.orgMember.findUnique({
    where: {
      userId_organizationId: { userId, organizationId: access.organization.id },
    },
    select: { role: true, user: { select: { email: true } } },
  });
  if (!target) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  // OWNER/ADMIN d'org = OWNER implicite partout → accès par projet sans objet
  // (même garde que projects/[slug]/members/[userId]).
  if (target.role === "OWNER" || target.role === "ADMIN") {
    return NextResponse.json(
      {
        error:
          "OrgADMIN/OWNER ont déjà l'accès OWNER implicite sur tous les projets — accès par projet non applicable.",
      },
      { status: 400 },
    );
  }

  // Ne garder que les projets appartenant réellement à l'org.
  const orgProjects = await prisma.project.findMany({
    where: { organizationId: access.organization.id },
    select: { id: true },
  });
  const orgProjectIds = orgProjects.map((p) => p.id);
  const orgProjectIdSet = new Set(orgProjectIds);
  const desiredMap = new Map(
    desired
      .filter((e) => orgProjectIdSet.has(e.projectId))
      .map((e) => [e.projectId, e.role] as const),
  );

  // Un OrgMEMBER n'a AUCUN accès implicite ; un DEV/ADMIN_DEV a l'EDITOR
  // implicite (règle 4) → retirer sa ligne ne lui retire pas l'accès.
  const targetHasImplicitAccess = hasDevPrivileges(target.role);

  const existing = await prisma.projectMember.findMany({
    where: { userId, projectId: { in: orgProjectIds } },
  });
  const existingByProject = new Map(existing.map((m) => [m.projectId, m]));

  type Grant = { projectId: string; memberId: string; from: string | null; to: string };
  type Revoke = { projectId: string; memberId: string; from: string; revokedTokens: number };
  const grants: Grant[] = [];
  const revokes: Revoke[] = [];

  // Grants : create / update vers {hidden:false, role}.
  for (const [projectId, role] of desiredMap) {
    const cur = existingByProject.get(projectId);
    if (!cur) {
      const created = await prisma.projectMember.create({
        data: { userId, projectId, role, hidden: false },
      });
      grants.push({ projectId, memberId: created.id, from: null, to: role });
    } else if (cur.hidden || cur.role !== role) {
      await prisma.projectMember.update({
        where: { id: cur.id },
        data: { hidden: false, role },
      });
      grants.push({
        projectId,
        memberId: cur.id,
        from: cur.hidden ? `hidden:${cur.role}` : cur.role,
        to: role,
      });
    }
  }

  // Retraits : lignes explicites NON masquées absentes du set désiré.
  for (const m of existing) {
    if (m.hidden || desiredMap.has(m.projectId)) continue;
    await prisma.projectMember.delete({ where: { id: m.id } });
    let revokedTokens = 0;
    if (!targetHasImplicitAccess) {
      // §2.15 — la cible perd réellement l'accès : ses MachineTokens sur ce
      // projet doivent être révoqués, sinon un Bearer continue de lire.
      const revoked = await prisma.machineToken.updateMany({
        where: { createdById: userId, projectId: m.projectId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      revokedTokens = revoked.count;
    }
    revokes.push({ projectId: m.projectId, memberId: m.id, from: m.role, revokedTokens });
  }

  // Audit — vocabulaire existant, aucune nouvelle valeur d'enum AccessAction.
  for (const g of grants) {
    logAction({
      action: "PROJECT_MEMBER_ROLE_CHANGE",
      actor: { kind: "user", userId: access.user.id, email: access.user.email },
      organizationId: access.organization.id,
      projectId: g.projectId,
      targetType: "ProjectMember",
      targetId: g.memberId,
      metadata: {
        targetUserId: userId,
        targetEmail: target.user.email,
        from: g.from,
        to: g.to,
        via: "bulk_project_access",
      },
      req,
    });
  }
  for (const r of revokes) {
    logAction({
      action: "PROJECT_MEMBER_VISIBILITY_CHANGE",
      actor: { kind: "user", userId: access.user.id, email: access.user.email },
      organizationId: access.organization.id,
      projectId: r.projectId,
      targetType: "ProjectMember",
      targetId: r.memberId,
      metadata: {
        targetUserId: userId,
        targetEmail: target.user.email,
        removed: true,
        previousRole: r.from,
        cascadedRevokedTokens: r.revokedTokens,
        via: "bulk_project_access",
      },
      req,
    });
  }

  return NextResponse.json({
    ok: true,
    granted: grants.length,
    revoked: revokes.length,
  });
}
