import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { readJson, requireProjectMember } from "@/lib/api";
import { logAction } from "@/lib/audit";

type Params = { params: Promise<{ slug: string; id: string }> };

const WORKFLOW_RE = /^[A-Za-z0-9._/ -]+\.ya?ml$/;
const BRANCH_MAX = 200;
const ENV_NAME_MAX = 100;

export async function PATCH(req: Request, { params }: Params) {
  const { slug, id } = await params;
  const access = await requireProjectMember(slug, "VIEWER");
  if ("error" in access) return access.error;
  const canManagePolicies =
    access.role === "OWNER" || access.orgRole === "DEV";
  if (!canManagePolicies) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = (await readJson(req)) as
    | {
        workflow?: string;
        branch?: string;
        environment?: string;
      }
    | null;
  if (!body) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  // Le repo n'est plus éditable par policy : il suit Project.githubRepo.
  const workflow =
    typeof body.workflow === "string" ? body.workflow.trim() : undefined;
  const branch =
    typeof body.branch === "string" ? body.branch.trim() : undefined;
  const envName =
    typeof body.environment === "string" ? body.environment.trim() : undefined;

  if (workflow !== undefined && !WORKFLOW_RE.test(workflow)) {
    return NextResponse.json(
      { error: "workflow invalide (fichier .yml/.yaml)" },
      { status: 400 },
    );
  }
  if (branch !== undefined && (branch.length === 0 || branch.length > BRANCH_MAX)) {
    return NextResponse.json(
      { error: `branch requis (1-${BRANCH_MAX} chars)` },
      { status: 400 },
    );
  }
  if (
    envName !== undefined &&
    (envName.length === 0 || envName.length > ENV_NAME_MAX)
  ) {
    return NextResponse.json(
      { error: `environment requis (1-${ENV_NAME_MAX} chars)` },
      { status: 400 },
    );
  }

  // Charge la policy actuelle (scope projet) pour audit.
  const existing = await prisma.policy.findFirst({
    where: { id, projectId: access.project.id, kind: "server" },
    select: {
      id: true,
      repo: true,
      workflow: true,
      branch: true,
      environmentId: true,
      environment: { select: { name: true } },
    },
  });
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Si l'env name change, résout le nouvel environmentId par (projectId, name).
  let newEnvironmentId = existing.environmentId;
  let newEnvName = existing.environment!.name;
  if (envName !== undefined && envName !== existing.environment!.name) {
    const newEnv = await prisma.environment.findFirst({
      where: { projectId: access.project.id, name: envName },
      select: { id: true, name: true },
    });
    if (!newEnv) {
      return NextResponse.json(
        { error: `Environment "${envName}" not found in project` },
        { status: 404 },
      );
    }
    newEnvironmentId = newEnv.id;
    newEnvName = newEnv.name;
  }

  const newRepo = existing.repo;
  const newWorkflow = workflow ?? existing.workflow;
  const newBranch = branch ?? existing.branch;

  // Pas de no-op silencieux : si rien ne change, retourne 200 sans toucher
  // à la DB (évite log bruité).
  const unchanged =
    newRepo === existing.repo &&
    newWorkflow === existing.workflow &&
    newBranch === existing.branch &&
    newEnvironmentId === existing.environmentId;
  if (unchanged) {
    return NextResponse.json({
      ok: true,
      policy: {
        id: existing.id,
        repo: existing.repo,
        workflow: existing.workflow,
        branch: existing.branch,
        environment: existing.environment!.name,
      },
    });
  }

  // Vérifie la collision sur le tuple unique (sauf l'id en cours).
  const collision = await prisma.policy.findFirst({
    where: {
      projectId: access.project.id,
      repo: newRepo,
      workflow: newWorkflow,
      branch: newBranch,
      environmentId: newEnvironmentId,
      NOT: { id },
    },
    select: { id: true },
  });
  if (collision) {
    return NextResponse.json(
      {
        error:
          "Une autre policy existe déjà avec ce tuple (repo, workflow, branche, environnement).",
      },
      { status: 409 },
    );
  }

  const updated = await prisma.policy.update({
    where: { id },
    data: {
      repo: newRepo,
      workflow: newWorkflow,
      branch: newBranch,
      environmentId: newEnvironmentId,
    },
    select: {
      id: true,
      repo: true,
      workflow: true,
      branch: true,
      environment: { select: { id: true, name: true } },
    },
  });

  logAction({
    action: "POLICY_UPDATE",
    actor: { kind: "user", userId: access.user.id, email: access.user.email },
    organizationId: access.project.organizationId,
    projectId: access.project.id,
    environmentId: updated.environment!.id,
    targetType: "Policy",
    targetId: updated.id,
    metadata: {
      before: {
        repo: existing.repo,
        workflow: existing.workflow,
        branch: existing.branch,
        environment: existing.environment!.name,
      },
      after: {
        repo: updated.repo,
        workflow: updated.workflow,
        branch: updated.branch,
        environment: updated.environment!.name,
      },
    },
    req,
  });

  return NextResponse.json({
    ok: true,
    policy: {
      id: updated.id,
      repo: updated.repo,
      workflow: updated.workflow,
      branch: updated.branch,
      environment: newEnvName,
    },
  });
}

export async function DELETE(req: Request, { params }: Params) {
  const { slug, id } = await params;
  // ProjectRole.OWNER OU OrgRole.DEV — cf. POST /api/projects/[slug]/policies.
  const access = await requireProjectMember(slug, "VIEWER");
  if ("error" in access) return access.error;
  const canManagePolicies =
    access.role === "OWNER" || access.orgRole === "DEV";
  if (!canManagePolicies) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const existing = await prisma.policy.findFirst({
    where: { id, projectId: access.project.id, kind: "server" },
    select: {
      id: true,
      repo: true,
      workflow: true,
      branch: true,
      environmentId: true,
      environment: { select: { name: true } },
    },
  });
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  await prisma.policy.delete({ where: { id: existing.id } });

  logAction({
    action: "POLICY_DELETE",
    actor: { kind: "user", userId: access.user.id, email: access.user.email },
    organizationId: access.project.organizationId,
    projectId: access.project.id,
    environmentId: existing.environmentId,
    targetType: "Policy",
    targetId: existing.id,
    metadata: {
      repo: existing.repo,
      workflow: existing.workflow,
      branch: existing.branch,
      environment: existing.environment!.name,
    },
    req,
  });

  return NextResponse.json({ ok: true });
}
