// Chantier C-0051 (guide d'installation) — Phase 4 bis : vérification d'un
// projet ANTÉRIEUR au guide (arbitrage A2). Cf. plan §4.6.
//
// Question : ce projet est-il déjà déployé via Physalis, et son workflow
// enverra-t-il le rapport qui fermera le guide ? Lancée à la demande (elle
// interroge l'API de la plateforme), son résultat n'est JAMAIS stocké — une
// case « vérifié » finirait fausse comme les autres. Elle a en revanche un
// effet : elle RETIRE `setupLegacy` (retour utilisateur du 2026-10-03). Une fois
// classé, le projet suit le guide normal, dont les étapes disent ce qui manque ;
// relancer la vérification n'apprendrait rien de plus.
//
//   V1  configuration Physalis complète (connexion, dépôt, serveur, policy)
//   V2  un bundle a déjà été servi (audit DEPLOY_AUTHORIZED, dans la limite de
//       la rétention de l'audit — d'où `auditSince`)
//   V3  le workflow déclaré par la policy existe dans le dépôt
//   V4  il contient l'étape de rapport
//   V5  un rapport a déjà été reçu (→ setupCompletedAt)

import { prisma } from "./prisma";
import { computeSetupState } from "./project-setup";
import { readRepoFile, type RepoFileRead } from "./project-docs";
import {
  loadTemplateSource,
  policyWorkflowPath,
  type TemplateId,
} from "./workflow-templates";

export type CheckStatus = "ok" | "ko" | "unknown";

export type VerifyOutcome =
  /** V1→V4 : déployé via Physalis, le prochain run fermera le guide. */
  | "ready"
  /** Déployé via Physalis, mais le workflow n'envoie pas de rapport. */
  | "noReport"
  /** Configuration (partielle ou complète) mais aucun bundle servi. */
  | "neverDeployed"
  /** Déjà servi par le passé, mais la configuration est incomplète AUJOURD'HUI
   *  (serveur délié, policy supprimée…) : le prochain run échouerait. */
  | "configIncomplete"
  /** Rien de relié : pas de connexion ou pas de dépôt. */
  | "notLinked"
  /** Déjà terminé (V5). */
  | "completed";

export type VerifyResult = {
  outcome: VerifyOutcome;
  checks: {
    config: CheckStatus;
    deployed: CheckStatus;
    workflowFile: CheckStatus;
    reportStep: CheckStatus;
    reported: CheckStatus;
  };
  lastAuthorizedAt: string | null;
  /** Plus ancienne entrée d'audit conservée : au-delà, V2 ne voit rien. */
  auditSince: string | null;
  /** Fichier lu pour V3/V4 (chemin + branche), si une policy le désigne. */
  file: { path: string; branch: string; httpStatus: number } | null;
  /** Étape de rapport à ajouter (noReport, ou ready sans lecture du workflow). */
  snippet: string | null;
};

const REPORT_MARKER = "/api/deploy/report";

/**
 * Extrait l'étape de rapport du modèle PUBLIÉ — jamais une copie maintenue à
 * part, qui finirait par diverger du modèle. Bornes : le commentaire
 * « Rapport à Physalis » jusqu'à la fin de l'étape (fin de fichier pour
 * GitHub/GitLab, `pipelines:` pour Bitbucket).
 */
export function extractReportSnippet(id: TemplateId, source: string): string | null {
  const start = source.lastIndexOf("# ── Rapport à Physalis");
  if (start === -1) return null;
  const lineStart = source.lastIndexOf("\n", start) + 1;
  const end = id === "bitbucket" ? source.indexOf("\npipelines:", start) : source.length;
  if (end === -1) return null;
  const snippet = source.slice(lineStart, end).replace(/\s+$/, "") + "\n";
  return snippet.includes(REPORT_MARKER) ? snippet : null;
}

async function reportSnippet(provider: string): Promise<string | null> {
  // GitHub : l'étape du job de déploiement (`if: always()`), dernière du
  // modèle de redéploiement — la même que celle du job `deploy`.
  const id: TemplateId =
    provider === "gitlab" ? "gitlab" : provider === "bitbucket" ? "bitbucket" : "redeploy";
  try {
    return extractReportSnippet(id, await loadTemplateSource(id));
  } catch {
    return null;
  }
}

export async function verifyLegacyProject(projectId: string): Promise<VerifyResult | null> {
  const state = await computeSetupState(prisma, projectId);
  if (!state) return null;

  const step = (id: string) => state.steps.find((s) => s.id === id)?.status;
  const linked = step("connection") === "done" && step("repo") === "done";
  const configOk =
    linked && step("server") === "done" && step("policy") === "done";

  const [lastAuthorized, oldestAudit] = await Promise.all([
    prisma.accessLog.findFirst({
      where: { projectId, action: "DEPLOY_AUTHORIZED" },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    }),
    prisma.accessLog.findFirst({ orderBy: { createdAt: "asc" }, select: { createdAt: true } }),
  ]);
  const deployed = lastAuthorized !== null;

  // V3/V4 sur la première policy qui mène à un serveur (sinon la première).
  const policy =
    state.policies.find((p) => state.deployableEnvs.includes(p.environment)) ??
    state.policies[0] ??
    null;
  let read: RepoFileRead | null = null;
  let file: VerifyResult["file"] = null;
  if (linked && policy) {
    const path = policyWorkflowPath(state.provider, policy.workflow);
    read = await readRepoFile(projectId, path, policy.branch);
    file = { path, branch: policy.branch, httpStatus: read.httpStatus };
  }
  const workflowFile: CheckStatus = !read
    ? "unknown"
    : read.status === "found"
      ? "ok"
      : read.status === "absent"
        ? "ko"
        : "unknown";
  const reportStep: CheckStatus =
    read?.status === "found" ? (read.content?.includes(REPORT_MARKER) ? "ok" : "ko") : "unknown";

  const checks = {
    config: configOk ? ("ok" as const) : ("ko" as const),
    deployed: deployed ? ("ok" as const) : ("ko" as const),
    workflowFile,
    reportStep,
    reported: state.completedAt ? ("ok" as const) : ("ko" as const),
  };

  let outcome: VerifyOutcome;
  if (state.completedAt) outcome = "completed";
  else if (!linked) outcome = "notLinked";
  else if (!deployed) outcome = "neverDeployed";
  else if (!configOk) outcome = "configIncomplete";
  // Sans lecture possible du dépôt (V3/V4 inconnus), V2 seul tranche : on ne
  // réclame pas d'étape qu'on n'a pas pu constater absente.
  else if (reportStep === "ko") outcome = "noReport";
  else outcome = "ready";

  await prisma.project.update({ where: { id: projectId }, data: { setupLegacy: false } });

  return {
    outcome,
    checks,
    lastAuthorizedAt: lastAuthorized?.createdAt.toISOString() ?? null,
    auditSince: oldestAudit?.createdAt.toISOString() ?? null,
    file,
    // Aussi quand le workflow n'a pas pu être lu : on ne sait pas s'il a
    // l'étape, autant fournir de quoi l'ajouter.
    snippet:
      outcome === "noReport" || (outcome === "ready" && reportStep === "unknown")
        ? await reportSnippet(state.provider)
        : null,
  };
}
