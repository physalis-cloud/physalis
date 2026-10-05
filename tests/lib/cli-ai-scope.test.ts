// C-0050 (agent-ssh), phase 2d — périmètre d'une session « agent IA ».
// Le parcours HTTP (approbation, lecture, refus) est prouvé par
// tests/integ/cli-session.

import { describe, it, expect } from "vitest";
import { parseAiScope, aiScopeAllows } from "@/lib/cli-ai-scope";

const SCOPE = {
  projects: [{ projectId: "p1", slug: "site", environments: ["development", "test"] }],
};

describe("parseAiScope — un périmètre stocké mal formé vaut un refus", () => {
  it("relit un périmètre valide", () => {
    expect(parseAiScope(SCOPE)).toEqual(SCOPE);
  });

  it("rend null pour tout ce qui n'a pas la forme attendue", () => {
    for (const bad of [null, undefined, "x", {}, { projects: "x" }, { projects: [{ projectId: 1 }] },
      { projects: [{ projectId: "p", slug: "s", environments: [1] }] }]) {
      expect(parseAiScope(bad)).toBeNull();
    }
  });
});

describe("aiScopeAllows", () => {
  it("ouvre exactement les couples cochés", () => {
    expect(aiScopeAllows(SCOPE, "p1", "development")).toBe(true);
    expect(aiScopeAllows(SCOPE, "p1", "test")).toBe(true);
    expect(aiScopeAllows(SCOPE, "p1", "sandbox")).toBe(false);
    expect(aiScopeAllows(SCOPE, "p2", "development")).toBe(false);
  });

  it("refuse la production même si un périmètre forgé la contient", () => {
    const forged = { projects: [{ projectId: "p1", slug: "site", environments: ["production", "staging"] }] };
    expect(aiScopeAllows(forged, "p1", "production")).toBe(false);
    expect(aiScopeAllows(forged, "p1", "staging")).toBe(false);
  });

  it("sans périmètre, rien n'est ouvert", () => {
    expect(aiScopeAllows(null, "p1", "development")).toBe(false);
    expect(aiScopeAllows({ projects: [] }, "p1", "development")).toBe(false);
  });
});
