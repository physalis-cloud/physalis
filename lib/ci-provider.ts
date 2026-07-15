// Helpers partagés pour la config CI/CD multi-provider au niveau projet.
// La config (provider + repo + issuer) vit sur Project ; les policies OIDC en
// sont estampillées (Policy.provider/repo/issuer). Cf. lib/oidc.ts, /api/deploy.

import { isValidGitlabIssuer, isValidBitbucketIssuer } from "./validation";

export type CiProvider = "github" | "gitlab" | "bitbucket";

export const CI_PROVIDERS: CiProvider[] = ["github", "gitlab", "bitbucket"];

/**
 * Valide un issuer OIDC selon le provider (config d'une CiConnection).
 * Retourne un message d'erreur ou null si valide. "" = défaut (gitlab.com /
 * non applicable à github).
 */
export function validateConnectionIssuer(
  provider: string,
  issuer: string,
): string | null {
  if (provider === "github") {
    return issuer === "" ? null : "github n'utilise pas d'issuer";
  }
  if (provider === "gitlab") {
    return isValidGitlabIssuer(issuer)
      ? null
      : "Issuer GitLab invalide (URL https, vide = gitlab.com)";
  }
  return isValidBitbucketIssuer(issuer)
    ? null
    : "Issuer Bitbucket requis (URL OIDC du workspace)";
}

export function isCiProvider(v: string): v is CiProvider {
  return (CI_PROVIDERS as string[]).includes(v);
}

/**
 * Repo effectif des policies selon le provider : `githubRepo` pour github,
 * `ciRepo` sinon. Source unique estampillée sur `Policy.repo`. Trim + "" si
 * absent.
 */
export function effectiveRepo(
  provider: string,
  githubRepo: string | null | undefined,
  ciRepo: string | null | undefined,
): string {
  return ((provider === "github" ? githubRepo : ciRepo) ?? "").trim();
}

/**
 * Valeur de `Policy.issuer` selon le provider : null pour github et pour
 * gitlab.com (ciIssuer vide), l'URL d'issuer sinon (GitLab self-hosted /
 * workspace Bitbucket). Cohérent avec `claims.policyIssuer` de lib/oidc.ts.
 */
export function effectivePolicyIssuer(
  provider: string,
  ciIssuer: string | null | undefined,
): string | null {
  if (provider === "github") return null;
  const t = (ciIssuer ?? "").trim();
  return t === "" ? null : t;
}
