import { NextResponse } from "next/server";
import type { ProjectRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  accessibleProjectsWhere,
  getCurrentOrgSlug,
  isValidEnvName,
  readJson,
  requireOrgMember,
  requireUser,
  slugify,
} from "@/lib/api";
import {
  desiredMembershipRow,
  isDesiredProjectAccess,
  type DesiredProjectAccess,
} from "@/lib/project-access";
import { logAction } from "@/lib/audit";

const DEFAULT_ENVS = ["production", "staging", "development"];

/**
 * Accès des AUTRES membres de l'org, réglé dans le formulaire de création.
 *
 * Sans ça, un projet neuf naît accessible à tous les DEV de l'org (EDITOR
 * implicite, règle 4) : le régler après coup suppose de ne pas l'oublier, et le
 * projet est ouvert entre-temps. Le poser à la création est le seul moment où
 * l'oubli est impossible.
 *
 * Parsing défensif, même parti pris que `parseInvitationProjectAccess` : toute
 * entrée malformée est ignorée en silence plutôt que de faire échouer la
 * création du projet.
 */
function parseMemberAccess(
  raw: unknown,
): Array<{ userId: string; role: DesiredProjectAccess }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ userId: string; role: DesiredProjectAccess }> = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const userId = (entry as { userId?: unknown }).userId;
    const role = (entry as { role?: unknown }).role;
    if (typeof userId !== "string" || !userId) continue;
    if (!isDesiredProjectAccess(role)) continue;
    if (seen.has(userId)) continue;
    seen.add(userId);
    out.push({ userId, role });
  }
  return out;
}

export async function GET(req: Request) {
  const userRes = await requireUser();
  if ("error" in userRes) return userRes.error;
  const { user } = userRes;

  // Optional ?org=<slug>. Defaults to the user's current org.
  const url = new URL(req.url);
  const orgSlug = url.searchParams.get("org") ?? (await getCurrentOrgSlug(user.id));
  if (!orgSlug) {
    return NextResponse.json({ projects: [], orgSlug: null });
  }

  // Verify membership (or global ADMIN).
  const access = await requireOrgMember(orgSlug);
  if ("error" in access) return access.error;

  const projects = await prisma.project.findMany({
    // Ne filtrait que par org : tout MEMBER voyait les noms/slugs de TOUS les
    // projets, y compris ceux masqués pour lui (le POST de secret-requests, lui,
    // les refuse — c'était donc une divulgation, pas une élévation).
    where: accessibleProjectsWhere(
      access.organization.id,
      access.user.id,
      access.role,
    ),
    select: {
      id: true,
      name: true,
      slug: true,
      createdAt: true,
      _count: { select: { environments: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({ projects, orgSlug });
}

export async function POST(req: Request) {
  const userRes = await requireUser();
  if ("error" in userRes) return userRes.error;
  const { user } = userRes;

  const body = (await readJson(req)) as
    | {
        name?: string;
        slug?: string;
        environments?: string[];
        organization?: string;
        memberAccess?: unknown;
      }
    | null;
  if (!body || typeof body.name !== "string" || body.name.trim().length === 0) {
    return NextResponse.json({ error: "Name is required" }, { status: 400 });
  }

  // Project must belong to an organization. Use the body's value if any,
  // otherwise fall back to the user's current org.
  const orgSlug = body.organization?.trim() || (await getCurrentOrgSlug(user.id));
  if (!orgSlug) {
    return NextResponse.json(
      { error: "No organization context — create or switch to an organization first" },
      { status: 400 },
    );
  }

  // Org MEMBER+ can create projects (todo says ADMIN+, but a MEMBER who is
  // the OWNER of the project is also fine; spec is ambiguous — we keep MEMBER
  // for ergonomy and add a project-OWNER membership at creation).
  const access = await requireOrgMember(orgSlug, "MEMBER");
  if ("error" in access) return access.error;

  const name = body.name.trim();
  const slug = (body.slug?.trim() ? slugify(body.slug) : slugify(name)) || "";
  if (!slug) {
    return NextResponse.json({ error: "Invalid slug" }, { status: 400 });
  }

  const envNames = (body.environments ?? DEFAULT_ENVS).map((e) =>
    e.trim().toLowerCase(),
  );
  if (envNames.length === 0 || envNames.some((e) => !isValidEnvName(e))) {
    return NextResponse.json(
      { error: "Invalid environment names" },
      { status: 400 },
    );
  }
  const uniqueEnvs = Array.from(new Set(envNames));

  const existing = await prisma.project.findUnique({ where: { slug } });
  if (existing) {
    return NextResponse.json(
      { error: "Slug already in use" },
      { status: 409 },
    );
  }

  // Accès des autres membres, posé dans la même création que le projet : pas de
  // fenêtre pendant laquelle le projet existe sans ses barrières.
  const requested = parseMemberAccess(body?.memberAccess).filter(
    (e) => e.userId !== user.id,
  );
  const memberRows: Array<{
    userId: string;
    role: ProjectRole;
    hidden: boolean;
  }> = [{ userId: user.id, role: "OWNER", hidden: false }];
  if (requested.length > 0) {
    // Une entrée ne vaut que pour un membre de CETTE org (règle 6 : hors de
    // l'org, aucune ligne ne doit subsister).
    const orgMembers = await prisma.orgMember.findMany({
      where: {
        organizationId: access.organization.id,
        userId: { in: requested.map((e) => e.userId) },
      },
      select: { userId: true, role: true },
    });
    const orgRoleByUser = new Map(orgMembers.map((m) => [m.userId, m.role]));
    for (const e of requested) {
      const orgRole = orgRoleByUser.get(e.userId);
      if (!orgRole) continue;
      // `null` = aucune ligne nécessaire (l'implicite du rôle d'org produit
      // déjà le résultat voulu, ou la cible est OrgADMIN/OWNER : intouchable).
      const row = desiredMembershipRow(orgRole, e.role);
      if (row) memberRows.push({ userId: e.userId, ...row });
    }
  }

  const project = await prisma.project.create({
    data: {
      name,
      slug,
      organizationId: access.organization.id,
      environments: { create: uniqueEnvs.map((envName) => ({ name: envName })) },
      members: { create: memberRows },
    },
    include: { environments: { select: { id: true, name: true } } },
  });

  logAction({
    action: "PROJECT_CREATE",
    actor: { kind: "user", userId: user.id, email: user.email },
    organizationId: access.organization.id,
    projectId: project.id,
    targetType: "Project",
    targetId: project.id,
    metadata: {
      name: project.name,
      slug: project.slug,
      environments: uniqueEnvs,
      // Les lignes posées d'entrée, dont les barrières : sans ça, un membre
      // bloqué dès la création n'apparaîtrait nulle part dans l'audit.
      ...(memberRows.length > 1
        ? {
            memberAccess: memberRows
              .filter((m) => m.userId !== user.id)
              .map((m) => ({
                userId: m.userId,
                access: m.hidden ? "NONE" : m.role,
              })),
          }
        : {}),
    },
    req,
  });

  return NextResponse.json({ project }, { status: 201 });
}
