import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { readJson, requireProjectMember, slugify } from "@/lib/api";
import { logAction } from "@/lib/audit";
import { hasDevPrivileges } from "@/lib/roles";

type Params = { params: Promise<{ slug: string }> };

export async function GET(_req: Request, { params }: Params) {
  const { slug } = await params;
  const access = await requireProjectMember(slug);
  if ("error" in access) return access.error;

  const project = await prisma.project.findUnique({
    where: { id: access.project.id },
    select: {
      id: true,
      name: true,
      slug: true,
      organizationId: true,
      createdAt: true,
      githubRepo: true,
      githubWorkflow: true,
      environments: {
        select: {
          id: true,
          name: true,
          url: true,
          _count: { select: { secrets: true } },
        },
        orderBy: { name: "asc" },
      },
      _count: { select: { tokens: { where: { revokedAt: null } } } },
    },
  });

  return NextResponse.json({
    project,
    role: access.role,
  });
}

const GITHUB_REPO_RE = /^[a-z0-9._-]+\/[a-z0-9._-]+$/i;

export async function PATCH(req: Request, { params }: Params) {
  const { slug } = await params;
  // Settings projet (name, slug, github config) : ouvert a EDITOR+ pour
  // que les DEV puissent ajuster la config technique sans solliciter un
  // OWNER. La suppression (DELETE) reste OWNER-only (destructif).
  const access = await requireProjectMember(slug, "EDITOR");
  if ("error" in access) return access.error;

  const body = (await readJson(req)) as
    | {
        name?: string;
        slug?: string;
        githubRepo?: string | null;
        githubWorkflow?: string | null;
      }
    | null;
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const data: {
    name?: string;
    slug?: string;
    githubRepo?: string | null;
    githubWorkflow?: string | null;
  } = {};
  const changed: string[] = [];
  let oldSlug: string | undefined;

  if (typeof body.name === "string") {
    const newName = body.name.trim();
    if (!newName) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }
    if (newName !== access.project.name) {
      data.name = newName;
      changed.push("name");
    }
  }

  if (typeof body.slug === "string") {
    const newSlug = slugify(body.slug);
    if (!newSlug) {
      return NextResponse.json({ error: "Slug invalide" }, { status: 400 });
    }
    if (newSlug !== access.project.slug) {
      const conflict = await prisma.project.findUnique({
        where: { slug: newSlug },
        select: { id: true },
      });
      if (conflict) {
        return NextResponse.json(
          { error: "Ce slug est déjà utilisé par un autre projet" },
          { status: 409 },
        );
      }
      data.slug = newSlug;
      oldSlug = access.project.slug;
      changed.push("slug");
    }
  }

  if ("githubRepo" in body) {
    if (body.githubRepo === null || body.githubRepo === "") {
      data.githubRepo = null;
      changed.push("githubRepo");
    } else if (typeof body.githubRepo === "string") {
      const repo = body.githubRepo.trim();
      if (!GITHUB_REPO_RE.test(repo)) {
        return NextResponse.json(
          { error: "githubRepo doit etre au format owner/repo" },
          { status: 400 },
        );
      }
      data.githubRepo = repo;
      changed.push("githubRepo");
    }
  }

  if ("githubWorkflow" in body) {
    if (body.githubWorkflow === null || body.githubWorkflow === "") {
      data.githubWorkflow = null;
      changed.push("githubWorkflow");
    } else if (typeof body.githubWorkflow === "string") {
      data.githubWorkflow = body.githubWorkflow.trim();
      changed.push("githubWorkflow");
    }
  }

  if (changed.length === 0) {
    return NextResponse.json({ ok: true, project: access.project });
  }

  // AUTORISATION CI/CD : les champs qui pilotent les policies OIDC (repo,
  // workflow) sont réservés à OWNER projet OU OrgDEV — miroir de la garde des
  // policies. Un EDITOR projet simple ne doit pas repointer la config CI.
  // Cf. docs/failles.md §2.3 (porté depuis la source SaaS).
  const CI_FIELDS = ["githubRepo", "githubWorkflow"];
  const ciConfigChanged = changed.some((f) => CI_FIELDS.includes(f));
  const canManageCiConfig =
    access.role === "OWNER" || hasDevPrivileges(access.orgRole);
  if (ciConfigChanged && !canManageCiConfig) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const updated = await prisma.project.update({
    where: { id: access.project.id },
    data,
    select: {
      id: true,
      name: true,
      slug: true,
      githubRepo: true,
      githubWorkflow: true,
    },
  });

  logAction({
    action: "PROJECT_UPDATE",
    actor: { kind: "user", userId: access.user.id, email: access.user.email },
    organizationId: access.project.organizationId,
    projectId: access.project.id,
    targetType: "Project",
    targetId: access.project.id,
    metadata: {
      changedFields: changed,
      ...(oldSlug ? { fromSlug: oldSlug, toSlug: data.slug } : {}),
    },
    req,
  });

  return NextResponse.json({ ok: true, project: updated });
}

export async function DELETE(req: Request, { params }: Params) {
  const { slug } = await params;
  const access = await requireProjectMember(slug, "OWNER");
  if ("error" in access) return access.error;

  // Phase 11c — cleanup des OrgToken qui référencent ce projet :
  // retire son ID de allowedProjectIds[]. Pas de FK array native en
  // Postgres → on fait l'update applicatif via array_remove.
  // Les OrgToken avec allProjects=true ne sont pas concernés.
  await prisma.$executeRaw`
    UPDATE "OrgToken"
    SET "allowedProjectIds" = array_remove("allowedProjectIds", ${access.project.id})
    WHERE "organizationId" = ${access.project.organizationId}
      AND ${access.project.id} = ANY("allowedProjectIds")
  `;

  await prisma.project.delete({ where: { id: access.project.id } });

  logAction({
    action: "PROJECT_DELETE",
    actor: { kind: "user", userId: access.user.id, email: access.user.email },
    organizationId: access.project.organizationId,
    targetType: "Project",
    targetId: access.project.id,
    metadata: { name: access.project.name, slug: access.project.slug },
    req,
  });

  return NextResponse.json({ ok: true });
}
