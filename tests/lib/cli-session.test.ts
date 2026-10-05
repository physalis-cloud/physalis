// C-0050 (agent-ssh), phase 2 — fonctions pures de lib/cli-session.ts.
// Le parcours complet (base, révocation) est prouvé par tests/integ/cli-session.

import { describe, it, expect } from "vitest";
import {
  CLI_SESSION_TTL_SECONDS,
  generateCliToken,
  hashCliToken,
  isCliTokenFormat,
  generateDeviceCode,
  generateUserCode,
  normalizeUserCode,
} from "@/lib/cli-session";

describe("jeton sv_cli_", () => {
  it("a le préfixe et 64 hex, et se distingue d'un sv_ ou d'un sv_plugin_", () => {
    const t = generateCliToken();
    expect(isCliTokenFormat(t)).toBe(true);
    expect(isCliTokenFormat("sv_" + "a".repeat(64))).toBe(false);
    expect(isCliTokenFormat("sv_plugin_" + "a".repeat(64))).toBe(false);
    expect(isCliTokenFormat(t + "0")).toBe(false);
  });

  it("deux jetons diffèrent ; le hash est un SHA-256 hex stable", () => {
    const a = generateCliToken();
    expect(generateCliToken()).not.toBe(a);
    expect(hashCliToken(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashCliToken(a)).toBe(hashCliToken(a));
  });

  it("dure 12 h (scénario S3 : une approbation par jour)", () => {
    expect(CLI_SESSION_TTL_SECONDS).toBe(43200);
  });
});

describe("codes du flux d'appareil", () => {
  it("le code appareil fait 64 hex (c'est lui que la route poll accepte)", () => {
    expect(generateDeviceCode()).toMatch(/^[0-9a-f]{64}$/);
  });

  it("le code court n'a ni voyelle ni caractère ambigu", () => {
    for (let i = 0; i < 200; i++) {
      expect(generateUserCode()).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
    }
  });

  it("la saisie est normalisée : casse, espaces, tiret", () => {
    expect(normalizeUserCode("bcdf-ghjk")).toBe("BCDF-GHJK");
    expect(normalizeUserCode(" bcdf ghjk ")).toBe("BCDF-GHJK");
    expect(normalizeUserCode("BCDFGHJK")).toBe("BCDF-GHJK");
  });

  it("refuse ce qui ne peut pas être un code", () => {
    expect(normalizeUserCode("BCDF-GHJ")).toBeNull();
    expect(normalizeUserCode("AEIO-UBCD")).toBeNull();
    expect(normalizeUserCode("BCDF-GHJ1")).toBeNull();
    expect(normalizeUserCode(undefined)).toBeNull();
    expect(normalizeUserCode(12345678)).toBeNull();
  });
});
