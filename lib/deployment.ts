// Chantier C-0051 (guide d'installation) — Phase 1 : suivi des déploiements.
// Cf. documentation/plans/guide-installation-projet.md §3.
//
// « Le déploiement a-t-il réussi ? » — jusqu'ici Physalis ne savait répondre
// qu'à « ai-je servi les secrets ? ». Ce module tient le registre, calqué sur
// lib/mobile-release.ts.
//
// Deux moments d'écriture, et c'est le point de conception :
//   1. `openDeployment` — QUAND LE BUNDLE EST SERVI. Écrit par Physalis à partir
//      de ce qu'il a réellement remis. Cette moitié-là ne peut pas mentir.
//   2. `recordDeploymentReport` — quand le pipeline rapporte son issue.
//      Déclarative par nature : Physalis ne sonde pas le site déployé.
// Mélanger les deux ferait passer du déclaratif pour du constaté.
//
// La jointure se fait sur l'identité du run tirée du jeton OIDC signé
// (`RunIdentity`, lib/oidc.ts), jamais sur un identifiant fourni dans le corps.
//
// Partagé par les routes SaaS et leurs jumeaux self-host : le client Prisma est
// passé en paramètre.

import type { RunIdentity } from "./oidc";

/** Typage structurel lâche — même motif et même notation MÉTHODE que
 *  `ReleaseDb` dans lib/mobile-release.ts (bivariance sous strictFunctionTypes). */
type DeploymentDb = {
  deployment: {
    findUnique(args: unknown): Promise<unknown>;
    findMany(args: unknown): Promise<unknown>;
    create(args: unknown): Promise<unknown>;
    update(args: unknown): Promise<unknown>;
    deleteMany(args: unknown): Promise<unknown>;
  };
  project: {
    updateMany(args: unknown): Promise<unknown>;
  };
};

/** Lignes gardées par environnement (arbitrage A4). */
export const DEPLOYMENT_RETENTION = 25;

/** Borne du détail libre rapporté par le CI — il finit dans une page HTML. */
export const MAX_DEPLOYMENT_DETAIL = 500;

/** États qu'un pipeline peut rapporter. `requested` est réservé à Physalis. */
export const DEPLOYMENT_REPORT_STATUSES = ["succeeded", "failed"] as const;
export type DeploymentReportStatus = (typeof DEPLOYMENT_REPORT_STATUSES)[number];

export function isValidReportStatus(v: string): v is DeploymentReportStatus {
  return (DEPLOYMENT_REPORT_STATUSES as readonly string[]).includes(v);
}

/** Paliers d'attente d'un déploiement sans rapport (arbitrage A6), en minutes. */
export const DEPLOYMENT_WAIT_TIERS = { long: 15, abnormal: 30, expired: 45 } as const;

export type DeploymentPhase =
  | "succeeded"
  | "failed"
  | "running"
  | "long"
  | "abnormal"
  | "expired";

/**
 * Phase AFFICHÉE d'un déploiement. Calculée, jamais écrite : un rapport qui
 * arrive après 45 min remplace « expiré », le timeout n'est pas un verdict.
 */
export function deploymentPhase(
  row: { status: string; authorizedAt: Date | null; createdAt: Date },
  now: Date = new Date(),
): DeploymentPhase {
  if (row.status === "succeeded") return "succeeded";
  if (row.status === "failed") return "failed";
  const since = row.authorizedAt ?? row.createdAt;
  const minutes = (now.getTime() - since.getTime()) / 60_000;
  if (minutes >= DEPLOYMENT_WAIT_TIERS.expired) return "expired";
  if (minutes >= DEPLOYMENT_WAIT_TIERS.abnormal) return "abnormal";
  if (minutes >= DEPLOYMENT_WAIT_TIERS.long) return "long";
  return "running";
}

/** Identité du pipeline (claims OIDC déjà vérifiés). */
export type DeploymentCi = {
  provider: string;
  repo: string;
  workflow: string;
  branch: string;
};

type Target = {
  projectId: string;
  environmentId: string;
  policyId: string | null;
  ci: DeploymentCi;
  run: RunIdentity;
};

type Row = { id: string; authorizedAt: Date | null; bundleServedCount: number };

