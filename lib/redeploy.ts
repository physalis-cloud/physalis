// Déclenchement d'un redeploy manuel multi-provider (bouton Redeploy).
//   - GitHub    : workflow_dispatch (Actions)
//   - GitLab    : POST /api/v4/projects/{path}/pipeline
//   - Bitbucket : POST /2.0/repositories/{ws}/{repo}/pipelines/
// Le token API du provider = `redeploy_token` de la CiConnection
// (cf. lib/ci-connection.ts). Il ne quitte jamais le serveur. Pas d'exception
// réseau propagée : le résultat HTTP est normalisé pour l'appelant.

import { Prisma } from "@prisma/client";
import { effectiveRepo, isCiProvider, type CiProvider } from "./ci-provider";
import { bitbucketAuthHeader, loadProjectCiSecrets } from "./ci-connection";
import { adminPrisma } from "./prisma";

const GITHUB_API = "https://api.github.com";
const GITLAB_COM_BASE = "https://gitlab.com";
const BITBUCKET_API = "https://api.bitbucket.org";

export type RedeployResult = {
  ok: boolean;
  httpStatus: number;
  /** Corps d'erreur tronqué (présent si !ok). */
  error?: string;
};

function stripTrailingSlash(u: string): string {
  return u.replace(/\/+$/, "");
}

/**
 * Workspace Bitbucket extrait de l'issuer OIDC du workspace
 * (https://api.bitbucket.org/2.0/workspaces/<ws>/pipelines-config/identity/oidc).
 */
export function bitbucketWorkspaceFromIssuer(
  issuer: string | null | undefined,
): string | null {
  if (!issuer) return null;
  const m = issuer.match(
    /\/workspaces\/([^/]+)\/pipelines-config\/identity\/oidc\/?$/,
  );
  return m?.[1] ?? null;
}

async function readErr(res: Response): Promise<string> {
  return (await res.text().catch(() => "")).slice(0, 500);
}

function result(res: Response, error: string): RedeployResult {
  return res.ok
    ? { ok: true, httpStatus: res.status }
    : { ok: false, httpStatus: res.status, error };
}

async function dispatchGitHub(
  repo: string,
  workflow: string,
  ref: string,
  envName: string,
  token: string,
): Promise<RedeployResult> {
  const url = `${GITHUB_API}/repos/${repo}/actions/workflows/${encodeURIComponent(
    workflow,
  )}/dispatches`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      "User-Agent": "Physalis-Redeploy",
    },
    body: JSON.stringify({ ref, inputs: { environment: envName } }),
  });
  return result(res, await readErr(res));
}

async function dispatchGitLab(
  repo: string,
  ref: string,
  envName: string,
  token: string,
  issuer: string | null,
): Promise<RedeployResult> {
  // issuer vide/null → gitlab.com ; sinon instance self-hosted.
  const base = stripTrailingSlash((issuer ?? "").trim() || GITLAB_COM_BASE);
  // L'id projet GitLab accepte le chemin `group/project` URL-encodé.
  const url = `${base}/api/v4/projects/${encodeURIComponent(repo)}/pipeline`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "PRIVATE-TOKEN": token,
      "Content-Type": "application/json",
      "User-Agent": "Physalis-Redeploy",
    },
    body: JSON.stringify({
      ref,
      // Parité avec l'input `environment` de GitHub : exposé en variable CI.
      variables: [{ key: "ENVIRONMENT", value: envName }],
    }),
  });
  return result(res, await readErr(res));
}

async function dispatchBitbucket(
  repo: string,
  workspace: string,
  ref: string,
  token: string,
  identity: string | null,
): Promise<RedeployResult> {
  // `repo` = UUID (avec accolades) ou repo_slug ; l'endpoint accepte les deux.
  const url = `${BITBUCKET_API}/2.0/repositories/${encodeURIComponent(
    workspace,
  )}/${encodeURIComponent(repo)}/pipelines/`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      ...bitbucketAuthHeader(token, identity),
      "Content-Type": "application/json",
      "User-Agent": "Physalis-Redeploy",
    },
    body: JSON.stringify({
      target: { type: "pipeline_ref_target", ref_type: "branch", ref_name: ref },
    }),
  });
  return result(res, await readErr(res));
}

export type TriggerRedeployOpts = {
  provider: CiProvider;
  repo: string;
  workflow: string;
  ref: string;
  envName: string;
  token: string;
  /** Issuer brut de la connexion (GitLab self-hosted / workspace Bitbucket). */
  issuer: string | null;
  /** Identité Basic auth Bitbucket (email/username) ; null = Bearer. */
  identity?: string | null;
};

/**
 * Déclenche un redeploy sur le provider du projet. Retourne le résultat HTTP
 * normalisé. Les erreurs réseau (fetch reject) ne sont PAS attrapées ici :
 * l'appelant les wrappe (try/catch) pour journaliser.
 */
