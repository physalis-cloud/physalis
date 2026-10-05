// Onglet « Installation » (C-0051, Phase 4) — lib/project-setup.ts.
// Chaque étape est un test sur l'état réel : on vérifie ici la règle de chacune.

import { describe, it, expect } from "vitest";
import {
  computeSetupState,
  isSetupTabVisible,
  isValidSetupGuide,
} from "@/lib/project-setup";

type Over = Partial<{
  ciConnectionId: string | null;
  provider: string;
  githubRepo: string | null;
  ciRepo: string | null;
  envs: { name: string; serverId: string | null; secrets: number }[];
  policies: { id?: string; workflow: string; branch: string; environment: string | null }[];
  setupCompletedAt: Date | null;
  setupGuide: string | null;
  setupLegacy: boolean;
  last: { status: string } | null;
}>;

function db(o: Over = {}) {
  const project = {
    githubRepo: "githubRepo" in o ? o.githubRepo : "acme/app",
    ciRepo: o.ciRepo ?? null,
    ciConnectionId: "ciConnectionId" in o ? o.ciConnectionId : "c1",
    ciConnection: { provider: o.provider ?? "github" },
    setupCompletedAt: o.setupCompletedAt ?? null,
    setupGuide: o.setupGuide ?? null,
    setupLegacy: o.setupLegacy ?? false,
    environments: (o.envs ?? [{ name: "production", serverId: "s1", secrets: 3 }]).map((e) => ({
      name: e.name,
      serverId: e.serverId,
      _count: { secrets: e.secrets },
    })),
    policies: (
      o.policies ?? [{ workflow: "deploy.yml", branch: "main", environment: "production" }]
    ).map((p, i) => ({
      id: p.id ?? `pol${i}`,
      workflow: p.workflow,
      branch: p.branch,
      environment: p.environment ? { name: p.environment } : null,
    })),
  };
  const last =
    o.last === undefined || o.last === null
      ? null
      : {
          status: o.last.status,
          authorizedAt: new Date("2026-10-03T10:00:00Z"),
          createdAt: new Date("2026-10-03T10:00:00Z"),
          environment: { name: "production" },
        };
  return {
    project: { findUnique: async () => project },
    deployment: { findFirst: async () => last },
  };
}

const status = async (o: Over, checks = {}) => {
  const s = await computeSetupState(db(o), "p1", checks);
  return Object.fromEntries(s!.steps.map((x) => [x.id, x.status]));
};