function uniqueWhere(t: Target) {
  return {
    environmentId_provider_runId_runAttempt: {
      environmentId: t.environmentId,
      provider: t.ci.provider,
      runId: t.run.id,
      runAttempt: t.run.attempt,
    },
  };
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === "P2002";
}

/** Garde les `DEPLOYMENT_RETENTION` lignes les plus récentes de l'environnement. */
async function purge(db: DeploymentDb, environmentId: string): Promise<void> {
  const stale = (await db.deployment.findMany({
    where: { environmentId },
    orderBy: { createdAt: "desc" },
    skip: DEPLOYMENT_RETENTION,
    select: { id: true },
  })) as { id: string }[];
  if (stale.length === 0) return;
  await db.deployment.deleteMany({ where: { id: { in: stale.map((r) => r.id) } } });
}

/**
 * Ouvre (ou rejoint) la ligne du run au moment où le bundle est servi.
 *
 * Un même run peut prendre plusieurs bundles (`deploy.yml` : job build pour les
 * `VITE_*`, puis job deploy) : ils retombent sur la même ligne, dont le compteur
 * s'incrémente. `authorizedAt` garde le PREMIER service — c'est lui qui ancre
 * les paliers d'attente.
 *
 * ⚠️ NE LÈVE JAMAIS : le bundle est le chemin critique. Un pipeline ne doit pas
 * échouer parce que Physalis n'a pas su écrire une ligne d'historique — même
 * arbitrage que `openRelease` côté mobile.
 *
 * @returns l'id de la ligne, ou null si l'écriture a échoué.
 */
export async function openDeployment(db: DeploymentDb, t: Target): Promise<string | null> {
  try {
    const now = new Date();
    const join = async (row: Row) => {
      await db.deployment.update({
        where: { id: row.id },
        data: {
          bundleServedCount: { increment: 1 },
          ...(row.authorizedAt ? {} : { authorizedAt: now }),
        },
      });
      return row.id;
    };

    const existing = (await db.deployment.findUnique({
      where: uniqueWhere(t),
      select: { id: true, authorizedAt: true, bundleServedCount: true },
    })) as Row | null;
    if (existing) return await join(existing);

    let id: string;
    try {
      const created = (await db.deployment.create({
        data: {
          projectId: t.projectId,
          environmentId: t.environmentId,
          policyId: t.policyId,
          provider: t.ci.provider,
          repo: t.ci.repo,
          workflow: t.ci.workflow,
          branch: t.ci.branch,
          runId: t.run.id,
          runAttempt: t.run.attempt,
          sha: t.run.sha,
          status: "requested",
          bundleServedCount: 1,
          authorizedAt: now,
        },
        select: { id: true },
      })) as { id: string };
      id = created.id;
    } catch (err) {
      // Deux jobs du même run en parallèle : l'autre a créé la ligne entre
      // notre lecture et notre écriture. On la rejoint.
      if (!isUniqueViolation(err)) throw err;
      const raced = (await db.deployment.findUnique({
        where: uniqueWhere(t),
        select: { id: true, authorizedAt: true, bundleServedCount: true },
      })) as Row | null;
      if (!raced) throw err;
      return await join(raced);
    }
    await purge(db, t.environmentId);
    return id;
  } catch (err) {
    console.error("[deployment] openDeployment a échoué (non bloquant):", err);
    return null;
  }
}

export type DeploymentReportOutcome = {
  deploymentId: string;
  /** true si Physalis a servi au moins un bundle à ce run. false = déploiement
   *  fait sous une identité de pipeline valide SANS prendre ses secrets dans le
   *  coffre : l'interface le signale. */
  correlated: boolean;
};

/**
 * Enregistre l'issue que le pipeline rapporte. Un second rapport sur la même
 * ligne remplace le premier (relance d'un job seul) : le dernier gagne.
 *
 * Au premier `succeeded` corrélé du projet, pose `Project.setupCompletedAt` — c'est le
 * signal qui ferme l'onglet « Installation » (arbitrage A1).
 *
 * Contrairement à `openDeployment`, celle-ci LÈVE : c'est le seul travail de la
 * route de rapport, un échec silencieux y serait un mensonge.
 */
