// Chantier C-0051 (guide d'installation) — Phase 5 : modèles de workflow
// pré-remplis. Cf. documentation/plans/guide-installation-projet.md §4.3.
//
// On lit le modèle publié (`docs/*.modele.yml`, le même que la doc publique) et
// on remplace des valeurs CONNUES à des emplacements CONNUS. Chaque marqueur
// doit être trouvé exactement le nombre de fois attendu : sinon le modèle a
// changé sans que ce module suive, et on refuse plutôt que de servir un
// fichier à moitié rempli (tests/lib/workflow-templates.test.ts le vérifie sur
// les vrais fichiers).
//
// ⚠️ Les modèles sont lus AU RUNTIME : `docs/` est exclu du contexte Docker.
// Trois verrous doivent rester alignés (mémoire vault-dockerignore-docs-allowlist) :
// `.dockerignore` (!docs/*.modele.yml), le COPY du Dockerfile, et
// `outputFileTracingIncludes` de next.config.ts (build self-host).

import { readFile } from "node:fs/promises";
import path from "node:path";

export type TemplateId = "deploy" | "redeploy" | "gitlab" | "bitbucket";

export const WORKFLOW_TEMPLATES: Record<
  TemplateId,
  { file: string; provider: "github" | "gitlab" | "bitbucket" }
> = {
  deploy: { file: "deploy.modele.yml", provider: "github" },
  redeploy: { file: "redeploy.modele.yml", provider: "github" },
  gitlab: { file: "deploy.gitlab-ci.modele.yml", provider: "gitlab" },
  bitbucket: { file: "deploy.bitbucket-pipelines.modele.yml", provider: "bitbucket" },
};

export function templatesForProvider(provider: string): TemplateId[] {
  return (Object.keys(WORKFLOW_TEMPLATES) as TemplateId[]).filter(
    (id) => WORKFLOW_TEMPLATES[id].provider === provider,
  );
}

export type TemplateValues = {
  /** URL publique de l'instance (physalisBaseUrl). */
  url: string;
  /** Audience OIDC attendue par l'instance. */
  audience: string;
  project: string;
  env: string;
  branch: string;
  /** Policy.workflow : fichier (github) ou environment CI (gitlab/bitbucket). */
  workflow: string;
  /** Environnements proposés au déclenchement manuel (redeploy). */
  envOptions: string[];
};

export class TemplateDriftError extends Error {}

/**
 * Jeu de caractères FERMÉ pour tout ce qui est injecté : les valeurs finissent
 * dans du YAML et, pour GitLab/Bitbucket, dans du shell (`${VAR:-valeur}`).
 * Un slug, un nom d'environnement, une branche ou une URL légitimes y tiennent.
 */
const SAFE = /^[A-Za-z0-9._\/:-]{1,200}$/;

function safe(name: string, v: string): string {
  if (!SAFE.test(v)) throw new TemplateDriftError(`valeur refusée pour ${name}`);
  return v;
}

/** Remplace `search` par `replacement`, en exigeant exactement `count` occurrences. */
function swap(src: string, search: string, replacement: string, count = 1): string {
  const found = src.split(search).length - 1;
  if (found !== count) {
    throw new TemplateDriftError(
      `marqueur attendu ${count} fois, trouvé ${found} : ${JSON.stringify(search.slice(0, 60))}`,
    );
  }
  return src.split(search).join(replacement);
}

