// Fonctions de validation et de normalisation pures (sans dépendance Prisma /
// NextAuth). Permet de les tester sans charger la stack serveur entière.

const SLUG_BAD_CHARS = /[^a-z0-9]+/g;
const DIACRITICS = /[̀-ͯ]/g;

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFD")
    .replace(DIACRITICS, "")
    .replace(SLUG_BAD_CHARS, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

// Slug d'un client SaaS Physalis. Sert aussi de base pour le nom de
// schéma PostgreSQL `client_<slug>` provisionné en Phase 3 — Postgres
// limite les identifiers à 63 bytes ; `client_` consomme 7, on cape donc
// le slug à 50 caractères pour garder une marge.
const CLIENT_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/;
export function isValidClientSlug(slug: string): boolean {
  return CLIENT_SLUG_RE.test(slug);
}

const SECRET_KEY_RE = /^[A-Z][A-Z0-9_]{0,127}$/;
export function isValidSecretKey(key: string): boolean {
  return SECRET_KEY_RE.test(key);
}

const ENV_NAME_RE = /^[a-z][a-z0-9-]{0,30}$/;
export function isValidEnvName(name: string): boolean {
  return ENV_NAME_RE.test(name);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function isValidEmail(email: string): boolean {
  return EMAIL_RE.test(email);
}

// Nom de serveur libre (1-60 chars, pas de \n / contrôle).
const SERVER_NAME_RE = /^[\p{L}\p{N}_\-. ]{1,60}$/u;
export function isValidServerName(name: string): boolean {
  return SERVER_NAME_RE.test(name);
}

/**
 * Chemin de deploy par defaut sur le VPS quand `Environment.deployPath`
 * n'est pas renseigne. Convention argoweb : `/srv/projets/<env>/<slug>`.
 * Calcule a chaque appel /api/deploy et au runtime UI (placeholder).
 * Si l'env ou le projet est rename, le path bouge automatiquement.
 */
export function defaultDeployPath(envName: string, projectSlug: string): string {
  return `/srv/projets/${envName}/${projectSlug}`;
}

// Chemin de deploy custom. Ce champ est le SEUL input utilisateur qui
// atterrit dans une commande shell distante : /api/deploy le renvoie
// verbatim dans le bundle, et le modele de workflow (docs/deploy.modele.yml)
// l'interpole dans `ssh … "DEPLOY_DIR='$DPATH' … bash -s"`. Une quote ferme
// la chaine et le reste s'execute sur le VPS du client. D'ou un jeu de
// caracteres FERME (pas de quote, `$`, backtick, `;`, espace, \n) plutot
// qu'une liste noire.
//
// Refus supplementaires : `..` (traversee) et `//` (chemin ambigu). Le
// chemin doit etre absolu et ne pas finir par `/` (concatenations en aval).
const DEPLOY_PATH_RE = /^\/[A-Za-z0-9._/-]{1,255}$/;
export function isValidDeployPath(path: string): boolean {
  if (!DEPLOY_PATH_RE.test(path)) return false;
  if (path.includes("..")) return false;
  if (path.includes("//")) return false;
  if (path.endsWith("/")) return false;
  return true;
}

// IP v4/v6 ou hostname FQDN. Pas de validation parfaite, mais filtre les
// inputs absurdes (espaces, scheme, multi-lignes).
const SERVER_HOST_RE = /^[A-Za-z0-9.:_-]{1,253}$/;
export function isValidServerHost(host: string): boolean {
  return SERVER_HOST_RE.test(host);
}

// SSH login : format POSIX permissif (`[a-z_][a-z0-9_-]{0,31}`), comportement
// adduser standard.
const SSH_USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/;
export function isValidSshUser(user: string): boolean {
  return SSH_USER_RE.test(user);
}

// GitHub repo "owner/repo" — owner et repo suivent les regles GitHub
// (lettres/chiffres/`-`/`_`/`.`, max 39 chars chacun).
const GITHUB_REPO_RE = /^[A-Za-z0-9_.-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/;
export function isValidGithubRepo(repo: string): boolean {
  return GITHUB_REPO_RE.test(repo);
}

// Workflow file basename : lettres/chiffres/`-`/`_`/`.`, doit finir par
// `.yml` ou `.yaml`.
const WORKFLOW_FILE_RE = /^[A-Za-z0-9_.-]{1,80}\.(yml|yaml)$/;
export function isValidWorkflowFile(file: string): boolean {
  return WORKFLOW_FILE_RE.test(file);
}

// Branch git — accepte les caracteres usuels mais refuse `..`, `~`, `^`,
// `:`, espaces, controle (cf. git-check-ref-format). On reste strict
// volontairement : pas de wildcard.
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/;
export function isValidGitBranch(branch: string): boolean {
  if (!BRANCH_RE.test(branch)) return false;
  if (branch.includes("..")) return false;
  if (branch.endsWith("/") || branch.endsWith(".") || branch.endsWith(".lock")) {
    return false;
  }
  return true;
}

// ── CI/CD multi-provider (cf. lib/oidc.ts, modèle Project.ci*) ──────────────

// GitLab `project_path` — "group/project" ou "group/subgroup/project".
// Chaque segment : alphanumérique + `_`/`-`/`.`, sans commencer/finir par un
// séparateur ; au moins 2 segments. Longueur totale bornée.
const GITLAB_PROJECT_PATH_RE =
  /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?(?:\/[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?){1,20}$/;
export function isValidGitlabProjectPath(path: string): boolean {
  return path.length <= 255 && GITLAB_PROJECT_PATH_RE.test(path);
}

// Bitbucket `repositoryUuid` — UUID, avec ou sans accolades (Bitbucket les
// inclut, ex. "{11111111-2222-3333-4444-555555555555}").
const BITBUCKET_UUID_RE =
  /^\{?[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\}?$/;
export function isValidBitbucketRepoUuid(uuid: string): boolean {
  return BITBUCKET_UUID_RE.test(uuid);
}

// Nom d'environment CI (claim `environment` GitLab / `deploymentEnvironment`
// Bitbucket) — stocké dans Policy.workflow pour ces providers. "" = wildcard
// (tout environment). Permissif mais borné.
const CI_ENV_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._:/ -]{0,99}$/;
export function isValidCiEnvironmentName(name: string): boolean {
  return name === "" || CI_ENV_NAME_RE.test(name);
}

// Issuer GitLab self-hosted : URL https d'instance (origin, sans path requis).
// "" autorisé = gitlab.com (issuer par défaut).
const HTTPS_ORIGIN_RE = /^https:\/\/[a-z0-9.-]+(:\d{1,5})?(\/[^\s]*)?$/i;
export function isValidGitlabIssuer(issuer: string): boolean {
  return issuer === "" || HTTPS_ORIGIN_RE.test(issuer);
}

// Issuer Bitbucket : URL OIDC du workspace, requise.
// https://api.bitbucket.org/2.0/workspaces/<workspace>/pipelines-config/identity/oidc
const BITBUCKET_ISSUER_RE =
  /^https:\/\/api\.bitbucket\.org\/2\.0\/workspaces\/[^/\s]+\/pipelines-config\/identity\/oidc$/;
export function isValidBitbucketIssuer(issuer: string): boolean {
  return BITBUCKET_ISSUER_RE.test(issuer);
}

/**
 * Sanity check minimal sur un blob de cle privee SSH. On accepte les formats
 * OpenSSH (`-----BEGIN OPENSSH PRIVATE KEY-----`) et PEM RSA/EC/Ed25519.
 * Le but n'est pas de parser la cle, juste de refuser les inputs vides /
 * tronques avant de les chiffrer en base.
 */
export function isValidSshPrivateKey(input: string): boolean {
  const trimmed = input.trim();
  if (trimmed.length < 100) return false;
  if (!/^-----BEGIN [A-Z0-9 ]+PRIVATE KEY-----/.test(trimmed)) return false;
  if (!/-----END [A-Z0-9 ]+PRIVATE KEY-----$/.test(trimmed)) return false;
  return true;
}
