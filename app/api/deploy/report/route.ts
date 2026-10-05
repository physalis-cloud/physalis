// Jumeau self-host de app/api/deploy/report/route.ts — le pipeline rapporte
// l'issue de son déploiement (C-0051, suivi des déploiements).
//
// Mono-tenant : pas d'`admin.policies` à interroger, pas de gate de plan. La
// résolution passe par la table `Policy` locale (lib/server-policy overlay) et
// le suivi s'écrit sur le client unique. GitHub uniquement, comme le jumeau de
// /api/deploy.
//
// ⚠️ Même frontière `kind` que partout : une policy mobile ne rapporte pas un
// déploiement serveur.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { logAction } from "@/lib/audit";
import { rateLimit } from "@/lib/rate-limit";
import { extractBearer, verifyGithubOidcToken } from "@/lib/oidc";
import { readJson } from "@/lib/api";
import { resolveServerPolicy } from "@/lib/server-policy";
import { isValidReportStatus, recordDeploymentReport } from "@/lib/deployment";

export const runtime = "nodejs";

const RATE_LIMIT = { max: 60, windowMs: 60_000 };

export async function POST(req: Request) {
  const limited = rateLimit(req, "deploy-report", RATE_LIMIT);
  if (limited) return limited;

  const token = extractBearer(req);
  const verified = await verifyGithubOidcToken(token);
  if (!verified.ok) {
    if (
      verified.reason === "missing_token" ||
      verified.reason === "wrong_audience" ||
      verified.reason === "wrong_issuer"
    ) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    logAction({
      action: "DEPLOY_DENIED",
      actor: { kind: "anonymous" },
      metadata: { reason: verified.reason, surface: "report" },
      req,
    });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { repository, workflowFile, branch, run } = verified.claims;

  const body = (await readJson(req)) as {
    project?: string;
    environment?: string;
    status?: string;
    detail?: string;
  } | null;
  const projectSlug = String(body?.project ?? "").trim();
  const envName = String(body?.environment ?? "").trim().toLowerCase();
  const status = String(body?.status ?? "").trim();

  if (!projectSlug || !envName || !status) {
    return NextResponse.json(
      { error: "project, environment and status are required" },
      { status: 400 },
    );
  }
  if (!isValidReportStatus(status)) {
    return NextResponse.json({ error: "Invalid status" }, { status: 400 });
  }
  if (!run) {
    return NextResponse.json(
      { error: "OIDC token carries no run identity" },
      { status: 422 },
    );
  }

  const match = await resolveServerPolicy(
    { provider: "github", repo: repository, workflow: workflowFile, branch, issuer: null },
    projectSlug,
    envName,
  );
  if (!match) {
    logAction({
      action: "DEPLOY_DENIED",
      actor: { kind: "anonymous" },
      metadata: {
        reason: "policy_not_found",
        surface: "report",
        repository,
        workflow: workflowFile,
        branch,
        project: projectSlug,
        environment: envName,
      },
      req,
    });
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { policyId, project, environment } = match;
  const detail = (body?.detail ?? "").trim() || null;

  let outcome;
  try {
    outcome = await recordDeploymentReport(prisma, {
      projectId: project.id,
      environmentId: environment.id,
      policyId,
      ci: { provider: "github", repo: repository, workflow: workflowFile, branch },
      run,
      status,
      detail,
    });
  } catch (err) {
    console.error("[deploy-report] écriture du suivi échouée:", err);
    return NextResponse.json({ error: "Could not record deployment" }, { status: 500 });
  }

  logAction({
    action: "DEPLOY_REPORTED",
    actor: { kind: "anonymous" },
    organizationId: project.organizationId,
    projectId: project.id,
    environmentId: environment.id,
    targetType: "Deployment",
    targetId: outcome.deploymentId,
    metadata: {
      status,
      correlated: outcome.correlated,
      repository,
      workflow: workflowFile,
      branch,
      runId: run.id,
      runAttempt: run.attempt,
    },
    req,
  });

  return NextResponse.json({
    deploymentId: outcome.deploymentId,
    correlated: outcome.correlated,
  });
}