export async function triggerRedeploy(
  opts: TriggerRedeployOpts,
): Promise<RedeployResult> {
  switch (opts.provider) {
    case "gitlab":
      return dispatchGitLab(
        opts.repo,
        opts.ref,
        opts.envName,
        opts.token,
        opts.issuer,
      );
    case "bitbucket": {
      const workspace = bitbucketWorkspaceFromIssuer(opts.issuer);
      if (!workspace) {
        return {
          ok: false,
          httpStatus: 400,
          error:
            "Workspace Bitbucket introuvable : l'issuer OIDC de la connexion CI/CD est requis.",
        };
      }
      return dispatchBitbucket(
        opts.repo,
        workspace,
        opts.ref,
        opts.token,
        opts.identity ?? null,
      );
    }
    case "github":
    default:
      return dispatchGitHub(
        opts.repo,
        opts.workflow,
        opts.ref,
        opts.envName,
        opts.token,
      );
  }
}

// ── Redeploy d'un projet (assemblage complet) ────────────────────────────────
// Même logique que le bouton « Redeploy » (app/api/projects/[slug]/redeploy) :
// résout provider/repo/token/workflow + branche via la policy OIDC, puis
// dispatche. Réutilisable hors session (cron, rotation) en passant un client
// tenant. NE FAIT PAS l'audit : l'appelant log le `RedeployOutcome`.

const DEFAULT_REDEPLOY_WORKFLOW = "redeploy.yml";

type RedeployDb = {
  project: {
    findUnique: (a: {
      where: { id: string };
      select: Record<string, unknown>;
    }) => Promise<unknown>;
  };
  environment: {
    findUnique: (a: {
      where: { projectId_name: { projectId: string; name: string } };
      select: { id: true };
    }) => Promise<{ id: string } | null>;
  };
};

export type RedeployOutcome =
  | { triggered: false; reason: string }
  | {
      triggered: true;
      result: RedeployResult;
      provider: CiProvider;
      repo: string;
      workflow: string;
      ref: string;
    };

/** Métadonnée d'audit normalisée pour un REDEPLOY_TRIGGERED (success|failed|skipped). */
export function redeployAuditMetadata(
  outcome: RedeployOutcome,
  extra: Record<string, string | number | boolean | null> = {},
): Prisma.InputJsonObject {
  return outcome.triggered
    ? {
        ...extra,
        provider: outcome.provider,
        repo: outcome.repo,
        workflow: outcome.workflow,
        ref: outcome.ref,
        status: outcome.result.ok ? "success" : "failed",
        httpStatus: outcome.result.httpStatus,
        providerError: outcome.result.error?.slice(0, 300) ?? null,
      }
    : { ...extra, status: "skipped", reason: outcome.reason };
}

/**
 * Déclenche le redeploy d'un projet/env, provider-agnostique. Résout la branche
 * depuis la policy OIDC (découplage env↔branche), comme le bouton Redeploy.
 * Retourne `{triggered:false, reason}` si rien à dispatcher (dépôt ou token
 * absent) — l'appelant décide de logger/alerter.
 */
export async function triggerProjectRedeploy(
  db: RedeployDb,
  tenantSlug: string | null,
  projectId: string,
  envName: string,
  /** Force un workflow précis (ex. build complet pour un secret build-time). */
  workflowOverride?: string,
): Promise<RedeployOutcome> {
  const project = (await db.project.findUnique({
    where: { id: projectId },
    select: {
      githubRepo: true,
      githubWorkflow: true,
      ciRepo: true,
      ciConnection: { select: { provider: true, issuer: true } },
    },
  })) as {
    githubRepo: string | null;
    githubWorkflow: string | null;
    ciRepo: string | null;
    ciConnection: { provider: string; issuer: string | null } | null;
  } | null;
  if (!project) return { triggered: false, reason: "projet introuvable" };

  const providerRaw = project.ciConnection?.provider ?? "github";
  const provider: CiProvider = isCiProvider(providerRaw) ? providerRaw : "github";
  const repo = effectiveRepo(provider, project.githubRepo, project.ciRepo);
  if (!repo) return { triggered: false, reason: "dépôt non configuré sur le projet" };

  const { redeployToken, apiIdentity } = await loadProjectCiSecrets(db, projectId);
  if (!redeployToken) {
    return { triggered: false, reason: "token de redeploy absent (connexion CI/CD)" };
  }

  const workflow = workflowOverride ?? project.githubWorkflow ?? DEFAULT_REDEPLOY_WORKFLOW;

  // Branche : résolue depuis la policy OIDC (env↔branche découplés) ; fallback env.
  let ref = envName;
  const environment = await db.environment.findUnique({
    where: { projectId_name: { projectId, name: envName } },
    select: { id: true },
  });
  if (environment && tenantSlug) {
    const policy = await adminPrisma.oidcPolicy.findFirst({
      where: {
        kind: "server",
        tenantSlug,
        projectId,
        environmentId: environment.id,
        ...(provider === "github" ? { workflow } : {}),
      },
      select: { branch: true },
      orderBy: { createdAt: "desc" },
    });
    if (policy) ref = policy.branch;
  }

  let result: RedeployResult;
  try {
    result = await triggerRedeploy({
      provider,
      repo,
      workflow,
      ref,
      envName,
      token: redeployToken,
      issuer: project.ciConnection?.issuer ?? null,
      identity: apiIdentity,
    });
  } catch (e) {
    result = {
      ok: false,
      httpStatus: 0,
      error: e instanceof Error ? e.message : "Erreur réseau",
    };
  }

  return { triggered: true, result, provider, repo, workflow, ref };
}
