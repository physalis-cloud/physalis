// #2 — accès projet pré-attribués à une invitation.
//
// Un OWNER/ADMIN peut, en invitant un membre, pré-cocher les projets auxquels il
// aura accès (+ rôle par projet). Stocké en JSON sur `Invitation.projectAccess`,
// puis appliqué (création des ProjectMember non masqués) à l'acceptation.
//
// Le parsing est défensif : on ignore silencieusement toute entrée malformée,
// et à l'application on ne garde que les projets appartenant réellement à l'org
// (un projet a pu être supprimé entre l'invitation et l'acceptation).

import type { ProjectRole } from "@prisma/client";

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

const VALID_ROLES: ReadonlySet<string> = new Set([
  "VIEWER",
  "EDITOR",
  "OWNER",
]);

export type InvitationProjectAccess = { projectId: string; role: ProjectRole };

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
    if (typeof role !== "string" || !VALID_ROLES.has(role)) continue;
    if (seen.has(projectId)) continue;
    seen.add(projectId);
    out.push({ projectId, role: role as ProjectRole });
  }
  return out;
}

/**
 * Applique les accès projet d'une invitation à l'acceptation. À appeler DANS la
 * transaction qui crée l'OrgMember, avec le même `tx` (→ même schéma tenant).
 * Ne crée que des lignes pour des projets appartenant réellement à l'org.
 */
export async function applyInvitationProjectAccess(
  tx: ProjectAccessTx,
  organizationId: string,
  projectAccessRaw: unknown,
  userId: string,
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
    await tx.projectMember.create({
      data: {
        userId,
        projectId: e.projectId,
        role: e.role,
        hidden: false,
      },
    });
  }
}