describe("computeSetupState", () => {
  it("projet neuf : tout est à faire, secrets conseillés, workflow invérifiable", async () => {
    expect(
      await status({
        ciConnectionId: null,
        githubRepo: null,
        envs: [{ name: "production", serverId: null, secrets: 0 }],
        policies: [],
      }),
    ).toEqual({
      connection: "todo",
      repo: "todo",
      server: "todo",
      secrets: "optional",
      policy: "todo",
      workflow: "manual",
      firstCall: "todo",
      firstSuccess: "todo",
    });
  });

  it("configuration complète, en attente du premier appel", async () => {
    expect(await status({})).toMatchObject({
      connection: "done",
      repo: "done",
      server: "done",
      secrets: "done",
      policy: "done",
      workflow: "manual",
      firstCall: "todo",
    });
  });

  it("le dépôt se lit selon le provider (ciRepo hors GitHub)", async () => {
    expect((await status({ provider: "gitlab", ciRepo: null })).repo).toBe("todo");
    expect((await status({ provider: "gitlab", ciRepo: "grp/app" })).repo).toBe("done");
  });

  it("une policy vers un environnement SANS serveur ne compte pas", async () => {
    const s = await status({
      envs: [
        { name: "production", serverId: "s1", secrets: 1 },
        { name: "staging", serverId: null, secrets: 1 },
      ],
      policies: [{ workflow: "deploy.yml", branch: "main", environment: "staging" }],
    });
    expect(s.policy).toBe("todo");
  });

  it("un premier appel valide le workflow ET le premier appel", async () => {
    expect(await status({ last: { status: "requested" } })).toMatchObject({
      workflow: "done",
      firstCall: "done",
      firstSuccess: "todo",
    });
  });

  describe("étape « workflow » : le fichier de CHAQUE policy, sur SA branche", () => {
    const two = {
      envs: [
        { name: "production", serverId: "s1", secrets: 1 },
        { name: "staging", serverId: "s2", secrets: 1 },
      ],
      policies: [
        { id: "a", workflow: "cd.yml", branch: "release", environment: "production" },
        { id: "b", workflow: "deploy.yml", branch: "main", environment: "staging" },
      ],
    };
    const file = (
      status: "found" | "absent" | "unreadable",
      hasReport: boolean | null = null,
    ) => ({ status, hasReport });

    it("un fichier trouvé suffit", async () => {
      expect(
        (await status(two, { workflowFiles: { a: file("absent"), b: file("found", true) } }))
          .workflow,
      ).toBe("done");
    });

    it("tous absents → à faire", async () => {
      expect(
        (await status(two, { workflowFiles: { a: file("absent"), b: file("absent") } })).workflow,
      ).toBe("todo");
    });

    it("illisible (pas de jeton) → à vérifier de son côté", async () => {
      expect(
        (await status(two, { workflowFiles: { a: file("absent"), b: file("unreadable") } }))
          .workflow,
      ).toBe("manual");
    });

    it("une policy vers un env sans serveur ne compte pas", async () => {
      const o = {
        ...two,
        envs: [
          { name: "production", serverId: "s1", secrets: 1 },
          { name: "staging", serverId: null, secrets: 1 },
        ],
      };
      expect(
        (await status(o, { workflowFiles: { a: file("absent"), b: file("found") } })).workflow,
      ).toBe("todo");
    });

    it("le dernier run de chaque policy est exposé (étape « Lancer le workflow »)", async () => {
      const run = { state: "failure" as const, url: "https://github.com/a/b/actions/runs/1", at: null };
      const s = await computeSetupState(db(two), "p1", { lastRuns: { b: run } });
      expect(s!.policies.map((p) => p.lastRun)).toEqual([null, run]);
      // Un run échoué chez la plateforme ne valide pas le premier appel.
      expect(s!.steps.find((x) => x.id === "firstCall")?.status).toBe("todo");
    });

    it("le résultat est exposé par policy", async () => {
      const s = await computeSetupState(db(two), "p1", {
        workflowFiles: { a: file("found", false) },
      });
      expect(s!.policies.map((p) => p.file)).toEqual([file("found", false), null]);
    });
  });

  it("setupCompletedAt ferme la dernière étape", async () => {
    expect(
      (await status({ last: { status: "succeeded" }, setupCompletedAt: new Date() }))
        .firstSuccess,
    ).toBe("done");
  });

  it("expose les valeurs à recopier à l'identique dans le workflow", async () => {
    const s = await computeSetupState(db({ setupLegacy: true }), "p1");
    expect(s).toMatchObject({
      provider: "github",
      legacy: true,
      repo: "acme/app",
      policies: [
        { id: "pol0", workflow: "deploy.yml", branch: "main", environment: "production", file: null },
      ],
      deployableEnvs: ["production"],
    });
  });

  it("projet introuvable → null", async () => {
    const empty = {
      project: { findUnique: async () => null },
      deployment: { findFirst: async () => null },
    };
    expect(await computeSetupState(empty, "nope")).toBeNull();
  });
});

describe("isSetupTabVisible (§4.1)", () => {
  const done = new Date();
  it.each([
    [null, null, true],
    [null, done, false],
    ["shown", done, true],
    ["shown", null, true],
    ["hidden", null, false],
    ["hidden", done, false],
  ] as const)("setupGuide=%s, completed=%s → %s", (guide, completed, visible) => {
    expect(isSetupTabVisible({ setupGuide: guide, setupCompletedAt: completed })).toBe(visible);
  });
});

describe("isValidSetupGuide", () => {
  it("null, shown, hidden seulement", () => {
    expect(isValidSetupGuide(null)).toBe(true);
    expect(isValidSetupGuide("shown")).toBe(true);
    expect(isValidSetupGuide("hidden")).toBe(true);
    expect(isValidSetupGuide("auto")).toBe(false);
    expect(isValidSetupGuide(undefined)).toBe(false);
    expect(isValidSetupGuide(1)).toBe(false);
  });
});
