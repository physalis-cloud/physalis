// Vérification des tokens OIDC CI/CD (GitHub Actions, GitLab CI/CD, Bitbucket
// Pipelines).
//
// Le runner CI peut produire, sur demande, un JWT signé par sa plateforme avec
// des claims sur le repo, la branche et l'environnement. Physalis valide ce JWT
// contre le JWKS public de la plateforme et fait correspondre les claims à une
// `Policy` en DB.
//
// Hot path : `/api/deploy`. La crypto est faite par jose (cache JWKS en mémoire,
// TTL ~10 min, rotation auto). Un cache de `JWKSet` par URL au niveau module
// suffit (ré-instancié au redémarrage du process).
//
// ── Modèle de confiance des issuers ───────────────────────────────────────
//   - GitHub (token.actions.githubusercontent.com) et GitLab.com (gitlab.com)
//     ont un issuer FIXE → confiance intrinsèque, config hardcodée.
//   - GitLab self-hosted (issuer = URL d'instance) et Bitbucket (issuer = URL
//     OIDC du workspace) ont un issuer DYNAMIQUE. On ne fait JAMAIS confiance à
//     un `iss` arbitraire : l'appelant injecte `resolveTrustedIssuer`, qui en
//     prod vérifie qu'une Policy enregistrée porte cet issuer (l'allowlist =
//     l'existence d'une policy). Un tenant ne peut déclarer un issuer que pour
//     ses propres projets → pas de risque cross-tenant.

import {
  createRemoteJWKSet,
  jwtVerify,
  decodeJwt,
  errors as joseErrors,
} from "jose";
import type { JWTPayload } from "jose";

// ── Issuers connus (confiance intrinsèque) ────────────────────────────────
const GITHUB_ISSUER = "https://token.actions.githubusercontent.com";
const GITHUB_JWKS_URL = `${GITHUB_ISSUER}/.well-known/jwks`;
const GITLAB_COM_ISSUER = "https://gitlab.com";
// Issuer Bitbucket Pipelines : workspace-scopé.
// https://api.bitbucket.org/2.0/workspaces/<workspace>/pipelines-config/identity/oidc
const BITBUCKET_ISSUER_RE =
  /^https:\/\/api\.bitbucket\.org\/2\.0\/workspaces\/[^/]+\/pipelines-config\/identity\/oidc$/;

export type CiProvider = "github" | "gitlab" | "bitbucket";

// Audience attendue dans les tokens. `OIDC_AUDIENCE` permet l'override
// (recommandé : poser le hostname du portail vault, ex. `vault.physalis.cloud`,
// pour empêcher le replay d'un token destiné à un autre service).
//
// Bitbucket NE permet pas (à ce jour) de configurer l'`aud` par step — il vaut
// l'URL d'identité du workspace. On ne peut donc pas exiger l'audience vault
// pour Bitbucket : le scoping repose sur l'issuer-workspace (allowlisté) + le
// repositoryUuid + la branche/environment. Posture anti-replay plus faible,
// documentée. Cf. expectedAudience() non appliquée pour bitbucket.
function expectedAudience(): string {
  return process.env.OIDC_AUDIENCE ?? "vault.physalis.cloud";
}

// ── Cache JWKS (par URL résolue) ──────────────────────────────────────────
// jose v6 cache les clés en mémoire (~10 min) avec rotation auto. On garde un
// resolver par URL. `OIDC_JWKS_URL` force une URL unique (tests : fake issuer).
const jwksByUrl = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
// Cache discovery (issuer → jwks_uri) pour les providers résolus par
// `.well-known/openid-configuration` (Bitbucket).
const discoveryCache = new Map<string, string>();

function jwksForUrl(url: string) {
  let j = jwksByUrl.get(url);
  if (!j) {
    j = createRemoteJWKSet(new URL(url));
    jwksByUrl.set(url, j);
  }
  return j;
}

// Reset les caches — utile uniquement en test (mock issuer).
export function _resetJwksCache(): void {
  jwksByUrl.clear();
  discoveryCache.clear();
}

function stripTrailingSlash(s: string): string {
  return s.replace(/\/+$/, "");
}

