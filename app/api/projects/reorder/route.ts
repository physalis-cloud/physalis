import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  getCurrentOrgSlug,
  readJson,
  requireOrgMember,
  requireUser,
} from "@/lib/api";
import { accessibleProjectsWhere } from "@/lib/project-access";

// POST /api/projects/reorder — persiste le résultat d'un drag-and-drop.
// Body : {
//   assignments: [{ projectId, groupId: string|null, position: number }],
//   groupOrder?: string[]   // ordre des sections de groupe (optionnel)
// }
// Met à jour groupId + position de chaque projet visé et, si fourni, la
// position des groupes. Tout est scopé à l'org courante (ownership vérifié).
export async function POST(req: Request) {
  const userRes = await requireUser();
  if ("error" in userRes) return userRes.error;
  const { user } = userRes;

  const orgSlug = await getCurrentOrgSlug(user.id);
  if (!orgSlug) {
    return NextResponse.json({ error: "No organization context" }, { status: 400 });
  }
  const access = await requireOrgMember(orgSlug, "MEMBER");
  if ("error" in access) return access.error;
  const orgId = access.organization.id;

  const body = (await readJson(req)) as
    | {
        assignments?: { projectId?: string; groupId?: string | null; position?: number }[];
        groupOrder?: string[];
      }
    | null;

  const assignments = Array.isArray(body?.assignments) ? body!.assignments : [];
  const groupOrder = Array.isArray(body?.groupOrder) ? body!.groupOrder : [];

  if (assignments.length === 0 && groupOrder.length === 0) {
    return NextResponse.json({ error: "Nothing to reorder" }, { status: 400 });
  }
  if (assignments.length > 1000 || groupOrder.length > 500) {
    return NextResponse.json({ error: "Payload too large" }, { status: 400 });
  }

  // Validation basique des entrées.
  for (const a of assignments) {
    if (
      !a ||
      typeof a.projectId !== "string" ||
      typeof a.position !== "number" ||
      (a.groupId !== null && typeof a.groupId !== "string")
    ) {
      return NextResponse.json({ error: "Invalid assignment" }, { status: 400 });
    }
  }

  // Périmètre autorisé : projets et groupes appartenant à l'org courante.
  const projectIds = assignments.map((a) => a.projectId as string);
  const groupIds = new Set<string>();
  for (const a of assignments) if (a.groupId) groupIds.add(a.groupId);
  for (const g of groupOrder) if (typeof g === "string") groupIds.add(g);

  const [ownedProjects, ownedGroups] = await Promise.all([
    projectIds.length
      ? prisma.project.findMany({
          // §2.16 — un MEMBER/DEV masqué ne doit pas pouvoir réordonner (donc
          // sortir de son groupe / épingler) un projet qu'il ne voit pas. On
          // passe par la visibilité §4 au lieu du scope `organizationId` seul.
          where: {
            id: { in: projectIds },
            ...accessibleProjectsWhere(orgId, user.id, access.role),
          },
          select: { id: true },
        })
      : Promise.resolve([]),
    groupIds.size
      ? prisma.projectGroup.findMany({
          where: { id: { in: [...groupIds] }, organizationId: orgId },
          select: { id: true },
        })
      : Promise.resolve([]),
  ]);
  const okProjects = new Set(ownedProjects.map((p) => p.id));
  const okGroups = new Set(ownedGroups.map((g) => g.id));

  // On ignore silencieusement toute entrée hors périmètre (anti-leak + robustesse
  // si le client a une vue partielle des projets).
  const updates = assignments
    .filter((a) => okProjects.has(a.projectId as string))
    .filter((a) => a.groupId === null || okGroups.has(a.groupId as string))
    .map((a) =>
      prisma.project.update({
        where: { id: a.projectId as string },
        data: { groupId: a.groupId ?? null, position: Math.trunc(a.position as number) },
      }),
    );

  const groupUpdates = groupOrder
    .filter((g) => okGroups.has(g))
    .map((g, i) =>
      prisma.projectGroup.update({ where: { id: g }, data: { position: i } }),
    );

  await prisma.$transaction([...updates, ...groupUpdates]);

  return NextResponse.json({ ok: true, updated: updates.length });
}
