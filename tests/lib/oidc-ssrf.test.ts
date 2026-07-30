// §2.25d — SSRF via l'issuer d'une connexion CI. L'issuer (GitLab self-hosted /
// Bitbucket) est choisi par un ADMIN_DEV et devient l'URL fetchée pour le JWKS
// AVANT toute vérification crypto → sans garde, `https://10.0.0.5:8200/…` sert
// d'oracle de joignabilité du réseau interne. Le fix route ce fetch par
// `safeFetchHook` (rejette les plages privées AVANT toute connexion).
//
// La garde est bypassée en NODE_ENV≠production (allowInternalTargets) → on force
// `production`. Un issuer en IP-littéral privée est rejeté SYNCHRONEMENT (isIP →
// ipIsPrivate) — aucune connexion, donc aucun oracle.

import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { generateKeyPair, SignJWT } from "jose";
import { verifyOidcToken, _resetJwksCache } from "@/lib/oidc";

let privateKey: CryptoKey;

beforeAll(async () => {
  ({ privateKey } = await generateKeyPair("RS256", { modulusLength: 2048 }));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  _resetJwksCache();
});

async function tokenWithIssuer(iss: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ project_path: "grp/proj" })
    .setProtectedHeader({ alg: "RS256", kid: "k" })
    .setIssuer(iss)
    .setAudience("physalis")
    .setIssuedAt(now)
    .setExpirationTime(now + 600)
    .sign(privateKey);
}

const trustGitlab = { resolveTrustedIssuer: async () => ({ provider: "gitlab" as const }) };

describe("§2.25d — l'issuer OIDC est fetché derrière la garde SSRF", () => {
  it("issuer GitLab self-hosted en IP privée : rejeté SANS fetch (prod)", async () => {
    delete process.env.OIDC_JWKS_URL;
    delete process.env.ROTATION_HOOK_ALLOW_INTERNAL;
    vi.stubEnv("NODE_ENV", "production");
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const token = await tokenWithIssuer("https://10.0.0.5:8200/x");
    const res = await verifyOidcToken(token, trustGitlab);

    expect(res.ok).toBe(false);
    // Coeur du fix : la garde rejette AVANT toute connexion → aucun fetch vers
    // l'IP privée (l'oracle de joignabilité est supprimé).
    const hitPrivate = fetchSpy.mock.calls.some((c) =>
      String(c[0]).includes("10.0.0.5"),
    );
    expect(hitPrivate).toBe(false);
  });

  it("issuer pointant sur les métadonnées cloud (169.254.169.254) : rejeté sans fetch", async () => {
    delete process.env.OIDC_JWKS_URL;
    delete process.env.ROTATION_HOOK_ALLOW_INTERNAL;
    vi.stubEnv("NODE_ENV", "production");
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const token = await tokenWithIssuer("https://169.254.169.254/latest");
    const res = await verifyOidcToken(token, trustGitlab);

    expect(res.ok).toBe(false);
    expect(
      fetchSpy.mock.calls.some((c) => String(c[0]).includes("169.254.169.254")),
    ).toBe(false);
  });
});