/** Rendu pur (testable sans disque). */
export function renderTemplate(id: TemplateId, source: string, raw: TemplateValues): string {
  const v = {
    url: safe("url", raw.url),
    audience: safe("audience", raw.audience),
    project: safe("project", raw.project),
    env: safe("env", raw.env),
    branch: safe("branch", raw.branch),
    // Vide permis hors GitHub : une policy GitLab/Bitbucket sans environment CI
    // accepte tous les environnements — on garde alors la valeur du modèle.
    workflow: raw.workflow === "" && id !== "deploy" && id !== "redeploy"
      ? ""
      : safe("workflow", raw.workflow),
    envOptions: raw.envOptions.map((e) => safe("envOptions", e)),
  };
  // Double-quoted YAML : valide pour toute valeur du jeu SAFE.
  const q = (s: string) => JSON.stringify(s);
  let s = source;

  switch (id) {
    case "deploy":
      s = swap(s, "  VAULT_URL: https://vault.physalis.cloud\n", `  VAULT_URL: ${q(v.url)}\n`);
      s = swap(s, "  VAULT_AUDIENCE: vault.physalis.cloud\n", `  VAULT_AUDIENCE: ${q(v.audience)}\n`);
      s = swap(s, "  VAULT_PROJECT: physalis\n", `  VAULT_PROJECT: ${q(v.project)}\n`);
      s = swap(s, "  VAULT_ENV: main\n", `  VAULT_ENV: ${q(v.env)}\n`);
      s = swap(s, "    branches: [main]\n", `    branches: [${q(v.branch)}]\n`);
      return s;

    case "redeploy": {
      s = swap(s, "  VAULT_URL: https://vault.physalis.cloud\n", `  VAULT_URL: ${q(v.url)}\n`);
      s = swap(s, "  VAULT_AUDIENCE: vault.physalis.cloud\n", `  VAULT_AUDIENCE: ${q(v.audience)}\n`);
      s = swap(s, "  VAULT_PROJECT: physalis\n", `  VAULT_PROJECT: ${q(v.project)}\n`);
      const options = v.envOptions.includes(v.env) ? v.envOptions : [v.env, ...v.envOptions];
      s = swap(
        s,
        "        default: 'main'\n        type: choice\n        options:\n          - main\n          - production\n          - staging\n",
        `        default: ${q(v.env)}\n        type: choice\n        options:\n${options
          .map((o) => `          - ${q(o)}\n`)
          .join("")}`,
      );
      return s;
    }

    case "gitlab":
      s = swap(s, '  VAULT_URL: "https://vault.physalis.cloud"\n', `  VAULT_URL: ${q(v.url)}\n`);
      s = swap(s, '  VAULT_AUDIENCE: "vault.physalis.cloud"\n', `  VAULT_AUDIENCE: ${q(v.audience)}\n`);
      s = swap(s, '  VAULT_PROJECT: "voyages"\n', `  VAULT_PROJECT: ${q(v.project)}\n`);
      s = swap(s, '  VAULT_ENV: "production"\n', `  VAULT_ENV: ${q(v.env)}\n`);
      // `environment: name:` devient le claim OIDC `environment` = Policy.workflow.
      s = swap(
        s,
        "  environment:\n    name: production\n",
        `  environment:\n    name: ${v.workflow ? q(v.workflow) : "production"}\n`,
      );
      s = swap(
        s,
        `    - if: '$CI_COMMIT_BRANCH == "main"'\n`,
        `    - if: '$CI_COMMIT_BRANCH == "${v.branch}"'\n`,
      );
      return s;

    case "bitbucket":
      // Défauts shell, présents dans `script` ET dans `after-script`.
      s = swap(s, "${VAULT_URL:-https://vault.physalis.cloud}", `\${VAULT_URL:-${v.url}}`, 2);
      s = swap(s, "${VAULT_PROJECT:-voyages}", `\${VAULT_PROJECT:-${v.project}}`, 2);
      s = swap(s, "${VAULT_ENV:-production}", `\${VAULT_ENV:-${v.env}}`, 2);
      // `deployment:` devient le claim `deploymentEnvironment` = Policy.workflow.
      s = swap(
        s,
        "        deployment: production\n",
        `        deployment: ${v.workflow ? q(v.workflow) : "production"}\n`,
      );
      s = swap(s, "    main:\n      - step: *deploy", `    ${q(v.branch)}:\n      - step: *deploy`);
      return s;
  }
}

/** Fichier qu'une policy désigne dans le dépôt, selon le fournisseur. GitHub :
 *  le nom du fichier EST le claim `workflow` de la policy ; GitLab/Bitbucket :
 *  un fichier unique à la racine (le claim est l'environment CI). */
export function policyWorkflowPath(provider: string, workflow: string): string {
  if (provider === "gitlab") return ".gitlab-ci.yml";
  if (provider === "bitbucket") return "bitbucket-pipelines.yml";
  return `.github/workflows/${workflow}`;
}

/** Chemin du fichier dans le dépôt du client. */
export function templateTargetPath(id: TemplateId, workflow: string): string {
  if (id === "gitlab") return ".gitlab-ci.yml";
  if (id === "bitbucket") return "bitbucket-pipelines.yml";
  // GitHub : le nom du fichier EST le claim `workflow` de la policy.
  return `.github/workflows/${workflow}`;
}

export async function loadTemplateSource(id: TemplateId): Promise<string> {
  return readFile(path.join(process.cwd(), "docs", WORKFLOW_TEMPLATES[id].file), "utf8");
}
