import { describe, it, expect } from "vitest";
import {
  DEV_TOKEN_CONSTRAINTS,
  orgTokenAccessLevel,
  validateDevTokenCreation,
} from "@/lib/org-token-rbac";

describe("lib/org-token-rbac — orgTokenAccessLevel", () => {
  it("OWNER → admin", () => {
    expect(orgTokenAccessLevel("OWNER")).toBe("admin");
  });

  it("ADMIN → admin", () => {
    expect(orgTokenAccessLevel("ADMIN")).toBe("admin");
  });

  it("DEV → dev", () => {
    expect(orgTokenAccessLevel("DEV")).toBe("dev");
  });

  it("MEMBER → denied", () => {
    expect(orgTokenAccessLevel("MEMBER")).toBe("denied");
  });
});

describe("lib/org-token-rbac — validateDevTokenCreation", () => {
  const baseValid = {
    allProjects: false,
    allowedProjectIds: ["p1", "p2"],
    expiresInDays: 30,
    scopes: ["SECRETS_READ" as const],
    devMemberProjectIds: ["p1", "p2", "p3"],
  };

  it("valide les params corrects", () => {
    expect(validateDevTokenCreation(baseValid)).toBe(null);
  });

  it("rejette allProjects=true", () => {
    const r = validateDevTokenCreation({ ...baseValid, allProjects: true });
    expect(r?.code).toBe(403);
    expect(r?.error).toMatch(/all projects/i);
  });

  it("rejette expiration null", () => {
    const r = validateDevTokenCreation({ ...baseValid, expiresInDays: null });
    expect(r?.code).toBe(400);
    expect(r?.error).toMatch(/expiration/i);
  });

  it("rejette expiration undefined", () => {
    const r = validateDevTokenCreation({ ...baseValid, expiresInDays: undefined });
    expect(r?.code).toBe(400);
  });

  // Défense en profondeur : `expiresInDays` vient de `readJson` non typé. Une
  // valeur non-numérique satisfaisait `"abc" > 90` (= false) → contrainte
  // d'expiration contournée → token DEV éternel. cf. commit type-confusion.
  it("rejette une expiration non numérique (string)", () => {
    const r = validateDevTokenCreation({
      ...baseValid,
      // @ts-expect-error — simule une entrée readJson non validée
      expiresInDays: "abc",
    });
    expect(r?.code).toBe(400);
  });

  it("rejette une expiration booléenne", () => {
    const r = validateDevTokenCreation({
      ...baseValid,
      // @ts-expect-error — simule une entrée readJson non validée
      expiresInDays: true,
    });
    expect(r?.code).toBe(400);
  });

  it("rejette NaN / Infinity", () => {
    expect(validateDevTokenCreation({ ...baseValid, expiresInDays: NaN })?.code).toBe(400);
    expect(
      validateDevTokenCreation({ ...baseValid, expiresInDays: Infinity })?.code,
    ).toBe(400);
  });

  it("rejette expiration > maxExpiresInDays", () => {
    const r = validateDevTokenCreation({
      ...baseValid,
      expiresInDays: DEV_TOKEN_CONSTRAINTS.maxExpiresInDays + 1,
    });
    expect(r?.code).toBe(400);
    expect(r?.error).toMatch(/beyond/i);
  });

  it("accepte expiration = maxExpiresInDays exact", () => {
    expect(
      validateDevTokenCreation({
        ...baseValid,
        expiresInDays: DEV_TOKEN_CONSTRAINTS.maxExpiresInDays,
      }),
    ).toBe(null);
  });

  it("rejette allowedProjectIds vide", () => {
    const r = validateDevTokenCreation({
      ...baseValid,
      allowedProjectIds: [],
    });
    expect(r?.code).toBe(400);
  });

  it("rejette projet hors memberships", () => {
    const r = validateDevTokenCreation({
      ...baseValid,
      allowedProjectIds: ["p1", "p99"],
    });
    expect(r?.code).toBe(403);
    expect(r?.error).toMatch(/member/i);
  });

  it("accepte sous-ensemble strict des memberships", () => {
    expect(
      validateDevTokenCreation({
        ...baseValid,
        allowedProjectIds: ["p1"],
      }),
    ).toBe(null);
  });
});