async function discoverJwksUri(issuer: string): Promise<string> {
  const key = stripTrailingSlash(issuer);
  const cached = discoveryCache.get(key);
  if (cached) return cached;
  const res = await fetch(`${key}/.well-known/openid-configuration`);
  if (!res.ok) throw new Error(`discovery ${res.status}`);
  const cfg = (await res.json()) as { jwks_uri?: unknown };
  if (typeof cfg.jwks_uri !== "string" || !cfg.jwks_uri) {
    throw new Error("discovery: no jwks_uri");
  }
  discoveryCache.set(key, cfg.jwks_uri);
  return cfg.jwks_uri;
}

// URL du JWKS pour (provider, issuer). `OIDC_JWKS_URL` court-circuite (tests).
async function resolveJwksUrl(
  provider: CiProvider,
  issuer: string,
): Promise<string> {
  const override = process.env.OIDC_JWKS_URL;
  if (override) return override;
  if (provider === "github") return GITHUB_JWKS_URL;
  // GitLab (.com et self-hosted) : chemin JWKS stable.
  if (provider === "gitlab") {
    return `${stripTrailingSlash(issuer)}/oauth/discovery/keys`;
  }
  // Bitbucket : chemin JWKS non garanti stable → discovery OIDC.
  return discoverJwksUri(issuer);
}

export type OidcClaims = {
  provider: CiProvider;
  /** Issuer effectif validé (= claim `iss`). */
  issuer: string;
  /**
   * Identifiant repo natif du provider :
   *   github    → "owner/repo" (`repository`)
   *   gitlab    → "group/project" (`project_path`)
   *   bitbucket → UUID du repo (`repositoryUuid`)
   */
  repo: string;
  /**
   * Discriminant stocké en colonne `Policy.workflow` :
   *   github    → basename du fichier workflow ("deploy.yml")
   *   gitlab    → environment CI (`environment`), "" si absent
   *   bitbucket → environment de déploiement (`deploymentEnvironment`), "" si absent
   */
  matchKey: string;
  /**
   * Valeur à matcher contre `Policy.issuer` :
   *   - null pour les issuers par défaut (github.com, gitlab.com) → les
   *     policies de ces providers stockent `issuer = null`
   *   - l'URL d'issuer pour GitLab self-hosted et Bitbucket (stockée en DB,
   *     sert aussi d'allowlist)
   */
  policyIssuer: string | null;
  /** Nom de branche (ou tag). */
  branch: string;
  raw: JWTPayload;
};

export type VerifyResult =
  | { ok: true; claims: OidcClaims }
  | { ok: false; reason: VerifyError };

export type VerifyError =
  | "missing_token"
  | "expired"
  | "bad_signature"
  | "wrong_issuer"
  | "untrusted_issuer"
  | "wrong_audience"
  | "missing_claims"
  | "unparseable_ref"
  | "jwks_unreachable";

/** Issuer dynamique de confiance, résolu depuis l'allowlist (DB). */
export type TrustedIssuer = { provider: Exclude<CiProvider, "github"> };

export type VerifyOptions = {
  /**
   * Résout la confiance d'un issuer DYNAMIQUE (GitLab self-hosted, Bitbucket
   * workspace). Retourne le provider attendu si l'issuer est allowlisté, sinon
   * null. Non appelé pour les issuers fixes (github.com, gitlab.com).
   */
  resolveTrustedIssuer?: (
    iss: string,
  ) => Promise<TrustedIssuer | null> | TrustedIssuer | null;
};

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function mapJoseError(err: unknown): { ok: false; reason: VerifyError } {
  if (err instanceof joseErrors.JWTExpired) {
    return { ok: false, reason: "expired" };
  }
  if (err instanceof joseErrors.JWTClaimValidationFailed) {
    const claim = (err as { claim?: string }).claim;
    if (claim === "iss") return { ok: false, reason: "wrong_issuer" };
    if (claim === "aud") return { ok: false, reason: "wrong_audience" };
    return { ok: false, reason: "missing_claims" };
  }
  if (
    err instanceof joseErrors.JWSInvalid ||
    err instanceof joseErrors.JWSSignatureVerificationFailed ||
    err instanceof joseErrors.JWKSNoMatchingKey
  ) {
    return { ok: false, reason: "bad_signature" };
  }
  if (
    err instanceof joseErrors.JOSEError &&
    typeof err.message === "string" &&
    err.message.toLowerCase().includes("jwks")
  ) {
    return { ok: false, reason: "jwks_unreachable" };
  }
  return { ok: false, reason: "bad_signature" };
}

