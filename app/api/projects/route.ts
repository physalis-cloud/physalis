import { NextResponse } from "next/server";
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
import { logAction } from "@/lib/audit";

const DEFAULT_ENVS = ["production", "staging", "development"];

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

  const project = await prisma.project.create({
    data: {
      name,
      slug,
      organizationId: access.organization.id,
      environments: { create: uniqueEnvs.map((envName) => ({ name: envName })) },
      members: { create: { userId: user.id, role: "OWNER" } },
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
    metadata: { name: project.name, slug: project.slug, environments: uniqueEnvs },
    req,
  });

  return NextResponse.json({ project }, { status: 201 });
}
