// #2 — accès projet pré-attribués à une invitation.
//
// Un OWNER/ADMIN peut, en invitant un membre, régler projet par projet ce à quoi
// il aura accès (rôle, ou AUCUN accès). Stocké en JSON sur
// `Invitation.projectAccess`, puis appliqué à l'acceptation.
//
// Pourquoi `"NONE"` existe ici : un invité DEV/ADMIN_DEV a l'EDITOR implicite
// sur TOUS les projets de l'org dès qu'il accepte (règle 4). Sans la possibilité
// de pré-poser une barrière, tout nouveau dev démarre avec l'accès à tout, et
// l'admin doit courir après. `"NONE"` se traduit en ligne `hidden: true`.
//
// Le parsing est défensif : on ignore silencieusement toute entrée malformée,
// et à l'application on ne garde que les projets appartenant réellement à l'org
// (un projet a pu être supprimé entre l'invitation et l'acceptation).

import type { OrgRole, ProjectRole } from "@prisma/client";
import {
  desiredMembershipRow,
  isDesiredProjectAccess,
  type DesiredProjectAccess,
} from "./project-access";

/** Type structurel minimal du `tx` — accepte le tx du client tenant
 *  (getTenantPrisma) comme celui du client étendu (`prisma.$transaction`), dont
 *  les types nominaux diffèrent mais exposent les mêmes opérations. */
type ProjectAccessTx = {
  project: {
    findMany(args: {
      where: { organizationId: string; id: { in: string[] } };
      select: { id: true };
    }): Promise<{ id: string }[]>;
  };
  projectMember: {
    create(args: {
      data: {
        userId: string;
        projectId: string;
        role: ProjectRole;
        hidden: boolean;
      };
    }): Promise<unknown>;
  };
};

export type InvitationProjectAccess = {
  projectId: string;
  role: DesiredProjectAccess;
};

/** Normalise/valide la valeur JSON stockée en une liste d'accès propre. */
export function parseInvitationProjectAccess(
  raw: unknown,
): InvitationProjectAccess[] {
  if (!Array.isArray(raw)) return [];
  const out: InvitationProjectAccess[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const projectId = (entry as { projectId?: unknown }).projectId;
    const role = (entry as { role?: unknown }).role;
    if (typeof projectId !== "string" || !projectId) continue;
    if (!isDesiredProjectAccess(role)) continue;
    if (seen.has(projectId)) continue;
    seen.add(projectId);
    out.push({ projectId, role });
  }
  return out;
}

/**
 * Applique les accès projet d'une invitation à l'acceptation. À appeler DANS la
 * transaction qui crée l'OrgMember, avec le même `tx` (→ même schéma tenant) et
 * le rôle d'org qui vient de lui être posé.
 *
 * Ne crée que des lignes pour des projets appartenant encore à l'org, et
 * seulement quand une ligne est nécessaire : `desiredMembershipRow` renvoie
 * `null` quand l'implicite du rôle d'org produit déjà le résultat voulu (un DEV
 * « autorisé en EDITOR » n'a besoin d'aucune ligne).
 */
export async function applyInvitationProjectAccess(
  tx: ProjectAccessTx,
  organizationId: string,
  projectAccessRaw: unknown,
  userId: string,
  orgRole: OrgRole,
): Promise<void> {
  const entries = parseInvitationProjectAccess(projectAccessRaw);
  if (entries.length === 0) return;

  // Ne garder que les projets qui appartiennent encore à l'org.
  const projects = await tx.project.findMany({
    where: { organizationId, id: { in: entries.map((e) => e.projectId) } },
    select: { id: true },
  });
  const validIds = new Set(projects.map((p) => p.id));

  for (const e of entries) {
    if (!validIds.has(e.projectId)) continue;
    const row = desiredMembershipRow(orgRole, e.role);
    if (!row) continue;
    await tx.projectMember.create({
      data: {
        userId,
        projectId: e.projectId,
        role: row.role,
        hidden: row.hidden,
      },
    });
  }
}
