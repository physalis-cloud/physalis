import { describe, it, expect } from "vitest";
import { Session } from "./helpers/api";

/**
 * Test du rate-limit sur /api/auth/callback/credentials.
 *
 * Depuis le correctif §2.10, le login est limité à DEUX étages :
 *   - compte : 5 / 15 min sur (tenant, email), quelle que soit l'IP ;
 *   - IP     : 30 / 15 min, backstop anti-spraying (large pour ne pas casser
 *              les bureaux derrière un NAT partagé).
 *
 * L'IP est dérivée du DERNIER hop de X-Forwarded-For (le seul que l'appelant
 * ne peut pas forger) : préfixer la chaîne ne permet plus de changer de bucket.
 *
 * Le rate-limit est géré DANS le callback authorize de NextAuth (lib/auth.ts)
 * via RateLimitExceeded extends CredentialsSignin. Cela retourne une 302 avec
 * Location: /login?code=rate_limited (pas un 429 HTTP), pour éviter un crash
 * client-side sur une réponse inattendue.
 */
describe("Rate-limit /api/auth/callback/credentials", () => {
  // Retourne { status, location } pour pouvoir distinguer les types de 302.
  async function attemptLogin(
    xff: string,
    email: string,
    password = "wrongpassword",
  ): Promise<{ status: number; location: string | null }> {
    const session = new Session();
    const csrfRes = await session.fetch("/api/auth/csrf", {
      headers: { "x-forwarded-for": xff },
    });
    const { csrfToken } = (await csrfRes.json()) as { csrfToken: string };
    const body = new URLSearchParams({ csrfToken, email, password }).toString();
    const res = await session.fetch("/api/auth/callback/credentials", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-forwarded-for": xff,
      },
      body,
    });
    return { status: res.status, location: res.headers.get("location") };
  }

  // Les buckets vivent dans le process du serveur (Map module-level) et
  // survivent d'un run à l'autre pendant toute la fenêtre de 15 min. Emails ET
  // IP doivent donc être uniques par run, sinon un run hérite des compteurs du
  // précédent (symptôme : blocage dès la 1re tentative).
  const run = Date.now();
  // Deux octets dérivés du run dans 10/8 → période ~18 h, très au-delà de la
  // fenêtre ; le dernier octet reste libre pour distinguer les tests.
  const runA = (Math.floor(run / 1000) % 254) + 1;
  const runB = (Math.floor(run / 254_000) % 254) + 1;
  const ip = (n: number) => `10.${runB}.${runA}.${n}`;
  const freshEmail = (label: string) => `nx-${label}-${run}@example.com`;

  describe("étage compte", () => {
    it("bloque la 6e tentative sur le même email", async () => {
      const email = freshEmail("acct");
      for (let i = 1; i <= 5; i++) {
        const { status, location } = await attemptLogin(ip(11), email);
        expect(status, `attempt ${i} status`).toBe(302);
        expect(location, `attempt ${i} location`).not.toMatch(/rate_limited/);
      }
      const { location } = await attemptLogin(ip(11), email);
      expect(location).toMatch(/code=rate_limited/);
    });

    it("suit le compte même si l'attaquant change d'IP à chaque essai", async () => {
      const email = freshEmail("rotate");
      for (let i = 1; i <= 5; i++) {
        const { location } = await attemptLogin(ip(20 + i), email);
        expect(location, `attempt ${i}`).not.toMatch(/rate_limited/);
      }
      // 6e essai depuis une IP encore jamais vue → doit rester bloqué.
      const { location } = await attemptLogin(ip(99), email);
      expect(location).toMatch(/code=rate_limited/);
    });

    it("un autre compte depuis la même IP n'est pas affecté", async () => {
      const victim = freshEmail("victim");
      for (let i = 1; i <= 6; i++) await attemptLogin(ip(12), victim);
      // Le bucket compte de la victime est saturé…
      expect((await attemptLogin(ip(12), victim)).location).toMatch(
        /code=rate_limited/,
      );
      // …mais un compte voisin sur la même IP passe toujours.
      const neighbor = await attemptLogin(ip(12), freshEmail("neighbor"));
      expect(neighbor.location).not.toMatch(/rate_limited/);
    });
  });

  describe("étage IP (backstop anti-spraying)", () => {
    it("finit par bloquer un balayage multi-comptes depuis une IP", async () => {
      const sprayIp = ip(150);
      let blockedAt: number | null = null;
      // Un email différent à chaque coup → le bucket compte ne mord jamais,
      // seul le bucket IP peut arrêter le balayage.
      for (let i = 1; i <= 32 && blockedAt === null; i++) {
        const { location } = await attemptLogin(
          sprayIp,
          freshEmail(`spray-${i}`),
        );
        if (location?.includes("rate_limited")) blockedAt = i;
      }
      expect(blockedAt).not.toBeNull();
      // 30/15min : le blocage tombe à la 31e, jamais avant.
      expect(blockedAt).toBeGreaterThan(30);
    }, 60_000);
  });

  describe("dérivation de l'IP (§2.10)", () => {
    it("un X-Forwarded-For préfixé ne permet pas d'échapper au bucket", async () => {
      const email = freshEmail("forge");
      // Sature le bucket compte depuis une IP honnête.
      for (let i = 1; i <= 6; i++) await attemptLogin(ip(60), email);
      expect((await attemptLogin(ip(60), email)).location).toMatch(
        /code=rate_limited/,
      );

      // L'attaquant préfixe la chaîne pour se faire passer pour une autre IP.
      // Le dernier hop reste le sien → même bucket IP, et le bucket compte est
      // de toute façon indépendant de l'IP.
      const forged = await attemptLogin(`1.1.1.1, 2.2.2.2, ${ip(60)}`, email);
      expect(forged.location).toMatch(/code=rate_limited/);
    });
  });
});
