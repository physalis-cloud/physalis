// Chantier C-0051 — branche `settleFromPlatform` (lib/deployment.ts) sur la
// lecture réelle des runs (lib/project-docs.ts). Appelé par les lectures du
// suivi (historique, pastilles, guide) : l'issue se met à jour à l'affichage,
// sans cron et sans étape de rapport dans le workflow.

import { prisma } from "./prisma";
import { fetchRunOutcome } from "./project-docs";
import { SETTLE_MAX_AGE_MS, SETTLE_MAX_ROWS, settleFromPlatform } from "./deployment";

export async function settlePendingDeployments(
  projectId: string,
  environmentId?: string,
): Promise<number> {
  const rows = await prisma.deployment.findMany({
    where: {
      projectId,
      ...(environmentId ? { environmentId } : {}),
      status: "requested",
      createdAt: { gte: new Date(Date.now() - SETTLE_MAX_AGE_MS) },
    },
    orderBy: { createdAt: "desc" },
    take: SETTLE_MAX_ROWS,
    select: {
      id: true,
      projectId: true,
      provider: true,
      repo: true,
      runId: true,
      runAttempt: true,
      bundleServedCount: true,
      authorizedAt: true,
      createdAt: true,
    },
  });
  if (rows.length === 0) return 0;
  return settleFromPlatform(prisma, rows, (r) =>
    fetchRunOutcome(projectId, r.provider, r.repo, r.runId, r.runAttempt),
  );
}
