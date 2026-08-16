// PUT /api/orgs/[slug]/members/[userId]/project-access
//
// #2 — pose EN BLOC les accès projet d'un membre d'org (modale « Droits d'accès »).
// Réservé OWNER/ADMIN d'org. Chaque entrée du payload dit l'accès VOULU sur un
// projet : `VIEWER|EDITOR|OWNER`, ou `NONE` = aucun accès.
//
// ── Ce que cet endpoint ne fait PAS, à dessein ──
//   Le rôle d'org : il a ses propres gardes critiques (dernier OWNER, seul un
//   OWNER promeut OWNER) dans PATCH members/[userId]. Les dupliquer ici serait
//   la dérive que les tripwires §4/audit interdisent. La modale appelle les
//   deux endpoints.
//
// ── Sémantique de réconciliation (rôle cible DEV/ADMIN_DEV/MEMBER) ──
// La ligne à poser n'est PAS dérivée ici : `desiredMembershipRow` (§4) la donne,
// et c'est la réciproque testée d'`effectiveProjectRole`. On se contente de
// converger vers elle.
//   ligne cible = null, ligne existante  → delete
//   ligne cible ≠ null, pas de ligne     → create
//   ligne cible ≠ null, ligne différente → update
//   projet ABSENT du payload             → intact si masqué, sinon la ligne
//                                          explicite est retirée (contrat
//                                          historique : « non désiré = retiré »)
//
// `NONE` sur un DEV/ADMIN_DEV pose une BARRIÈRE (`hidden=true`) : c'est la seule
// façon d'annuler l'EDITOR implicite de la règle 4. `NONE` sur un OrgMEMBER
// n'écrit rien — l'absence de ligne EST déjà le refus.
//
// ── Révocation des MachineTokens ──
// Déclenchée sur la PERTE D'ACCÈS EFFECTIF (avant ≠ null, après = null), pas sur
// la suppression d'une ligne : un DEV qui perd sa ligne EDITOR garde l'accès
// implicite (rien à révoquer), un DEV qu'on masque le perd vraiment (à révoquer,
// sinon son Bearer continue de lire).
//
// Écritures séquentielles sur le client ambient `prisma` (tenant-aware), comme
// projects/[slug]/members/[userId] : même primitive, aucun jumeau overlay requis.

import { NextResponse } from "next/server";
import type { ProjectRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { readJson, requireOrgMember } from "@/lib/api";
import {
  desiredMembershipRow,
  effectiveProjectRole,
} from "@/lib/project-access";
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

  const existing = await prisma.projectMember.findMany({
    where: { userId, projectId: { in: orgProjectIds } },
  });
  const existingByProject = new Map(existing.map((m) => [m.projectId, m]));

  // Projets à examiner : ceux du payload + ceux qui portent déjà une ligne
  // (pour appliquer le retrait des lignes absentes du payload).
  const touched = new Set<string>([
    ...desiredMap.keys(),
    ...existing.map((m) => m.projectId),
  ]);

  type Change = {
    projectId: string;
    memberId: string;
    before: ProjectRole | null;
    after: ProjectRole | null;
    revokedTokens: number;
  };
  const changes: Change[] = [];

  for (const projectId of touched) {
    const cur = existingByProject.get(projectId) ?? null;

    let targetRow: { role: ProjectRole; hidden: boolean } | null;
    if (desiredMap.has(projectId)) {
      targetRow = desiredMembershipRow(target.role, desiredMap.get(projectId)!);
    } else if (cur?.hidden) {
      // Barrière posée ailleurs (panneau membres du projet) : un payload qui
      // ignore ce projet ne doit pas la lever silencieusement.
      continue;
    } else {
      targetRow = null;
    }

    const sameAsCurrent = cur
      ? targetRow !== null &&
        targetRow.role === cur.role &&
        targetRow.hidden === cur.hidden
      : targetRow === null;
    if (sameAsCurrent) continue;

    const membershipOf = (row: { role: ProjectRole; hidden: boolean } | null) =>
      effectiveProjectRole({ orgRole: target.role, membership: row });
    const before = membershipOf(cur);
    const after = membershipOf(targetRow);

    let memberId: string;
    if (!targetRow) {
      await prisma.projectMember.delete({ where: { id: cur!.id } });
      memberId = cur!.id;
    } else if (!cur) {
      const created = await prisma.projectMember.create({
        data: { userId, projectId, role: targetRow.role, hidden: targetRow.hidden },
      });
      memberId = created.id;
    } else {
      await prisma.projectMember.update({
        where: { id: cur.id },
        data: { role: targetRow.role, hidden: targetRow.hidden },
      });
      memberId = cur.id;
    }

    // §2.15 — la cible perd réellement l'accès : ses MachineTokens sur ce projet
    // doivent être révoqués, sinon un Bearer continue de lire.
    let revokedTokens = 0;
    if (before !== null && after === null) {
      const revoked = await prisma.machineToken.updateMany({
        where: { createdById: userId, projectId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      revokedTokens = revoked.count;
    }

    changes.push({ projectId, memberId, before, after, revokedTokens });
  }

  // Audit — vocabulaire existant, aucune nouvelle valeur d'enum AccessAction.
  // Une perte d'accès est une VISIBILITY_CHANGE (c'est ce que lit le panneau
  // d'audit comme « n'a plus accès »), le reste une ROLE_CHANGE.
  for (const c of changes) {
    const lost = c.after === null;
    logAction({
      action: lost
        ? "PROJECT_MEMBER_VISIBILITY_CHANGE"
        : "PROJECT_MEMBER_ROLE_CHANGE",
      actor: { kind: "user", userId: access.user.id, email: access.user.email },
      organizationId: access.organization.id,
      projectId: c.projectId,
      targetType: "ProjectMember",
      targetId: c.memberId,
      metadata: {
        targetUserId: userId,
        targetEmail: target.user.email,
        // Accès EFFECTIF avant/après, pas l'état de la ligne : c'est ce qui
        // compte pour relire un audit six mois plus tard.
        from: c.before ?? "NONE",
        to: c.after ?? "NONE",
        ...(lost
          ? { removed: true, cascadedRevokedTokens: c.revokedTokens }
          : {}),
        via: "bulk_project_access",
      },
      req,
    });
  }

  return NextResponse.json({
    ok: true,
    granted: changes.filter((c) => c.after !== null).length,
    revoked: changes.filter((c) => c.after === null).length,
  });
}
