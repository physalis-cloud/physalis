import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  isValidGithubRepo,
  isValidWorkflowFile,
  isValidGitBranch,
  readJson,
  requireProjectMember,
} from "@/lib/api";
import { logAction } from "@/lib/audit";

type Params = { params: Promise<{ slug: string }> };

export async function GET(_req: Request, { params }: Params) {
  const { slug } = await params;
  const access = await requireProjectMember(slug, "VIEWER");
  if ("error" in access) return access.error;

  const policies = await prisma.policy.findMany({
    // Écran de policies SERVEUR uniquement : la table porte aussi des policies
    // "mobile" (Phase 2 déploiement mobile), qui visent une app et n'ont pas
    // d'environmentId — leur `environment` null casserait ce rendu.
    where: { projectId: access.project.id, kind: "server" },
    select: {
      id: true,
      repo: true,
      workflow: true,
      branch: true,
      createdAt: true,
      environment: { select: { id: true, name: true } },
    },
    orderBy: [{ environment: { name: "asc" } }, { repo: "asc" }],
  });

  return NextResponse.json({
    policies: policies.map((p) => ({
      id: p.id,
      repo: p.repo,
      workflow: p.workflow,
      branch: p.branch,
      environment: p.environment!.name,
      environmentId: p.environment!.id,
      createdAt: p.createdAt,
    })),
  });
}

export async function POST(req: Request, { params }: Params) {
  const { slug } = await params;
  // ProjectRole.OWNER OU OrgRole.DEV peuvent gérer les policies. La création
  // d'une policy donne un accès lecture aux secrets au workflow correspondant
  // — niveau machine token. On autorise DEV (rôle org transversal) mais pas
  // un EDITOR projet explicite (potentiellement externe à l'org).
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

  // Le repo n'est plus saisi par policy : il est défini au niveau projet
  // (Project.githubRepo) et partagé par toutes les policies. Source unique.
  const project = await prisma.project.findUnique({
    where: { id: access.project.id },
    select: { githubRepo: true },
  });
  const repo = (project?.githubRepo ?? "").trim();
  const workflow = String(body.workflow ?? "").trim();
  const branch = String(body.branch ?? "").trim();
  const envName = String(body.environment ?? "").trim().toLowerCase();

  if (!isValidGithubRepo(repo)) {
    return NextResponse.json(
      { error: "Définis d'abord le repo GitHub du projet (Paramètres)." },
      { status: 400 },
    );
  }
  if (!isValidWorkflowFile(workflow)) {
    return NextResponse.json(
      { error: "Workflow invalide (format `<nom>.yml` attendu)" },
      { status: 400 },
    );
  }
  if (!isValidGitBranch(branch)) {
    return NextResponse.json(
      { error: "Branche invalide" },
      { status: 400 },
    );
  }

  const env = await prisma.environment.findUnique({
    where: { projectId_name: { projectId: access.project.id, name: envName } },
    select: { id: true },
  });
  if (!env) {
    return NextResponse.json(
      { error: "Environnement introuvable" },
      { status: 400 },
    );
  }

  // Conflit (provider, repo, workflow, branch, projectId, environmentId).
  // Overlay self-host : github-only (repo = Project.githubRepo) → provider figé
  // à "github" (défaut du modèle Policy après l'ajout multiprovider).
  const conflict = await prisma.policy.findUnique({
    where: {
      provider_repo_workflow_branch_projectId_environmentId: {
        provider: "github",
        repo,
        workflow,
        branch,
        projectId: access.project.id,
        environmentId: env.id,
      },
    },
    select: { id: true },
  });
  if (conflict) {
    return NextResponse.json(
      { error: "Une policy identique existe déjà" },
      { status: 409 },
    );
  }

  const policy = await prisma.policy.create({
    data: {
      repo,
      workflow,
      branch,
      projectId: access.project.id,
      environmentId: env.id,
    },
    select: {
      id: true,
      repo: true,
      workflow: true,
      branch: true,
      createdAt: true,
      environment: { select: { id: true, name: true } },
    },
  });

  logAction({
    action: "POLICY_CREATE",
    actor: { kind: "user", userId: access.user.id, email: access.user.email },
    organizationId: access.project.organizationId,
    projectId: access.project.id,
    environmentId: env.id,
    targetType: "Policy",
    targetId: policy.id,
    metadata: { repo, workflow, branch, environment: envName },
    req,
  });

  return NextResponse.json(
    {
      policy: {
        id: policy.id,
        repo: policy.repo,
        workflow: policy.workflow,
        branch: policy.branch,
        environment: policy.environment!.name,
        environmentId: policy.environment!.id,
        createdAt: policy.createdAt,
      },
    },
    { status: 201 },
  );
}
