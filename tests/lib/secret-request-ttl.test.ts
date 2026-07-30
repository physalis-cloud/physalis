// #5 — expiration configurable des demandes externes (SecretRequest).
// Le TTL demandé par le client est borné côté serveur à une allowlist.

import { describe, it, expect } from "vitest";
import {
  resolveSecretRequestTtlMs,
  SECRET_REQUEST_TTL_MS,
  SECRET_REQUEST_TTL_OPTIONS_HOURS,
} from "@/lib/secret-request";

const H = 60 * 60 * 1000;

describe("resolveSecretRequestTtlMs (#5)", () => {
  it("undefined / null → défaut 48h", () => {
    expect(resolveSecretRequestTtlMs(undefined)).toBe(SECRET_REQUEST_TTL_MS);
    expect(resolveSecretRequestTtlMs(null)).toBe(SECRET_REQUEST_TTL_MS);
    expect(SECRET_REQUEST_TTL_MS).toBe(48 * H);
  });

  it("chaque option de l'allowlist → ses ms", () => {
    for (const h of SECRET_REQUEST_TTL_OPTIONS_HOURS) {
      expect(resolveSecretRequestTtlMs(h)).toBe(h * H);
    }
    expect(resolveSecretRequestTtlMs(1)).toBe(H);
    expect(resolveSecretRequestTtlMs(168)).toBe(168 * H);
  });

  it("valeur hors allowlist → null (rejet 400)", () => {
    for (const bad of [0, 5, 2, 72, 169, -1, 999]) {
      expect(resolveSecretRequestTtlMs(bad)).toBeNull();
    }
  });

  it("type non-numérique → null (pas de TTL forgé)", () => {
    for (const bad of ["48", "168", true, {}, [], NaN]) {
      expect(resolveSecretRequestTtlMs(bad)).toBeNull();
    }
  });
});
