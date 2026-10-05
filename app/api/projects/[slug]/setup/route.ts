// GET /api/projects/[slug]/setup — état de l'onglet « Installation » (C-0051,
// Phase 4). Toutes les étapes sont recalculées depuis l'état réel, cf.
// lib/project-setup.ts. Lecture VIEWER : un lecteur voit les étapes, il ne
// peut simplement pas agir dessus.
//
// L'existence du dépôt (et du dépôt par défaut) est vérifiée ici auprès de la
// plateforme — avec cache, cf. checkRepoExists.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireProjectMember } from "@/lib/api";
import { computeSetupState, type SetupChecks } from "@/lib/project-setup";
import { checkRepoExists, checkWorkflowFile, latestWorkflowRun } from "@/lib/project-docs";
import { policyWorkflowPath } from "@/lib/workflow-templates";
import { connectionRegistryOwner, defaultGithubRepo } from "@/lib/repo-default";
import { effectiveRepo } from "@/lib/ci-provider";
import { settlePendingDeployments } from "@/lib/deployment-settle";

type Params = { params: Promise<{ slug: string }> };

export async function GET(_req: Request, { params }: Params) {
  const { slug } = await params;
  const access = await requireProjectMember(slug, "VIEWER");
  if ("error" in access) return access.error;

  const p = await prisma.project.findUnique({
    where: { id: access.project.id },
    select: {
      slug: true,
      organizationId: true,
      githubRepo: true,
      ciRepo: true,
      ciConnection: { select: { id: true, provider: true } },
      policies: {
        where: { kind: "server" },
        select: { id: true, workflow: true, branch: true },
        take: 10,
      },
    },
  });
  if (!p) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const checks: SetupChecks = {};
  const provider = p.ciConnection?.provider ?? "github";
  if (effectiveRepo(provider, p.githubRepo, p.ciRepo)) {
    checks.repoExists = await checkRepoExists(access.project.id);
  } else if (p.ciConnection && provider === "github") {
    const owner = await connectionRegistryOwner(prisma, p.ciConnection.id, p.organizationId);
    const repo = defaultGithubRepo(owner, p.slug);
    if (repo) checks.defaultRepo = { repo, exists: await checkRepoExists(access.project.id, repo) };
  }

  // Le workflow désigné par chaque policy, lu sur la branche de la policy. Pas de
  // dépôt (ou dépôt introuvable) → rien à lire.
  if (checks.repoExists && checks.repoExists !== "no" && p.policies.length > 0) {
    const entries = await Promise.all(
      p.policies.map(async (pol) => {
        const [file, run] = await Promise.all([
          checkWorkflowFile(access.project.id, policyWorkflowPath(provider, pol.workflow), pol.branch),
          // GitHub : le run se cherche par fichier de workflow ; GitLab/Bitbucket :
          // par branche (un seul fichier de pipeline).
          latestWorkflowRun(access.project.id, pol.workflow, pol.branch),
        ]);
        return { id: pol.id, file, run };
      }),
    );
    checks.workflowFiles = Object.fromEntries(entries.map((e) => [e.id, e.file]));
    checks.lastRuns = Object.fromEntries(entries.map((e) => [e.id, e.run]));
  }

  // Règle d'abord les déploiements en attente auprès de la plateforme : c'est
  // ce qui ferme le guide sans étape de rapport dans le workflow.
  await settlePendingDeployments(access.project.id);

  const state = await computeSetupState(prisma, access.project.id, checks);
  if (!state) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(state);
}