// Branche depuis un ref GitHub : "refs/heads/x" | "refs/tags/x" ou `ref_name`.
function githubBranch(payload: JWTPayload): string | null {
  const refName = str((payload as Record<string, unknown>).ref_name);
  if (refName) return refName;
  const ref = str(payload.ref);
  if (ref.startsWith("refs/heads/")) return ref.slice("refs/heads/".length);
  if (ref.startsWith("refs/tags/")) return ref.slice("refs/tags/".length);
  return null;
}

// Branche depuis les claims GitLab : `ref` est déjà le nom court ; `ref_path`
// est la forme longue "refs/heads/x".
function gitlabBranch(payload: JWTPayload): string | null {
  const ref = str((payload as Record<string, unknown>).ref);
  if (ref && !ref.startsWith("refs/")) return ref;
  const refPath = str((payload as Record<string, unknown>).ref_path);
  if (refPath.startsWith("refs/heads/")) return refPath.slice("refs/heads/".length);
  if (refPath.startsWith("refs/tags/")) return refPath.slice("refs/tags/".length);
  if (ref) return ref;
  return null;
}

// Valeur stockée dans `Policy.issuer` pour ce (provider, issuer). null pour les
// issuers par défaut (github.com, gitlab.com) ; l'URL pour les dynamiques.
function policyIssuerFor(provider: CiProvider, issuer: string): string | null {
  if (provider === "github") return null;
  if (provider === "gitlab") return issuer === GITLAB_COM_ISSUER ? null : issuer;
  return issuer; // bitbucket : toujours workspace-scopé
}

function extractClaims(
  provider: CiProvider,
  issuer: string,
  payload: JWTPayload,
): VerifyResult {
  const p = payload as Record<string, unknown>;
  const policyIssuer = policyIssuerFor(provider, issuer);

  if (provider === "github") {
    const repo = str(p.repository);
    const ref = str(p.ref);
    const wfRef = str(p.job_workflow_ref);
    if (!repo || !ref || !wfRef) return { ok: false, reason: "missing_claims" };
    const branch = githubBranch(payload);
    if (!branch) return { ok: false, reason: "unparseable_ref" };
    // "owner/repo/.github/workflows/<file>@<ref>" → basename "<file>".
    const m = wfRef.match(/\.github\/workflows\/([^@]+)/);
    if (!m || !m[1]) return { ok: false, reason: "missing_claims" };
    return {
      ok: true,
      claims: {
        provider,
        issuer,
        policyIssuer,
        repo,
        matchKey: m[1],
        branch,
        raw: payload,
      },
    };
  }

  if (provider === "gitlab") {
    const repo = str(p.project_path);
    if (!repo) return { ok: false, reason: "missing_claims" };
    const branch = gitlabBranch(payload);
    if (!branch) return { ok: false, reason: "unparseable_ref" };
    // `environment` absent quand le job ne déclare pas `environment:` → "".
    const env = str(p.environment);
    return {
      ok: true,
      claims: {
        provider,
        issuer,
        policyIssuer,
        repo,
        matchKey: env,
        branch,
        raw: payload,
      },
    };
  }

  // bitbucket
  const repo = str(p.repositoryUuid);
  if (!repo) return { ok: false, reason: "missing_claims" };
  const branch = str(p.branchName);
  if (!branch) return { ok: false, reason: "unparseable_ref" };
  const env = str(p.deploymentEnvironment);
  return {
    ok: true,
    claims: {
      provider,
      issuer,
      policyIssuer,
      repo,
      matchKey: env,
      branch,
      raw: payload,
    },
  };
}

/**
 * Valide un token OIDC CI/CD (multi-provider).
 *
 * Étapes :
 *   1. Décode le token NON vérifié pour lire `iss`.
 *   2. Résout le provider depuis `iss` :
 *        - issuer fixe github.com / gitlab.com → confiance intrinsèque
 *        - issuer dynamique (bitbucket workspace, gitlab self-hosted) →
 *          `resolveTrustedIssuer` doit confirmer l'allowlist
 *   3. Vérifie signature + iss + aud (sauf bitbucket) + exp contre le JWKS du
 *      provider.
 *   4. Extrait les claims normalisés (repo / matchKey / branch).
 *
 * Aucune vérification d'autorisation ici — le caller fait le lookup Policy.
 */
