// Chantier C-0051 (guide d'installation) — Phase 4 : état de l'onglet
// « Installation ». Cf. documentation/plans/guide-installation-projet.md §4.
//
// L'avancement n'est JAMAIS stocké : chaque étape est un test sur l'état réel
// du projet, recalculé à chaque lecture. Une case cochée en base finit toujours
// par mentir (connexion révoquée, serveur supprimé, policy effacée…).
//
// Seuls trois champs sont stockés sur `Project`, et aucun ne décrit une étape :
//   - setupCompletedAt : premier rapport `succeeded` corrélé (lib/deployment.ts) ;
//   - setupGuide       : choix d'affichage de l'utilisateur (null | shown | hidden) ;
//   - setupLegacy      : projet antérieur au guide (posé par la migration,
//                        retiré par la vérification — lib/project-verify.ts).
//
// Partagé SaaS / self-host : le client Prisma est passé en paramètre.

export const SETUP_GUIDE_VALUES = ["shown", "hidden"] as const;
export type SetupGuideChoice = (typeof SETUP_GUIDE_VALUES)[number];

export function isValidSetupGuide(v: unknown): v is SetupGuideChoice | null {
  return v === null || (SETUP_GUIDE_VALUES as readonly unknown[]).includes(v);
}

/**
 * Règle d'affichage de l'onglet (§4.1) :
 *   shown  → visible, même installé (l'utilisateur a voulu le revoir) ;
 *   hidden → masqué ;
 *   null   → visible tant qu'aucun déploiement corrélé n'a réussi.
 */
export function isSetupTabVisible(p: {
  setupGuide: string | null;
  setupCompletedAt: Date | string | null;
}): boolean {
  if (p.setupGuide === "shown") return true;
  if (p.setupGuide === "hidden") return false;
  return p.setupCompletedAt === null;
}

export type SetupStepId =
  | "connection"
  | "repo"
  | "server"
  | "secrets"
  | "policy"
  | "workflow"
  | "firstCall"
  | "firstSuccess";

/**
 * done     : constaté dans l'état réel ;
 * todo     : à faire ;
 * optional : conseillé, ne bloque pas (secrets) ;
 * manual   : Physalis ne peut pas le constater lui-même (fichier dans le dépôt —
 *            la détection arrive en Phase 5) ; l'étape suivante tranchera.
 */
export type SetupStepStatus = "done" | "todo" | "optional" | "manual";

export type SetupStep = { id: SetupStepId; status: SetupStepStatus };

export type SetupState = {
  provider: string;
  legacy: boolean;
  completedAt: string | null;
  guide: SetupGuideChoice | null;
  steps: SetupStep[];
  /** Ce que l'utilisateur doit retrouver À L'IDENTIQUE dans son workflow. */
  repo: string | null;
  policies: {
    id: string;
    workflow: string;
    branch: string;
    environment: string;
    /** Le fichier désigné par la policy, lu sur SA branche (null = non testé). */
    file: { status: "found" | "absent" | "unreadable"; hasReport: boolean | null } | null;
    /** Dernier run de ce workflow sur cette branche, chez la plateforme. */
    lastRun: SetupRun | null;
  }[];
  /** Environnements prêts à recevoir un déploiement (liés à un serveur). */
  deployableEnvs: string[];
  /** Le dépôt renseigné existe-t-il sur la plateforme ? (null = pas de dépôt) */
  repoExists: "yes" | "no" | "unknown" | null;
  /** Dépôt GitHub par défaut (`owner/slug`, owner = utilisateur registry de la
   *  connexion), proposé quand aucun dépôt n'est renseigné. */
  defaultRepo: { repo: string; exists: "yes" | "no" | "unknown" } | null;
  lastDeployment: {
    environment: string;
    status: string;
    authorizedAt: string | null;
    createdAt: string;
  } | null;
};

/** Sous-ensemble structurel de Prisma — même motif que lib/deployment.ts. */
type SetupDb = {
  project: { findUnique(args: unknown): Promise<unknown> };
  deployment: { findFirst(args: unknown): Promise<unknown> };
};

type ProjectRow = {
  githubRepo: string | null;
  ciRepo: string | null;
  ciConnectionId: string | null;
  ciConnection: { provider: string } | null;
  setupCompletedAt: Date | null;
  setupGuide: string | null;
  setupLegacy: boolean;
  environments: { name: string; serverId: string | null; _count: { secrets: number } }[];
  policies: {
    id: string;
    workflow: string;
    branch: string;
    environment: { name: string } | null;
  }[];
};

/** Vérifications externes (API de la plateforme), faites par l'appelant :
 *  ce module reste pur et testable sans réseau. */
export type SetupRun = {
  state: "running" | "success" | "failure" | "cancelled" | "none" | "unknown";
  url: string | null;
  at: string | null;
};

