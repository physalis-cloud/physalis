// POST /api/projects/[slug]/[env]/deployments/[id]/rerun — relance le run d'une
// ligne de suivi des déploiements (C-0051). Cf. rerunDeployment (lib/redeploy).
//
// Mêmes garde-fous que le bouton « Redeploy » : EDITOR+, plan `ci_cd`, jeton de
// la connexion CI qui ne quitte jamais le serveur, audit REDEPLOY_TRIGGERED.
// Le nouveau run apparaîtra comme une NOUVELLE ligne dès qu'il appellera
// /api/deploy (GitHub : même run_id, run_attempt + 1).

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireEnvironment } from "@/lib/api";
import { loadProjectCiSecrets } from "@/lib/ci-connection";
import { isCiProvider } from "@/lib/ci-provider";
import { deploymentPhase } from "@/lib/deployment";
import { rerunDeployment } from "@/lib/redeploy";
import { logAction } from "@/lib/audit";

type Params = { params: Promise<{ slug: string; env: string; id: string }> };

export async function POST(req: Request, { params }: Params) {
  const { slug, env, id } = await params;
  const access = await requireEnvironment(slug, env, "EDITOR", { feature: "ci_cd" });
  if ("error" in access) return access.error;

  const row = await prisma.deployment.findFirst({
    where: { id, environmentId: access.environment.id },
    select: {
      id: true,
      provider: true,
      repo: true,
      runId: true,
      runAttempt: true,
      branch: true,
      status: true,
      authorizedAt: true,
      createdAt: true,
    },
  });
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Un run encore en cours ne se relance pas : on attendrait deux runs
  // concurrents sur le même environnement.
  const phase = deploymentPhase(row);
  if (phase === "running" || phase === "long" || phase === "abnormal") {
    return NextResponse.json({ error: "Ce déploiement est encore en cours." }, { status: 409 });
  }

  const project = await prisma.project.findUnique({
    where: { id: access.project.id },
    select: { organizationId: true, ciConnection: { select: { provider: true, issuer: true } } },
  });
  const provider = project?.ciConnection?.provider ?? "github";
  // Le jeton de la connexion actuelle ne vaut que pour SON fournisseur.
  if (!isCiProvider(provider) || provider !== row.provider) {
    return NextResponse.json(
      { error: "La connexion CI/CD du projet ne correspond plus à ce run." },
      { status: 409 },
    );
  }
  const { redeployToken, apiIdentity } = await loadProjectCiSecrets(prisma, access.project.id);
  if (!redeployToken) {
    return NextResponse.json(
      {
        error:
          "Aucun token configuré sur la connexion CI/CD de l'organisation (onglet CI/CD) : impossible de relancer.",
      },
      { status: 400 },
    );
  }

  let result;
  try {
    result = await rerunDeployment({
      provider,
      repo: row.repo,
      runId: row.runId,
      branch: row.branch,
      status: row.status,
      envName: access.environment.name,
      token: redeployToken,
      issuer: project?.ciConnection?.issuer ?? null,
      identity: apiIdentity,
    });
  } catch (e) {
    result = {
      ok: false as const,
      httpStatus: 0,
      error: e instanceof Error ? e.message : "Erreur réseau",
      mode: "rerun" as const,
    };
  }

  logAction({
    action: "REDEPLOY_TRIGGERED",
    actor: { kind: "user", userId: access.user.id, email: access.user.email },
    organizationId: project?.organizationId,
    projectId: access.project.id,
    environmentId: access.environment.id,
    targetType: "Deployment",
    targetId: row.id,
    metadata: {
      provider,
      repo: row.repo,
      environment: access.environment.name,
      ref: row.branch,
      rerunOf: row.runId,
      runAttempt: row.runAttempt,
      mode: result.mode,
      status: result.ok ? "success" : "failed",
      ...(result.ok ? {} : { httpStatus: result.httpStatus, providerError: result.error?.slice(0, 500) }),
    },
    req,
  });

  if (!result.ok) {
    return NextResponse.json(
      {
        error: `La plateforme a refusé la relance (HTTP ${result.httpStatus})`,
        details: providerMessage(result.error),
      },
      { status: 502 },
    );
  }
  return NextResponse.json({ ok: true, mode: result.mode });
}

/** Les plateformes répondent en JSON (`{"message": …}`) : on n'en garde que le
 *  texte, plus lisible dans l'interface ; à défaut, le corps brut tronqué. */
function providerMessage(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const j = JSON.parse(raw) as { message?: unknown; error?: { message?: unknown } };
    const m = typeof j.message === "string" ? j.message : j.error?.message;
    if (typeof m === "string" && m) return m.slice(0, 300);
  } catch {
    // corps non JSON
  }
  return raw.slice(0, 300);
}
