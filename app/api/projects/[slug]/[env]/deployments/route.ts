// GET /api/projects/[slug]/[env]/deployments — historique des déploiements
// d'un environnement (C-0051, Phase 3). Cf. lib/deployment.ts.
//
// Lecture ouverte au VIEWER, comme le reste de l'environnement, et sans gate de
// plan (convention gating-plans : un client rétrogradé garde la lecture de ce
// qu'il a produit). Rien de secret ici : identité du pipeline et issue.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireEnvironment } from "@/lib/api";
import { settlePendingDeployments } from "@/lib/deployment-settle";
import { CI_SECRET_KIND } from "@/lib/ci-connection";
import {
  DEPLOYMENT_RETENTION,
  DEPLOYMENT_VIEW_SELECT,
  toDeploymentView,
} from "@/lib/deployment";

type Params = { params: Promise<{ slug: string; env: string }> };

export async function GET(_req: Request, { params }: Params) {
  const { slug, env } = await params;
  const access = await requireEnvironment(slug, env, "VIEWER");
  if ("error" in access) return access.error;

  // Les lignes en attente sont d'abord réglées auprès de la plateforme (issue
  // du run), pour que l'historique ne dépende pas de l'étape de rapport.
  await settlePendingDeployments(access.project.id, access.environment.id);

  const [rows, project] = await Promise.all([
    prisma.deployment.findMany({
      where: { environmentId: access.environment.id },
      orderBy: { createdAt: "desc" },
      take: DEPLOYMENT_RETENTION,
      select: DEPLOYMENT_VIEW_SELECT,
    }),
    prisma.project.findUnique({
      where: { id: access.project.id },
      select: { ciConnection: { select: { issuer: true } } },
    }),
  ]);
  const issuer = project?.ciConnection?.issuer ?? null;
  const now = new Date();

  // La relance exige un jeton sur la connexion : on le dit à l'interface, sans
  // jamais exposer le jeton (on ne lit que la PRÉSENCE du secret).
  const hasToken =
    (await prisma.ciConnectionSecret.count({
      where: { connection: { projects: { some: { id: access.project.id } } }, kind: CI_SECRET_KIND.redeployToken },
    })) > 0;

  return NextResponse.json({
    deployments: rows.map((r) => toDeploymentView(r, issuer, now)),
    canRerun: hasToken,
  });
}