export type SetupChecks = {
  /** Par id de policy : dernier run du workflow sur sa branche. */
  lastRuns?: Record<string, SetupRun>;
  /** Par id de policy : le workflow qu'elle désigne existe-t-il sur sa branche ? */
  workflowFiles?: Record<
    string,
    { status: "found" | "absent" | "unreadable"; hasReport: boolean | null }
  >;
  repoExists?: "yes" | "no" | "unknown";
  defaultRepo?: { repo: string; exists: "yes" | "no" | "unknown" } | null;
};

function workflowStatus(
  policies: { environment: string; file: { status: string } | null }[],
  deployable: Set<string>,
): SetupStepStatus {
  const files = policies.filter((p) => deployable.has(p.environment)).map((p) => p.file);
  if (files.some((f) => f?.status === "found")) return "done";
  if (files.length > 0 && files.every((f) => f?.status === "absent")) return "todo";
  return "manual";
}

export async function computeSetupState(
  db: SetupDb,
  projectId: string,
  checks: SetupChecks = {},
): Promise<SetupState | null> {
  const p = (await db.project.findUnique({
    where: { id: projectId },
    select: {
      githubRepo: true,
      ciRepo: true,
      ciConnectionId: true,
      ciConnection: { select: { provider: true } },
      setupCompletedAt: true,
      setupGuide: true,
      setupLegacy: true,
      environments: {
        select: { name: true, serverId: true, _count: { select: { secrets: true } } },
      },
      // `kind: "server"` : une policy mobile ne fait pas avancer ce guide.
      policies: {
        where: { kind: "server" },
        select: {
          id: true,
          workflow: true,
          branch: true,
          environment: { select: { name: true } },
        },
      },
    },
  })) as ProjectRow | null;
  if (!p) return null;

  const last = (await db.deployment.findFirst({
    where: { projectId },
    orderBy: { createdAt: "desc" },
    select: {
      status: true,
      authorizedAt: true,
      createdAt: true,
      environment: { select: { name: true } },
    },
  })) as {
    status: string;
    authorizedAt: Date | null;
    createdAt: Date;
    environment: { name: string };
  } | null;

  const provider = p.ciConnection?.provider ?? "github";
  const repo = (provider === "github" ? p.githubRepo : p.ciRepo)?.trim() || null;
  const deployable = p.environments.filter((e) => e.serverId);
  const deployableNames = new Set(deployable.map((e) => e.name));
  const policies = p.policies
    .filter((x) => x.environment)
    .map((x) => ({
      id: x.id,
      workflow: x.workflow,
      branch: x.branch,
      environment: x.environment!.name,
      file: checks.workflowFiles?.[x.id] ?? null,
      lastRun: checks.lastRuns?.[x.id] ?? null,
    }));
  // Une policy qui vise un environnement SANS serveur ne mène à rien :
  // /api/deploy répondra `no_server`. Elle ne compte pas.
  const usablePolicy = policies.some((x) => deployableNames.has(x.environment));

  const done = (ok: boolean): SetupStepStatus => (ok ? "done" : "todo");
  const steps: SetupStep[] = [
    { id: "connection", status: done(p.ciConnectionId !== null) },
    // Renseigné ET pas démenti par la plateforme : un dépôt introuvable (avec un
    // jeton valide) ne valide pas l'étape. « unknown » ne bloque pas — sans jeton,
    // on ne peut pas trancher.
    { id: "repo", status: done(repo !== null && checks.repoExists !== "no") },
    { id: "server", status: done(deployable.length > 0) },
    {
      id: "secrets",
      status: deployable.some((e) => e._count.secrets > 0) ? "done" : "optional",
    },
    { id: "policy", status: done(usablePolicy) },
    // Un premier appel reçu prouve que le workflow existe. Sinon, on regarde le
    // fichier que désigne CHAQUE policy menant à un serveur, sur SA branche (les
    // valeurs de la policy, pas celles des modèles) : un fichier trouvé suffit ;
    // tous absents → à faire ; illisible (pas de jeton) → à vérifier soi-même.
    { id: "workflow", status: last ? "done" : workflowStatus(policies, deployableNames) },
    { id: "firstCall", status: done(last !== null) },
    { id: "firstSuccess", status: done(p.setupCompletedAt !== null) },
  ];

  return {
    provider,
    legacy: p.setupLegacy,
    completedAt: p.setupCompletedAt?.toISOString() ?? null,
    guide: isValidSetupGuide(p.setupGuide) ? p.setupGuide : null,
    steps,
    repo,
    policies,
    deployableEnvs: [...deployableNames],
    repoExists: repo ? (checks.repoExists ?? "unknown") : null,
    defaultRepo: repo ? null : (checks.defaultRepo ?? null),
    lastDeployment: last
      ? {
          environment: last.environment.name,
          status: last.status,
          authorizedAt: last.authorizedAt?.toISOString() ?? null,
          createdAt: last.createdAt.toISOString(),
        }
      : null,
  };
}
