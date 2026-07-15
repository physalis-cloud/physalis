import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  isKmsConfigured,
  kmsKeyNameForTenant,
  provisionTenantKey,
  issueAgentSecretId,
  getRestoreToken,
} from "../../lib/kms";

// Surface déterministe uniquement (pas d'appel réseau OpenBao) : nommage des
// clés, gating de configuration, validation stricte du slug.

const SAVED = { ...process.env };

beforeAll(() => {
  // CA présente pour tout le fichier (caPem() est mis en cache au 1ᵉʳ appel).
  process.env.OPENBAO_CACERT_PEM = "-----BEGIN CERTIFICATE-----\\nTEST\\n-----END CERTIFICATE-----";
});

afterAll(() => {
  process.env = { ...SAVED };
});

describe("kmsKeyNameForTenant", () => {
  it("préfixe le slug par tenant-", () => {
    expect(kmsKeyNameForTenant("argoweb")).toBe("tenant-argoweb");
  });
});

describe("isKmsConfigured", () => {
  it("vrai quand addr + admin role/secret + CA sont présents", () => {
    process.env.OPENBAO_ADDR = "https://kms.example:8200";
    process.env.OPENBAO_ADMIN_ROLE_ID = "role-id";
    process.env.OPENBAO_ADMIN_SECRET_ID = "secret-id";
    expect(isKmsConfigured()).toBe(true);
  });

  it("faux si une variable requise manque (dual-path → reste en GPG)", () => {
    process.env.OPENBAO_ADDR = "https://kms.example:8200";
    process.env.OPENBAO_ADMIN_ROLE_ID = "role-id";
    delete process.env.OPENBAO_ADMIN_SECRET_ID;
    expect(isKmsConfigured()).toBe(false);
  });
});

describe("validation du slug (avant tout appel réseau)", () => {
  const bad = ["", "Bad_Slug", "a/b", "-lead", "x".repeat(64), "Évil"];
  for (const slug of bad) {
    it(`rejette « ${slug} »`, async () => {
      await expect(provisionTenantKey(slug)).rejects.toThrow(/slug tenant invalide/);
      await expect(issueAgentSecretId(slug)).rejects.toThrow(/slug tenant invalide/);
      await expect(getRestoreToken(slug)).rejects.toThrow(/slug tenant invalide/);
    });
  }
});
