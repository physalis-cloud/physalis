// Résolution de la connexion CI/CD d'un projet (org-level CiConnection).
// Remplace les anciens OrgSecret à clés magiques (GITHUB_DISPATCH_TOKEN,
// REGISTRY_*). Une connexion porte : provider + issuer OIDC (non secret) +
// secrets control-plane chiffrés (token redeploy, creds registry) dans
// CiConnectionSecret. Cf. lib/oidc.ts, /api/deploy.

import { decrypt } from "./crypto";
import { effectiveRepo, effectivePolicyIssuer } from "./ci-provider";

// `kind` des CiConnectionSecret. Garder en sync avec le CRUD connexions.
// (Le `kind` est une colonne string libre → ajouter un kind ne nécessite PAS
// de migration ; la table vient de 20260614140000_ci_connections.)
export const CI_SECRET_KIND = {
  redeployToken: "redeploy_token",
  registryUrl: "registry_url",
  registryUser: "registry_user",
  registryToken: "registry_token",
  // Identité (email Atlassian / username) pour l'auth Basic Bitbucket — requise
  // pour les API tokens `ATATT` / app passwords (Bearer ne marche que pour les
  // Access Tokens `ATCTT`). Stockée chiffrée comme les autres, bien que non
  // secrète. Cf. bitbucketAuthHeader.
  apiIdentity: "api_identity",
} as const;

export const DEFAULT_REGISTRY_URL = "ghcr.io";

// Accepte le client étendu (lib/prisma), un client tenant (getTenantPrisma) ou
// une transaction (withTenantSchema) — typage structurel souple sur le seul
// appel utilisé, résultat re-typé par cast explicite ci-dessous.
type Db = {
  project: {
    findUnique: (args: {
      where: { id: string };
      select: Record<string, unknown>;
    }) => Promise<unknown>;
  };
};

type ConnectionMetaRow = {
  githubRepo: string | null;
  githubWorkflow: string | null;
  ciRepo: string | null;
  ciConnection: {
    id: string;
    name: string;
    provider: string;
    issuer: string | null;
  } | null;
};

type ConnectionSecretsRow = {
  ciConnection: {
    secrets: {
      kind: string;
      encryptedValue: string;
      iv: string;
      tag: string;
    }[];
  } | null;
};

export type ProjectCiMeta = {
  connectionId: string | null;
  connectionName: string | null;
  provider: string;
  /** Issuer brut de la connexion (null = défaut du provider). */
  issuer: string | null;
  /** Valeur à stocker dans Policy.issuer (null pour github/gitlab.com). */
  policyIssuer: string | null;
  /** Repo effectif (githubRepo pour github, ciRepo sinon). */
  repo: string;
  githubWorkflow: string | null;
};

export type ResolvedRegistry = { url: string; user: string; pat: string };

export type ProjectCiSecrets = {
  redeployToken: string | null;
  registry: ResolvedRegistry | null;
  /** Identité Basic auth Bitbucket (email/username), null si non configurée. */
  apiIdentity: string | null;
};

/**
 * En-tête d'auth pour l'API Bitbucket. Si une identité (email Atlassian /
 * username) est configurée → Basic auth (`email:token`) : couvre les API tokens
 * `ATATT` et les app passwords. Sinon → Bearer : couvre les Access Tokens
 * `ATCTT` (Repository/Workspace/Project). À utiliser pour TOUT appel Bitbucket
 * (redeploy + lecture des docs).
 */
export function bitbucketAuthHeader(
  token: string,
  identity: string | null | undefined,
): Record<string, string> {
  const id = (identity ?? "").trim();
  if (id) {
    const basic = Buffer.from(`${id}:${token}`).toString("base64");
    return { Authorization: `Basic ${basic}` };
  }
  return { Authorization: `Bearer ${token}` };
}

/**
 * Métadonnées CI d'un projet (provider/issuer/repo) SANS déchiffrement.
 * Pour l'estampillage des policies et la résolution du provider.
 */
export async function loadProjectCiMeta(
  db: Db,
  projectId: string,
): Promise<ProjectCiMeta | null> {
  const project = (await db.project.findUnique({
    where: { id: projectId },
    select: {
      githubRepo: true,
      githubWorkflow: true,
      ciRepo: true,
      ciConnection: {
        select: { id: true, name: true, provider: true, issuer: true },
      },
    },
  })) as ConnectionMetaRow | null;
  if (!project) return null;
  const conn = project.ciConnection;
  const provider = conn?.provider ?? "github";
  const issuer = conn?.issuer ?? null;
  return {
    connectionId: conn?.id ?? null,
    connectionName: conn?.name ?? null,
    provider,
    issuer,
    policyIssuer: effectivePolicyIssuer(provider, issuer),
    repo: effectiveRepo(provider, project.githubRepo, project.ciRepo),
    githubWorkflow: project.githubWorkflow,
  };
}

/**
 * Secrets déchiffrés de la connexion d'un projet (token redeploy + registry).
 * Retourne des null si pas de connexion / secret absent.
 */
export async function loadProjectCiSecrets(
  db: Db,
  projectId: string,
): Promise<ProjectCiSecrets> {
  const project = (await db.project.findUnique({
    where: { id: projectId },
    select: {
      ciConnection: {
        select: {
          secrets: {
            select: { kind: true, encryptedValue: true, iv: true, tag: true },
          },
        },
      },
    },
  })) as ConnectionSecretsRow | null;
  const secrets = project?.ciConnection?.secrets ?? [];
  const byKind = new Map(secrets.map((s) => [s.kind, s]));
  const dec = (kind: string): string | null => {
    const s = byKind.get(kind);
    return s ? decrypt({ encryptedValue: s.encryptedValue, iv: s.iv, tag: s.tag }) : null;
  };

  const registryToken = dec(CI_SECRET_KIND.registryToken);
  const registryUser = dec(CI_SECRET_KIND.registryUser);
  const registry: ResolvedRegistry | null =
    registryToken && registryUser
      ? {
          url: dec(CI_SECRET_KIND.registryUrl) || DEFAULT_REGISTRY_URL,
          user: registryUser,
          pat: registryToken,
        }
      : null;

  return {
    redeployToken: dec(CI_SECRET_KIND.redeployToken),
    registry,
    apiIdentity: dec(CI_SECRET_KIND.apiIdentity),
  };
}
