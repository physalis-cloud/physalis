// Modèles de workflow pré-remplis (C-0051, Phase 5) — lib/workflow-templates.ts.
//
// Rendu sur les VRAIS fichiers docs/*.modele.yml : si un modèle change sans que
// le module suive, un marqueur manque et ce test casse ici, pas en production.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import yaml from "js-yaml";
import {
  TemplateDriftError,
  WORKFLOW_TEMPLATES,
  renderTemplate,
  templateTargetPath,
  templatesForProvider,
  type TemplateId,
} from "@/lib/workflow-templates";
import { extractReportSnippet } from "@/lib/project-verify";

const ROOT = resolve(__dirname, "../..");
const source = (id: TemplateId) =>
  readFileSync(resolve(ROOT, "docs", WORKFLOW_TEMPLATES[id].file), "utf8");

const values = {
  url: "https://staging.vault.example",
  audience: "staging.vault.example",
  project: "mon-app",
  env: "preprod",
  branch: "release/2026",
  workflow: "cd.yml",
  envOptions: ["preprod", "production"],
};

const render = (id: TemplateId, over: Partial<typeof values> = {}) =>
  renderTemplate(id, source(id), { ...values, ...over });

describe("rendu des modèles réels", () => {
  it.each(Object.keys(WORKFLOW_TEMPLATES) as TemplateId[])(
    "%s : YAML valide, plus aucune valeur d'exemple",
    (id) => {
      const out = render(id, id === "deploy" || id === "redeploy" ? {} : { workflow: "Staging" });
      expect(() => yaml.load(out)).not.toThrow();
      // Les commentaires citent les valeurs d'exemple : seul le code compte.
      const code = out
        .split("\n")
        .filter((l) => !/^\s*#/.test(l))
        .join("\n");
      expect(code).not.toContain("vault.physalis.cloud");
      expect(code).not.toMatch(/\b(voyages|VAULT_PROJECT: physalis)\b/);
      expect(out).toContain("staging.vault.example");
      expect(out).toContain("mon-app");
    },
  );

  it("deploy : env, branche de déclenchement", () => {
    const doc = yaml.load(render("deploy")) as {
      on: { push: { branches: string[] } };
      env: Record<string, string>;
    };
    expect(doc.env).toMatchObject({
      VAULT_URL: values.url,
      VAULT_AUDIENCE: values.audience,
      VAULT_PROJECT: "mon-app",
      VAULT_ENV: "preprod",
    });
    expect(doc.on.push.branches).toEqual(["release/2026"]);
  });

  it("redeploy : les environnements du projet en choix, celui de la policy par défaut", () => {
    const doc = yaml.load(render("redeploy", { envOptions: ["production"] })) as {
      on: { workflow_dispatch: { inputs: { environment: { default: string; options: string[] } } } };
    };
    expect(doc.on.workflow_dispatch.inputs.environment).toMatchObject({
      default: "preprod",
      options: ["preprod", "production"],
    });
  });

  it("gitlab : environment CI = Policy.workflow, règle de branche", () => {
    const out = render("gitlab", { workflow: "Staging" });
    const doc = yaml.load(out) as { deploy: { environment: { name: string } } };
    expect(doc.deploy.environment.name).toBe("Staging");
    expect(out).toContain(`'$CI_COMMIT_BRANCH == "release/2026"'`);
  });

  it("bitbucket : défauts shell dans script ET after-script, deployment, branche", () => {
    const out = render("bitbucket", { workflow: "Staging" });
    expect(out.match(/\$\{VAULT_URL:-https:\/\/staging\.vault\.example\}/g)).toHaveLength(2);
    expect(out.match(/\$\{VAULT_PROJECT:-mon-app\}/g)).toHaveLength(2);
    const doc = yaml.load(out) as { pipelines: { branches: Record<string, unknown> } };
    expect(Object.keys(doc.pipelines.branches)).toEqual(["release/2026"]);
    expect(out).toContain('deployment: "Staging"');
  });

  it("policy GitLab/Bitbucket sans environment CI : on garde la valeur du modèle", () => {
    expect(render("gitlab", { workflow: "" })).toContain("    name: production\n");
    expect(render("bitbucket", { workflow: "" })).toContain("deployment: production\n");
  });
});

describe("garde-fous", () => {
  it("refuse toute valeur hors du jeu de caractères fermé (YAML + shell)", () => {
    for (const bad of ['a"b', "a b", "$(id)", "a`b", "a;b", "a\nb", ""]) {
      expect(() => render("bitbucket", { project: bad })).toThrow(TemplateDriftError);
    }
    expect(() => render("deploy", { workflow: "" })).toThrow(TemplateDriftError);
  });

  it("un marqueur absent (modèle modifié) → refus, pas de rendu partiel", () => {
    expect(() =>
      renderTemplate("deploy", source("deploy").replace("    branches: [main]\n", ""), values),
    ).toThrow(TemplateDriftError);
  });
});

describe("chemins et fournisseurs", () => {
  it("le fichier GitHub porte le nom déclaré dans la policy", () => {
    expect(templateTargetPath("deploy", "cd.yml")).toBe(".github/workflows/cd.yml");
    expect(templateTargetPath("gitlab", "x")).toBe(".gitlab-ci.yml");
    expect(templateTargetPath("bitbucket", "x")).toBe("bitbucket-pipelines.yml");
  });

  it("modèles par fournisseur", () => {
    expect(templatesForProvider("github")).toEqual(["deploy", "redeploy"]);
    expect(templatesForProvider("gitlab")).toEqual(["gitlab"]);
    expect(templatesForProvider("bitbucket")).toEqual(["bitbucket"]);
  });
});

// Les modèles sont lus AU RUNTIME alors que `docs/` est exclu du contexte
// Docker : sans ces trois verrous, la route répond 500 en prod et rien ne le
// voit en local (mémoire vault-dockerignore-docs-allowlist).
describe("les modèles atteignent l'image", () => {
  const read = (rel: string) => readFileSync(resolve(ROOT, rel), "utf8");

  it(".dockerignore les ré-inclut", () => {
    expect(read(".dockerignore")).toMatch(/^!docs\/\*\.modele\.yml$/m);
  });

  it("le Dockerfile SaaS les copie", () => {
    expect(read("Dockerfile")).toContain("COPY --chown=nextjs:nodejs docs/*.modele.yml ./docs/");
  });

  it.each(["template", "verify"])(
    "next.config les trace pour la route setup/%s (build self-host)",
    (route) => {
      expect(read("next.config.ts")).toContain(
        `"/api/projects/[slug]/setup/${route}": ["./docs/*.modele.yml"]`,
      );
    },
  );
});

// Projets antérieurs au guide (Phase 4 bis) : l'étape à ajouter est extraite du
// modèle PUBLIÉ, jamais recopiée — on vérifie qu'elle s'y trouve bien.
describe("extractReportSnippet", () => {
  it.each([
    ["redeploy", "if: always()", "uses: actions/github-script@v7"],
    ["gitlab", "CI_JOB_STATUS", "after_script"],
    ["bitbucket", "BITBUCKET_EXIT_CODE", "after-script:"],
  ] as const)("%s : l'étape de rapport complète", (id, a, b) => {
    const snippet = extractReportSnippet(id, source(id));
    expect(snippet).not.toBeNull();
    expect(snippet).toContain("/api/deploy/report");
    expect(snippet).toContain(a);
    expect(snippet!.startsWith("  ") || id === "bitbucket").toBe(true);
    expect(snippet).not.toContain("pipelines:");
    // Ne déborde pas sur ce qui précède le commentaire d'ouverture.
    expect(snippet!.trimStart().startsWith("# ── Rapport à Physalis")).toBe(true);
    expect(snippet).toContain(b);
  });

  it("sans étape de rapport → null", () => {
    expect(extractReportSnippet("gitlab", "stages:\n  - deploy\n")).toBeNull();
  });
});
