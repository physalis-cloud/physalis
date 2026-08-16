// Jumeau self-host — policies d'une app mobile. Mono-tenant : pas de miroir
// admin.policies, pas de gate de plan. Le repo/provider viennent de la
// connexion CI du projet (loadProjectCiMeta), comme la source.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireProjectMember, readJson } from "@/lib/api";
import { logAction } from "@/lib/audit";
import { loadProjectCiMeta } from "@/lib/ci-connection";
import { hasDevPrivileges } from "@/lib/roles";
import { requireProjectMobileEnabled } from "@/lib/mobile-guard";
import {
  isValidWorkflowFile,
  isValidGitBranch,
  isValidCiEnvironmentName,
} from "@/lib/validation";

type Params = { params: Promise<{ slug: string; appId: string }> };

async function loadApp(projectId: string, appId: string) {
  return prisma.mobileApp.findFirst({
    where: { id: appId, projectId },
    select: { id: true, platform: true, bundleId: true },
  });
}

export async function GET(_req: Request, { params }: Params) {
  const { slug, appId } = await params;
  const access = await requireProjectMember(slug, "VIEWER");
  if ("error" in access) return access.error;
  const off = requireProjectMobileEnabled(access.project);
  if (off) return off;

  const app = await loadApp(access.project.id, appId);
  if (!app) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const [policies, ci] = await Promise.all([
    prisma.policy.findMany({
      where: { projectId: access.project.id, kind: "mobile", mobileAppId: app.id },
      select: {
        id: true,
        provider: true,
        repo: true,
        workflow: true,
        branch: true,
        createdAt: true,
      },
      orderBy: [{ branch: "asc" }, { workflow: "asc" }],
    }),
    loadProjectCiMeta(prisma, access.project.id),
  ]);

  return NextResponse.json({
    policies,
    project: {
      provider: ci?.provider ?? "github",
      repo: ci?.repo ?? "",
      connectionConfigured: ci?.connectionId != null,
    },
  });
}

export async function POST(req: Request, { params }: Params) {
  const { slug, appId } = await params;
  const access = await requireProjectMember(slug, "VIEWER");
  if ("error" in access) return access.error;
  const off = requireProjectMobileEnabled(access.project);
  if (off) return off;
  const canManage =
    access.role === "OWNER" || hasDevPrivileges(access.orgRole);
  if (!canManage) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const app = await loadApp(access.project.id, appId);
  if (!app) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = (await readJson(req)) as
    | { workflow?: string; branch?: string }
    | null;
  if (!body) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const ci = await loadProjectCiMeta(prisma, access.project.id);
  if (!ci?.connectionId || !ci.repo) {
    return NextResponse.json(
      { error: "Relie d'abord une connexion CI/CD et un repo au projet (Paramètres)." },
      { status: 400 },
    );
  }
  if (ci.provider === "bitbucket" && !ci.policyIssuer) {
    return NextResponse.json(
      { error: "Configure d'abord l'issuer Bitbucket du projet (Paramètres)." },
      { status: 400 },
    );
  }

  const provider = ci.provider;
  const repo = ci.repo;
  const policyIssuer = ci.policyIssuer;
  const workflow = String(body.workflow ?? "").trim();
  const branch = String(body.branch ?? "").trim();

  if (provider === "github") {
    if (!isValidWorkflowFile(workflow)) {
      return NextResponse.json(
        { error: "Workflow invalide (format `<nom>.yml` attendu)" },
        { status: 400 },
      );
    }
  } else if (!isValidCiEnvironmentName(workflow)) {
    return NextResponse.json({ error: "Environment CI invalide" }, { status: 400 });
  }
  if (!isValidGitBranch(branch)) {
    return NextResponse.json({ error: "Branche invalide" }, { status: 400 });
  }

  const conflict = await prisma.policy.findUnique({
    where: {
      provider_repo_workflow_branch_projectId_mobileAppId: {
        provider,
        repo,
        workflow,
        branch,
        projectId: access.project.id,
        mobileAppId: app.id,
      },
    },
    select: { id: true },
  });
  if (conflict) {
    return NextResponse.json(
      { error: "Une policy identique existe déjà pour cette application" },
      { status: 409 },
    );
  }

  const policy = await prisma.policy.create({
    data: {
      provider,
      issuer: policyIssuer,
      repo,
      workflow,
      branch,
      projectId: access.project.id,
      kind: "mobile",
      mobileAppId: app.id,
    },
    select: {
      id: true,
      provider: true,
      repo: true,
      workflow: true,
      branch: true,
      createdAt: true,
    },
  });

  logAction({
    action: "POLICY_CREATE",
    actor: { kind: "user", userId: access.user.id, email: access.user.email },
    organizationId: access.project.organizationId,
    projectId: access.project.id,
    targetType: "Policy",
    targetId: policy.id,
    metadata: { kind: "mobile", provider, repo, workflow, branch, appId: app.id },
    req,
  });

  return NextResponse.json({ policy }, { status: 201 });
}