export async function verifyOidcToken(
  rawToken: string | null | undefined,
  opts?: VerifyOptions,
): Promise<VerifyResult> {
  if (!rawToken || typeof rawToken !== "string") {
    return { ok: false, reason: "missing_token" };
  }

  // 1. Décode (non vérifié) pour lire l'issuer.
  let unverified: JWTPayload;
  try {
    unverified = decodeJwt(rawToken);
  } catch {
    return { ok: false, reason: "bad_signature" };
  }
  const iss = str(unverified.iss);
  if (!iss) return { ok: false, reason: "wrong_issuer" };

  // 2. Résolution du provider + confiance.
  let provider: CiProvider;
  if (iss === GITHUB_ISSUER) {
    provider = "github";
  } else if (iss === GITLAB_COM_ISSUER) {
    provider = "gitlab";
  } else if (BITBUCKET_ISSUER_RE.test(iss)) {
    const t = await opts?.resolveTrustedIssuer?.(iss);
    if (!t || t.provider !== "bitbucket") {
      return { ok: false, reason: "untrusted_issuer" };
    }
    provider = "bitbucket";
  } else if (/^https:\/\/[^\s/]+(\/[^\s]*)?$/.test(iss)) {
    // Candidat GitLab self-hosted : doit être allowlisté en tant que gitlab.
    const t = await opts?.resolveTrustedIssuer?.(iss);
    if (!t || t.provider !== "gitlab") {
      return { ok: false, reason: "untrusted_issuer" };
    }
    provider = "gitlab";
  } else {
    return { ok: false, reason: "wrong_issuer" };
  }

  // 3. JWKS + vérification crypto.
  let jwksUrl: string;
  try {
    jwksUrl = await resolveJwksUrl(provider, iss);
  } catch {
    return { ok: false, reason: "jwks_unreachable" };
  }

  // Bitbucket : aud non configurable → on ne l'exige pas (cf. expectedAudience).
  const audience = provider === "bitbucket" ? undefined : expectedAudience();

  let payload: JWTPayload;
  try {
    const verified = await jwtVerify(rawToken, jwksForUrl(jwksUrl), {
      issuer: iss,
      audience,
      clockTolerance: 10,
    });
    payload = verified.payload;
  } catch (err) {
    return mapJoseError(err);
  }

  // 4. Extraction normalisée.
  return extractClaims(provider, iss, payload);
}

// ── Compat GitHub (legacy) ────────────────────────────────────────────────
// Conserve la signature/forme historique pour les appelants GitHub-only
// (et les tests existants). Délègue au vérificateur générique.

export type GithubParsedClaims = {
  /** "owner/repo" */
  repository: string;
  /** basename du workflow file, ex. "deploy.yml". */
  workflowFile: string;
  /** nom de branche extrait de `ref`. */
  branch: string;
  raw: JWTPayload;
};

export type GithubVerifyResult =
  | { ok: true; claims: GithubParsedClaims }
  | { ok: false; reason: VerifyError };

/** @deprecated Utiliser `verifyOidcToken`. Conservé pour le chemin GitHub. */
export async function verifyGithubOidcToken(
  rawToken: string | null | undefined,
): Promise<GithubVerifyResult> {
  const r = await verifyOidcToken(rawToken);
  if (!r.ok) return r;
  if (r.claims.provider !== "github") {
    return { ok: false, reason: "wrong_issuer" };
  }
  return {
    ok: true,
    claims: {
      repository: r.claims.repo,
      workflowFile: r.claims.matchKey,
      branch: r.claims.branch,
      raw: r.claims.raw,
    },
  };
}

/**
 * Extrait le token Bearer de l'header Authorization. Retourne null si absent
 * ou format invalide.
 */
export function extractBearer(req: Request): string | null {
  const h = req.headers.get("authorization") ?? req.headers.get("Authorization");
  if (!h || typeof h !== "string") return null;
  const m = h.match(/^Bearer\s+(.+)$/);
  return m && m[1] ? m[1].trim() : null;
}
