// Garde-fou de la chaîne de fallback de physalisBaseUrl : un changement de
// précédence casserait silencieusement l'URL donnée aux agents backup/rotation.
// La rétro-compat (fallback NEXTAUTH_URL tant que PHYSALIS_URL absente) est le
// point clé du chantier de découplage NEXTAUTH_URL ↔ agents (SSO multi-tenant).

import { describe, it, expect, beforeEach } from "vitest";
import { estHoteSaaS, physalisBaseUrl, tenantBaseUrl } from "../../lib/app-url";

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

/**
 * ⚠️ **Ce que cette fonction decide n'est PAS un acces, c'est une PHRASE** :
 * l'app annoncait « Self-hosted secrets manager » dans l'apercu de chaque lien
 * de `vault.physalis.cloud`, qui est justement l'offre hebergee. Un faux
 * negatif remet cette phrase fausse ; un faux positif fait dire « heberge » a
 * une instance auto-hebergee. Aucun des deux n'ouvre quoi que ce soit — et ce
 * test existe pour que ca reste vrai le jour ou quelqu'un voudrait s'en servir
 * pour autoriser quelque chose.
 */
describe("estHoteSaaS", () => {
  it("reconnait le domaine du SaaS et ses sous-domaines", () => {
    expect(estHoteSaaS("physalis.cloud")).toBe(true);
    expect(estHoteSaaS("vault.physalis.cloud")).toBe(true);
    expect(estHoteSaaS("acme.physalis.cloud")).toBe(true);
  });

  it("dit NON a une instance auto-hebergee — le cas qui remet la bonne phrase", () => {
    expect(estHoteSaaS("secrets.exemple-client.fr")).toBe(false);
    expect(estHoteSaaS("localhost:3006")).toBe(false);
  });

  it("ne se laisse pas avoir par un domaine qui se TERMINE par le notre", () => {
    // ⚠️ `notphysalis.cloud` finit par `physalis.cloud` au sens des chaines :
    // c'est le point separateur qui fait la difference, et une comparaison
    // naive `includes` l'aurait accepte.
    expect(estHoteSaaS("notphysalis.cloud")).toBe(false);
    expect(estHoteSaaS("physalis.cloud.attaquant.fr")).toBe(false);
  });

  it("ignore le port et la casse", () => {
    expect(estHoteSaaS("VAULT.Physalis.Cloud:443")).toBe(true);
  });

  it("rend false sur un hote absent plutot que de lever", () => {
    // `headers().get()` rend `null` quand l'en-tete manque : la carte doit
    // rester affichable, pas planter le rendu de la page.
    expect(estHoteSaaS(null)).toBe(false);
    expect(estHoteSaaS(undefined)).toBe(false);
    expect(estHoteSaaS("")).toBe(false);
  });
});
