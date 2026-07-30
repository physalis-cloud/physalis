import { describe, it, expect, vi } from "vitest";
import {
  rateLimit,
  resetRateLimit,
  getClientIp,
  clientCidr,
  rateLimitKey,
} from "@/lib/rate-limit";

// Helper pour fabriquer une Request avec une IP simulée.
function makeReq(ip = "1.2.3.4"): Request {
  return new Request("http://test.local/", {
    headers: { "x-forwarded-for": ip },
  });
}

// Chaque test utilise un `scope` unique pour ne pas partager d'état avec
// d'autres tests (le module garde une Map au niveau module, fire-and-forget).
let scopeCounter = 0;
const uniqueScope = (label: string) => `${label}-${++scopeCounter}`;

describe("lib/rate-limit — fenêtre fixe in-memory", () => {
  describe("limite de base", () => {
    it("autorise jusqu'à `max` requêtes dans la fenêtre", () => {
      const scope = uniqueScope("basic");
      const opts = { max: 3, windowMs: 60_000 };
      const req = makeReq("10.0.0.1");
      expect(rateLimit(req, scope, opts)).toBeNull();
      expect(rateLimit(req, scope, opts)).toBeNull();
      expect(rateLimit(req, scope, opts)).toBeNull();
    });

    it("retourne 429 à partir de la `max + 1` requête", async () => {
      const scope = uniqueScope("excess");
      const opts = { max: 2, windowMs: 60_000 };
      const req = makeReq("10.0.0.2");
      rateLimit(req, scope, opts);
      rateLimit(req, scope, opts);
      const res = rateLimit(req, scope, opts);
      expect(res).not.toBeNull();
      expect(res!.status).toBe(429);
      const body = await res!.json();
      expect(body).toEqual({ error: "Too many requests" });
    });
  });

  describe("headers de la 429", () => {
    it("inclut Retry-After et X-RateLimit-*", () => {
      const scope = uniqueScope("headers");
      const opts = { max: 1, windowMs: 60_000 };
      const req = makeReq("10.0.0.3");
      rateLimit(req, scope, opts); // 1/1
      const res = rateLimit(req, scope, opts)!;
      expect(res.headers.get("Retry-After")).toMatch(/^\d+$/);
      expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
      expect(res.headers.get("X-RateLimit-Limit")).toBe("1");
      expect(res.headers.get("X-RateLimit-Remaining")).toBe("0");
      expect(res.headers.get("X-RateLimit-Reset")).toMatch(/^\d+$/);
    });
  });

  describe("isolation par IP", () => {
    it("deux IPs différentes ont des buckets séparés", () => {
      const scope = uniqueScope("ips");
      const opts = { max: 1, windowMs: 60_000 };
      const reqA = makeReq("10.0.0.10");
      const reqB = makeReq("10.0.0.11");
      expect(rateLimit(reqA, scope, opts)).toBeNull(); // OK pour A
      expect(rateLimit(reqA, scope, opts)).not.toBeNull(); // bloqué pour A
      expect(rateLimit(reqB, scope, opts)).toBeNull(); // OK pour B (bucket séparé)
    });
  });

  describe("isolation par scope", () => {
    it("deux scopes différents ont des buckets séparés", () => {
      const scopeA = uniqueScope("scope-a");
      const scopeB = uniqueScope("scope-b");
      const opts = { max: 1, windowMs: 60_000 };
      const req = makeReq("10.0.0.20");
      expect(rateLimit(req, scopeA, opts)).toBeNull();
      expect(rateLimit(req, scopeA, opts)).not.toBeNull();
      // Même IP mais scope différent → bucket frais.
      expect(rateLimit(req, scopeB, opts)).toBeNull();
    });
  });

  describe("identifier custom", () => {
    it("permet d'utiliser un identifier autre que l'IP", () => {
      const scope = uniqueScope("custom-id");
      const opts = { max: 1, windowMs: 60_000 };
      const req = makeReq("10.0.0.30");
      // Le 4ème arg force la clé du bucket, ignorant l'IP.
      expect(rateLimit(req, scope, opts, "user-A")).toBeNull();
      expect(rateLimit(req, scope, opts, "user-A")).not.toBeNull();
      // Même IP, identifier différent → bucket frais.
      expect(rateLimit(req, scope, opts, "user-B")).toBeNull();
    });
  });

  describe("expiration de la fenêtre", () => {
    it("après expiration, le bucket repart à zéro", async () => {
      const scope = uniqueScope("expiry");
      // Fenêtre courte mais assez large pour ne pas être flaky en CI.
      const opts = { max: 1, windowMs: 50 };
      const req = makeReq("10.0.0.40");
      expect(rateLimit(req, scope, opts)).toBeNull();
      expect(rateLimit(req, scope, opts)).not.toBeNull(); // dans la fenêtre
      // Attente asynchrone — 100 ms = 2× la fenêtre, large marge.
      await new Promise((r) => setTimeout(r, 100));
      expect(rateLimit(req, scope, opts)).toBeNull(); // nouvelle fenêtre
    });
  });

  describe("getClientIp", () => {
    // §2.10 — la chaîne XFF est lue par la DROITE. Les segments de gauche sont
    // fournis par l'appelant : les lire laissait n'importe qui choisir sa clé
    // de bucket et donc contourner le rate-limit du login.
    it("lit le dernier hop de x-forwarded-for (posé par notre proxy)", () => {
      const req = new Request("http://test.local/", {
        headers: { "x-forwarded-for": "203.0.113.5, 10.0.0.1" },
      });
      expect(getClientIp(req)).toBe("10.0.0.1");
    });

    it("ignore un XFF forgé par le client (proxy qui concatène)", () => {
      const forged = new Request("http://test.local/", {
        headers: { "x-forwarded-for": "1.1.1.1, 2.2.2.2, 198.51.100.7" },
      });
      const honest = new Request("http://test.local/", {
        headers: { "x-forwarded-for": "198.51.100.7" },
      });
      // Le même client réel tombe dans le même bucket, quoi qu'il préfixe.
      expect(getClientIp(forged)).toBe(getClientIp(honest));
    });

    it("gère le proxy qui écrase l'en-tête (NPM : un seul élément)", () => {
      const req = new Request("http://test.local/", {
        headers: { "x-forwarded-for": "198.51.100.7" },
      });
      expect(getClientIp(req)).toBe("198.51.100.7");
    });

    it("tolère les éléments vides et les espaces", () => {
      const req = new Request("http://test.local/", {
        headers: { "x-forwarded-for": "  1.1.1.1 ,, 198.51.100.7 ," },
      });
      expect(getClientIp(req)).toBe("198.51.100.7");
    });

    it("fallback sur x-real-ip si x-forwarded-for absent", () => {
      const req = new Request("http://test.local/", {
        headers: { "x-real-ip": "198.51.100.1" },
      });
      expect(getClientIp(req)).toBe("198.51.100.1");
    });

    it("retourne 'unknown' si aucun header IP", () => {
      const req = new Request("http://test.local/");
      expect(getClientIp(req)).toBe("unknown");
    });

    it("priorité x-forwarded-for sur x-real-ip", () => {
      const req = new Request("http://test.local/", {
        headers: {
          "x-forwarded-for": "1.1.1.1",
          "x-real-ip": "2.2.2.2",
        },
      });
      expect(getClientIp(req)).toBe("1.1.1.1");
    });

    it("TRUST_PROXY_HOPS=2 remonte de deux crans dans la chaîne", async () => {
      vi.resetModules();
      vi.stubEnv("TRUST_PROXY_HOPS", "2");
      // Le module lit l'env au chargement → réimport nécessaire.
      const { getClientIp: scoped } = await import("@/lib/rate-limit");
      const req = new Request("http://test.local/", {
        headers: { "x-forwarded-for": "1.1.1.1, 198.51.100.7, 10.0.0.1" },
      });
      expect(scoped(req)).toBe("198.51.100.7");
      vi.unstubAllEnvs();
      vi.resetModules();
    });

    it("une valeur TRUST_PROXY_HOPS invalide retombe sur 1 hop", async () => {
      vi.resetModules();
      vi.stubEnv("TRUST_PROXY_HOPS", "0"); // 0 ⇒ bucket global, refusé
      const { getClientIp: scoped } = await import("@/lib/rate-limit");
      const req = new Request("http://test.local/", {
        headers: { "x-forwarded-for": "1.1.1.1, 10.0.0.1" },
      });
      expect(scoped(req)).toBe("10.0.0.1");
      vi.unstubAllEnvs();
      vi.resetModules();
    });
  });

  // §16 — un client IPv6 dispose de tout son /64 (2⁶⁴ adresses) et les privacy
  // extensions font tourner l'identifiant d'interface toutes seules. Bucketiser
  // sur le /128 rendait l'étage IP contournable ET instable pour les légitimes.
  describe("rateLimitKey — normalisation IPv6 /64", () => {
    it("regroupe deux adresses du même /64", () => {
      const a = "2a01:e0a:14c9:7c00:3586:2fe5:7bb5:2989";
      const b = "2a01:e0a:14c9:7c00:dead:beef:1234:5678";
      expect(rateLimitKey(a)).toBe(rateLimitKey(b));
      expect(rateLimitKey(a)).toBe("2a01:e0a:14c9:7c00::/64");
    });

    it("sépare deux /64 distincts", () => {
      expect(rateLimitKey("2a01:e0a:14c9:7c00::1")).not.toBe(
        rateLimitKey("2a01:e0a:14c9:7c01::1"),
      );
    });

    it("canonicalise les écritures équivalentes d'un même préfixe", () => {
      // Sans canonicalisation, chacune de ces formes serait un bucket distinct
      // — donc un contournement gratuit du rate-limit.
      const forms = [
        "2a01:e0a:14c9:7c00:3586:2fe5:7bb5:2989",
        "2a01:0e0a:14c9:7c00:3586:2fe5:7bb5:2989",
        "2A01:E0A:14C9:7C00:3586:2FE5:7BB5:2989",
        "[2a01:e0a:14c9:7c00:3586:2fe5:7bb5:2989]",
        "  2a01:e0a:14c9:7c00:3586:2fe5:7bb5:2989  ",
      ];
      const keys = new Set(forms.map(rateLimitKey));
      expect(keys.size).toBe(1);
      expect([...keys][0]).toBe("2a01:e0a:14c9:7c00::/64");
    });

    it("gère la compression `::` et l'identifiant de zone", () => {
      expect(rateLimitKey("2a01:e0a::1")).toBe("2a01:e0a:0:0::/64");
      expect(rateLimitKey("::1")).toBe("0:0:0:0::/64");
      expect(rateLimitKey("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
    });

    it("laisse l'IPv4 et les valeurs illisibles intactes", () => {
      expect(rateLimitKey("203.0.113.5")).toBe("203.0.113.5");
      expect(rateLimitKey("::ffff:203.0.113.5")).toBe("::ffff:203.0.113.5");
      expect(rateLimitKey("unknown")).toBe("unknown");
      expect(rateLimitKey("2a01:e0a:zzzz:7c00::1")).toBe(
        "2a01:e0a:zzzz:7c00::1",
      );
    });

    it("bout en bout : rotation d'adresse dans un /64 ne réinitialise pas le bucket", () => {
      const scope = uniqueScope("v6");
      const opts = { max: 2, windowMs: 60_000 };
      const req = (suffix: string) =>
        new Request("http://test.local/", {
          headers: { "x-forwarded-for": `2a01:e0a:14c9:7c00::${suffix}` },
        });
      expect(rateLimit(req("1"), scope, opts)).toBeNull();
      expect(rateLimit(req("2"), scope, opts)).toBeNull();
      // 3e tentative depuis une adresse encore jamais vue, même /64 → bloquée.
      expect(rateLimit(req("3"), scope, opts)).not.toBeNull();
      // Un /64 voisin garde bien son propre bucket.
      const other = new Request("http://test.local/", {
        headers: { "x-forwarded-for": "2a01:e0a:14c9:7c01::1" },
      });
      expect(rateLimit(other, scope, opts)).toBeNull();
    });
  });

  describe("identifier explicite (bucket compte, §2.10)", () => {
    it("sépare les buckets de deux identités sur la même IP", () => {
      const scope = uniqueScope("acct");
      const opts = { max: 1, windowMs: 60_000 };
      const req = makeReq("10.0.0.9");
      expect(rateLimit(req, scope, opts, "tenantA:a@x.tld")).toBeNull();
      expect(rateLimit(req, scope, opts, "tenantA:a@x.tld")).not.toBeNull();
      // Autre compte, même IP → bucket intact.
      expect(rateLimit(req, scope, opts, "tenantA:b@x.tld")).toBeNull();
    });

    it("sépare le même email sur deux tenants", () => {
      const scope = uniqueScope("acct-tenant");
      const opts = { max: 1, windowMs: 60_000 };
      const req = makeReq("10.0.0.10");
      expect(rateLimit(req, scope, opts, "tenantA:a@x.tld")).toBeNull();
      expect(rateLimit(req, scope, opts, "tenantB:a@x.tld")).toBeNull();
    });

    it("resetRateLimit ne purge que le bucket visé", () => {
      const scope = uniqueScope("acct-reset");
      const opts = { max: 1, windowMs: 60_000 };
      const req = makeReq("10.0.0.11");
      rateLimit(req, scope, opts, "victim");
      rateLimit(req, scope, opts, "attacker");
      // L'attaquant purge le sien : celui de la victime doit survivre.
      resetRateLimit(req, scope, "attacker");
      expect(rateLimit(req, scope, opts, "attacker")).toBeNull();
      expect(rateLimit(req, scope, opts, "victim")).not.toBeNull();
    });

    it("fonctionne sans Request quand l'identifier est fourni", () => {
      const scope = uniqueScope("acct-noreq");
      const opts = { max: 1, windowMs: 60_000 };
      expect(rateLimit(undefined, scope, opts, "tenantA:a@x.tld")).toBeNull();
      expect(
        rateLimit(undefined, scope, opts, "tenantA:a@x.tld"),
      ).not.toBeNull();
    });
  });

  // §2.25b — CIDR /32 dérivé de l'IP de l'appelant pour `token_bound_cidrs`.
  // Ne borne que sur une IPv4 propre ; toute autre valeur → undefined (token
  // non borné plutôt qu'un cidr_list malformé qui casserait un restore légitime).
  describe("clientCidr", () => {
    it("dérive un /32 d'une IPv4 propre (dernier hop de confiance)", () => {
      const req = new Request("http://test.local/", {
        headers: { "x-forwarded-for": "203.0.113.9" },
      });
      expect(clientCidr(req)).toBe("203.0.113.9/32");
    });

    it("retourne undefined quand aucune IP n'est déterminable ('unknown')", () => {
      const req = new Request("http://test.local/");
      expect(clientCidr(req)).toBeUndefined();
    });

    it("retourne undefined pour une IPv6 (le chemin agent suppose IPv4)", () => {
      const req = new Request("http://test.local/", {
        headers: { "x-forwarded-for": "2a01:e0a::1" },
      });
      expect(clientCidr(req)).toBeUndefined();
    });

    it("retourne undefined pour une valeur illisible", () => {
      const req = new Request("http://test.local/", {
        headers: { "x-forwarded-for": "not-an-ip" },
      });
      expect(clientCidr(req)).toBeUndefined();
    });
  });
});