export async function recordDeploymentReport(
  db: DeploymentDb,
  t: Target & { status: DeploymentReportStatus; detail: string | null },
): Promise<DeploymentReportOutcome> {
  const now = new Date();
  const detail = t.detail ? t.detail.slice(0, MAX_DEPLOYMENT_DETAIL) : null;
  const report = { status: t.status, statusSource: "reported", detail, reportedAt: now };

  const existing = (await db.deployment.findUnique({
    where: uniqueWhere(t),
    select: { id: true, authorizedAt: true, bundleServedCount: true },
  })) as Row | null;

  let outcome: DeploymentReportOutcome;
  if (existing) {
    await db.deployment.update({ where: { id: existing.id }, data: report });
    outcome = { deploymentId: existing.id, correlated: existing.bundleServedCount > 0 };
  } else {
    // Rien à rejoindre : un déploiement dont Physalis n'a pas servi le bundle.
    // On l'enregistre quand même — un historique qui tait ce qu'il n'a pas
    // orchestré serait trompeur — avec un compteur à 0, donc non corrélé.
    const created = (await db.deployment.create({
      data: {
        projectId: t.projectId,
        environmentId: t.environmentId,
        policyId: t.policyId,
        provider: t.ci.provider,
        repo: t.ci.repo,
        workflow: t.ci.workflow,
        branch: t.ci.branch,
        runId: t.run.id,
        runAttempt: t.run.attempt,
        sha: t.run.sha,
        bundleServedCount: 0,
        ...report,
      },
      select: { id: true },
    })) as { id: string };
    await purge(db, t.environmentId);
    outcome = { deploymentId: created.id, correlated: false };
  }

  // Seul un succès CORRÉLÉ ferme le guide : il prouve que toute la chaîne
  // Physalis (policy, OIDC, bundle) a servi. Un rapport sans bundle servi dit
  // seulement que le pipeline sait appeler la route de rapport.
  if (t.status === "succeeded" && outcome.correlated) {
    // Idempotent : ne touche que la première fois.
    await db.project.updateMany({
      where: { id: t.projectId, setupCompletedAt: null },
      data: { setupCompletedAt: now },
    });
  }
  return outcome;
}

// ─── Issue constatée chez la plateforme ──────────────────────────────────────
// Sans étape de rapport dans le workflow, une ligne resterait « en cours » pour
// toujours. Physalis lit donc lui-même l'issue du run (identifiant tiré du jeton
// OIDC signé) quand la ligne attend depuis un moment.

/** On laisse au pipeline le temps de rapporter lui-même avant d'aller lire. */
export const SETTLE_AFTER_MS = 60_000;
/** Au-delà, on ne relit plus : le run est ancien, son issue ne bougera plus
 *  et la plateforme peut avoir purgé ses journaux. */
export const SETTLE_MAX_AGE_MS = 7 * 24 * 3_600_000;
/** Lectures par appel, pour borner le coût d'un affichage. */
export const SETTLE_MAX_ROWS = 10;

export type PlatformOutcome = "running" | "success" | "failure" | "unknown";

type PendingRow = {
  id: string;
  projectId: string;
  provider: string;
  repo: string;
  runId: string;
  runAttempt: string;
  bundleServedCount: number;
  authorizedAt: Date | null;
  createdAt: Date;
};

/**
 * Règle les lignes en attente dont la plateforme connaît l'issue. Ne lève pas :
 * une plateforme injoignable laisse simplement la ligne en attente.
 *
 * @param readOutcome lecture du run chez la plateforme (injectée : testable).
 * @returns le nombre de lignes réglées.
 */
export async function settleFromPlatform(
  db: DeploymentDb,
  rows: PendingRow[],
  readOutcome: (row: PendingRow) => Promise<PlatformOutcome>,
  now: Date = new Date(),
): Promise<number> {
  let settled = 0;
  for (const row of rows.slice(0, SETTLE_MAX_ROWS)) {
    const since = (row.authorizedAt ?? row.createdAt).getTime();
    const age = now.getTime() - since;
    if (age < SETTLE_AFTER_MS || age > SETTLE_MAX_AGE_MS) continue;
    let outcome: PlatformOutcome;
    try {
      outcome = await readOutcome(row);
    } catch {
      continue;
    }
    if (outcome !== "success" && outcome !== "failure") continue;
    try {
      await db.deployment.update({
        where: { id: row.id },
        data: {
          status: outcome === "success" ? "succeeded" : "failed",
          statusSource: "platform",
          reportedAt: now,
        },
      });
      // Même règle que le rapport : seul un succès CORRÉLÉ ferme le guide. Ici
      // la ligne a toujours été ouverte par un bundle servi, mais on le vérifie.
      if (outcome === "success" && row.bundleServedCount > 0) {
        await db.project.updateMany({
          where: { id: row.projectId, setupCompletedAt: null },
          data: { setupCompletedAt: now },
        });
      }
      settled++;
    } catch (err) {
      console.error("[deployment] règlement depuis la plateforme échoué:", err);
    }
  }
  return settled;
}

