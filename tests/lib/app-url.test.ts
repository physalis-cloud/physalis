// Garde-fou de la chaîne de fallback de physalisBaseUrl : un changement de
// précédence casserait silencieusement l'URL donnée aux agents backup/rotation.
// La rétro-compat (fallback NEXTAUTH_URL tant que PHYSALIS_URL absente) est le
// point clé du chantier de découplage NEXTAUTH_URL ↔ agents (SSO multi-tenant).

import { describe, it, expect, beforeEach } from "vitest";
import { physalisBaseUrl, tenantBaseUrl } from "../../lib/app-url";

const KEYS = ["PHYSALIS_URL", "NEXTAUTH_URL", "AUTH_URL"] as const;

beforeEach(() => {
  for (const k of KEYS) delete process.env[k];
});

describe("physalisBaseUrl", () => {
  it("PHYSALIS_URL est prioritaire sur tout", () => {
    process.env.AUTH_URL = "https://auth";
    process.env.NEXTAUTH_URL = "https://nextauth";
    process.env.PHYSALIS_URL = "https://physalis";
    expect(physalisBaseUrl()).toBe("https://physalis");
  });

  it("retombe sur NEXTAUTH_URL si PHYSALIS_URL absente (rétro-compat)", () => {
    process.env.NEXTAUTH_URL = "https://nextauth";
    expect(physalisBaseUrl()).toBe("https://nextauth");
  });

  it("retombe sur AUTH_URL ensuite", () => {
    process.env.AUTH_URL = "https://auth";
    expect(physalisBaseUrl()).toBe("https://auth");
  });

  it("utilise le fallback paramètre si aucune variable", () => {
    expect(physalisBaseUrl()).toBe("http://localhost:3000");
    expect(physalisBaseUrl("")).toBe("");
  });

  it("retire le slash final", () => {
    process.env.PHYSALIS_URL = "https://x.example/";
    expect(physalisBaseUrl()).toBe("https://x.example");
  });

  // §2.11 — les liens embarqués dans un email partent vers une victime : leur
  // domaine doit venir du slug tenant (session authentifiée), jamais d'un
  // en-tête de requête que l'émetteur du mail contrôle.
  describe("tenantBaseUrl", () => {
    it("reconstruit l'origine du workspace depuis le slug", () => {
      expect(tenantBaseUrl("acme")).toBe("https://acme.physalis.cloud");
    });

    it("est insensible aux variables d'URL canonique", () => {
      process.env.PHYSALIS_URL = "https://evil.example";
      expect(tenantBaseUrl("acme")).toBe("https://acme.physalis.cloud");
    });

    it("retombe sur l'URL canonique en mono-tenant (slug null)", () => {
      process.env.PHYSALIS_URL = "https://vault.example";
      expect(tenantBaseUrl(null)).toBe("https://vault.example");
    });
  });
});
