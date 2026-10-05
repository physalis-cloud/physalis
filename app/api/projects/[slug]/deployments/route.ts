// GET /api/projects/[slug]/deployments — dernier déploiement de chaque
// environnement du projet (C-0051, Phase 3) : alimente la pastille d'état sur
// les onglets d'environnement. Cf. lib/deployment.ts.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireProjectMember } from "@/lib/api";
import { DEPLOYMENT_VIEW_SELECT, toDeploymentView } from "@/lib/deployment";
import { settlePendingDeployments } from "@/lib/deployment-settle";

type Params = { params: Promise<{ slug: string }> };

export async function GET(_req: Request, { params }: Params) {
  const { slug } = await params;
  const access = await requireProjectMember(slug, "VIEWER");
  if ("error" in access) return access.error;

  await settlePendingDeployments(access.project.id);

  const project = await prisma.project.findUnique({
    where: { id: access.project.id },
    select: {
      ciConnection: { select: { issuer: true } },
      environments: {
        select: {
          name: true,
          deployments: {
            orderBy: { createdAt: "desc" },
            take: 1,
            select: DEPLOYMENT_VIEW_SELECT,
          },
        },
      },
    },
  });
  const issuer = project?.ciConnection?.issuer ?? null;
  const now = new Date();

  const latest: Record<string, ReturnType<typeof toDeploymentView>> = {};
  for (const env of project?.environments ?? []) {
    const row = env.deployments[0];
    if (row) latest[env.name] = toDeploymentView(row, issuer, now);
  }
  return NextResponse.json({ latest });
}