// ─── Lecture (interface) ─────────────────────────────────────────────────────

const GITHUB_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const GITLAB_PATH = /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)+$/;
const NUMERIC = /^\d{1,20}$/;

/**
 * Lien vers le run sur la plateforme, RECONSTRUIT ici à partir de valeurs
 * contrôlées — on n'affiche jamais une URL fournie par un pipeline, qui
 * deviendrait un lien arbitraire dans l'interface d'un coffre.
 *
 * Bitbucket : null. Son jeton ne porte que des UUID (dépôt, pipeline), et
 * l'URL web d'un pipeline exige le slug du workspace, du dépôt et le numéro
 * de build — qu'on ne connaît pas.
 *
 * @param issuer issuer de la connexion CI (GitLab self-hosted) ; null = défaut.
 */
export function deploymentRunUrl(
  row: { provider: string; repo: string; runId: string; runAttempt: string },
  issuer: string | null,
): string | null {
  if (!NUMERIC.test(row.runId)) return null;
  if (row.provider === "github") {
    if (!GITHUB_REPO.test(row.repo)) return null;
    const base = `https://github.com/${row.repo}/actions/runs/${row.runId}`;
    return NUMERIC.test(row.runAttempt) && row.runAttempt !== "1"
      ? `${base}/attempts/${row.runAttempt}`
      : base;
  }
  if (row.provider === "gitlab") {
    if (!GITLAB_PATH.test(row.repo)) return null;
    let origin = "https://gitlab.com";
    if (issuer) {
      try {
        const u = new URL(issuer);
        if (u.protocol !== "https:") return null;
        origin = u.origin;
      } catch {
        return null;
      }
    }
    return `${origin}/${row.repo}/-/pipelines/${row.runId}`;
  }
  return null;
}

/** Ce que l'interface reçoit d'une ligne : jamais plus que ce qui s'affiche. */
export type DeploymentView = {
  id: string;
  phase: DeploymentPhase;
  /** false = rapport reçu pour un run auquel Physalis n'a servi aucun bundle. */
  correlated: boolean;
  /** "reported" (déclaré par le pipeline) | "platform" (lu chez la plateforme). */
  statusSource: string | null;
  provider: string;
  branch: string;
  workflow: string;
  sha: string | null;
  runUrl: string | null;
  detail: string | null;
  authorizedAt: string | null;
  reportedAt: string | null;
  createdAt: string;
};

export const DEPLOYMENT_VIEW_SELECT = {
  id: true,
  status: true,
  statusSource: true,
  bundleServedCount: true,
  provider: true,
  repo: true,
  workflow: true,
  branch: true,
  runId: true,
  runAttempt: true,
  sha: true,
  detail: true,
  authorizedAt: true,
  reportedAt: true,
  createdAt: true,
} as const;

export function toDeploymentView(
  row: {
    id: string;
    status: string;
    statusSource: string | null;
    bundleServedCount: number;
    provider: string;
    repo: string;
    workflow: string;
    branch: string;
    runId: string;
    runAttempt: string;
    sha: string | null;
    detail: string | null;
    authorizedAt: Date | null;
    reportedAt: Date | null;
    createdAt: Date;
  },
  issuer: string | null,
  now: Date = new Date(),
): DeploymentView {
  return {
    id: row.id,
    phase: deploymentPhase(row, now),
    correlated: row.bundleServedCount > 0,
    statusSource: row.statusSource,
    provider: row.provider,
    branch: row.branch,
    workflow: row.workflow,
    sha: row.sha,
    runUrl: deploymentRunUrl(row, issuer),
    detail: row.detail,
    authorizedAt: row.authorizedAt?.toISOString() ?? null,
    reportedAt: row.reportedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}
