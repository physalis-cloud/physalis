// Dépôt GitHub par défaut (C-0051, retour utilisateur du 2026-10-03) :
// `<utilisateur registry de la connexion>/<slug du projet>`.

import { describe, it, expect } from "vitest";
import { encrypt } from "@/lib/crypto";
import { connectionRegistryOwner, defaultGithubRepo } from "@/lib/repo-default";
import { computeSetupState } from "@/lib/project-setup";

describe("defaultGithubRepo", () => {
  it("owner/slug", () => {
    expect(defaultGithubRepo("argo-web", "mon-app")).toBe("argo-web/mon-app");
    expect(defaultGithubRepo(" argo-web ", "mon-app")).toBe("argo-web/mon-app");
  });

  it("refuse un owner qui n'est pas un nom de compte GitHub", () => {
    for (const bad of [null, "", "a/b", "-x", "x-", "a b", "é", "x".repeat(40)]) {
      expect(defaultGithubRepo(bad, "mon-app")).toBeNull();
    }
  });
});

describe("connectionRegistryOwner", () => {
  const secret = encrypt("argo-web");
  const db = (row: unknown) => {
    const calls: unknown[] = [];
    return {
      calls,
      ciConnection: {
        findFirst: async (args: unknown) => {
          calls.push(args);
          return row;
        },
      },
    };
  };

  it("déchiffre l'utilisateur registry", async () => {
    expect(await connectionRegistryOwner(db({ secrets: [secret] }), "c1", "o1")).toBe("argo-web");
  });

  it("bornée à l'organisation et aux connexions GitHub", async () => {
    const d = db(null);
    expect(await connectionRegistryOwner(d, "c1", "o1")).toBeNull();
    expect(d.calls[0]).toMatchObject({
      where: { id: "c1", organizationId: "o1", provider: "github" },
    });
  });

  it("sans secret registry → null", async () => {
    expect(await connectionRegistryOwner(db({ secrets: [] }), "c1", "o1")).toBeNull();
  });
});

describe("étape « dépôt » et vérification d'existence", () => {
  const db = (githubRepo: string | null) => ({
    project: {
      findUnique: async () => ({
        githubRepo,
        ciRepo: null,
        ciConnectionId: "c1",
        ciConnection: { provider: "github" },
        setupCompletedAt: null,
        setupGuide: null,
        setupLegacy: false,
        environments: [],
        policies: [],
      }),
    },
    deployment: { findFirst: async () => null },
  });
  const repoStep = async (repo: string | null, checks = {}) =>
    (await computeSetupState(db(repo), "p1", checks))!;

  it("dépôt introuvable (verdict net) → étape à faire", async () => {
    const s = await repoStep("acme/app", { repoExists: "no" });
    expect(s.steps.find((x) => x.id === "repo")?.status).toBe("todo");
    expect(s.repoExists).toBe("no");
  });

  it("existence inconnue (pas de jeton) → ne bloque pas", async () => {
    const s = await repoStep("acme/app", { repoExists: "unknown" });
    expect(s.steps.find((x) => x.id === "repo")?.status).toBe("done");
  });

  it("sans dépôt : le dépôt par défaut est proposé, l'étape reste à faire", async () => {
    const s = await repoStep(null, { defaultRepo: { repo: "argo-web/app", exists: "yes" } });
    expect(s.steps.find((x) => x.id === "repo")?.status).toBe("todo");
    expect(s.defaultRepo).toEqual({ repo: "argo-web/app", exists: "yes" });
    expect(s.repoExists).toBeNull();
  });

  it("avec un dépôt renseigné, aucun défaut n'est proposé", async () => {
    const s = await repoStep("acme/app", { defaultRepo: { repo: "x/y", exists: "yes" } });
    expect(s.defaultRepo).toBeNull();
  });
});
