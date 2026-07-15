// Tests du garde-fou réseau Phase 2 (cron-auth) : restriction des endpoints
// critiques à l'origine privée (tailnet) quand CRON_PRIVATE_ONLY est activé.

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import {
  isTailscaleIp,
  requirePrivateOrigin,
  requireCronAuthAsync,
} from "@/lib/cron-auth";
import { verifyOidcToken } from "@/lib/oidc";

// Mock OIDC : on garde extractBearer réel, on stub la vérif crypto/réseau JWKS.
vi.mock("@/lib/oidc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/oidc")>();
  return { ...actual, verifyOidcToken: vi.fn() };
});
const mockVerify = vi.mocked(verifyOidcToken);

const ORIGINAL = process.env.CRON_PRIVATE_ONLY;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.CRON_PRIVATE_ONLY;
  else process.env.CRON_PRIVATE_ONLY = ORIGINAL;
});

/** Forge une requête avec (ou sans) l'en-tête CF-Connecting-IP. */
function req(cfIp?: string): Request {
  const headers = new Headers();
  if (cfIp !== undefined) headers.set("cf-connecting-ip", cfIp);
  return new Request("https://vault.physalis.cloud/api/cron/purge-accounts", {
    method: "POST",
    headers,
  });
}

describe("isTailscaleIp — CGNAT 100.64.0.0/10", () => {
  it("accepte les IP du tailnet", () => {
    for (const ip of ["100.64.0.0", "100.77.120.17", "100.100.50.1", "100.127.255.255"]) {
      expect(isTailscaleIp(ip), ip).toBe(true);
    }
  });
  it("rejette hors plage / IP publiques / invalides", () => {
    for (const ip of ["100.63.255.255", "100.128.0.0", "8.8.8.8", "192.168.1.1", "203.0.113.7", "", "abc", "100.64.0"]) {
      expect(isTailscaleIp(ip), ip).toBe(false);
    }
  });
});

describe("requirePrivateOrigin", () => {
  it("garde-fou DÉSACTIVÉ (défaut) → toujours autorisé", () => {
    delete process.env.CRON_PRIVATE_ONLY;
    expect(requirePrivateOrigin(req("203.0.113.7"))).toBe(true); // même via edge public
    expect(requirePrivateOrigin(req())).toBe(true);
  });

  it("activé : requête edge public (CF-Connecting-IP publique) → refusée", () => {
    process.env.CRON_PRIVATE_ONLY = "1";
    expect(requirePrivateOrigin(req("203.0.113.7"))).toBe(false);
  });

  it("activé : requête tailnet (pas d'en-tête CF) → autorisée", () => {
    process.env.CRON_PRIVATE_ONLY = "1";
    expect(requirePrivateOrigin(req())).toBe(true);
  });

  it("activé : CF-Connecting-IP dans le tailnet → autorisée (cas limite)", () => {
    process.env.CRON_PRIVATE_ONLY = "true";
    expect(requirePrivateOrigin(req("100.77.120.17"))).toBe(true);
  });
});

describe("requireCronAuthAsync — bearer statique + OIDC GitHub (Phase 3)", () => {
  const SAVE = {
    admin: process.env.CRON_SECRET_ADMIN,
    report: process.env.CRON_SECRET_REPORT,
    repo: process.env.CRON_OIDC_REPO,
    branch: process.env.CRON_OIDC_BRANCH,
  };
  beforeEach(() => {
    process.env.CRON_SECRET_ADMIN = "admin-secret";
    process.env.CRON_SECRET_REPORT = "report-secret";
    delete process.env.CRON_OIDC_REPO;
    delete process.env.CRON_OIDC_BRANCH;
    mockVerify.mockReset();
  });
  afterEach(() => {
    const restore: Record<string, string | undefined> = {
      CRON_SECRET_ADMIN: SAVE.admin,
      CRON_SECRET_REPORT: SAVE.report,
      CRON_OIDC_REPO: SAVE.repo,
      CRON_OIDC_BRANCH: SAVE.branch,
    };
    for (const [k, v] of Object.entries(restore)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const bearer = (t: string) =>
    new Request("https://vault.physalis.cloud/api/cron/backup", {
      method: "POST",
      headers: { authorization: `Bearer ${t}` },
    });

  const ghClaims = (over: Record<string, unknown> = {}) => ({
    ok: true as const,
    claims: {
      provider: "github" as const,
      issuer: "https://token.actions.githubusercontent.com",
      repo: "argo-web/secretvault",
      matchKey: "cron-backup.yml",
      policyIssuer: null,
      branch: "main",
      raw: {},
      ...over,
    },
  });

  it("bearer statique admin valide → true (OIDC pas même tenté)", async () => {
    expect(await requireCronAuthAsync(bearer("admin-secret"), "admin")).toBe(true);
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it("bearer statique report valide (tier report) → true", async () => {
    expect(await requireCronAuthAsync(bearer("report-secret"), "report")).toBe(true);
  });

  it("tier report + mauvais bearer → false, JAMAIS d'OIDC", async () => {
    process.env.CRON_OIDC_REPO = "argo-web/secretvault";
    expect(await requireCronAuthAsync(bearer("nope"), "report")).toBe(false);
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it("tier admin + mauvais bearer + CRON_OIDC_REPO absent → false (OIDC désactivé)", async () => {
    expect(await requireCronAuthAsync(bearer("nope"), "admin")).toBe(false);
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it("OIDC GitHub valide (repo + branche OK) → true", async () => {
    process.env.CRON_OIDC_REPO = "argo-web/secretvault";
    mockVerify.mockResolvedValue(ghClaims());
    expect(await requireCronAuthAsync(bearer("oidc.jwt"), "admin")).toBe(true);
  });

  it("OIDC mauvais repo → false", async () => {
    process.env.CRON_OIDC_REPO = "argo-web/secretvault";
    mockVerify.mockResolvedValue(ghClaims({ repo: "evil/repo" }));
    expect(await requireCronAuthAsync(bearer("oidc.jwt"), "admin")).toBe(false);
  });

  it("OIDC mauvaise branche → false", async () => {
    process.env.CRON_OIDC_REPO = "argo-web/secretvault";
    mockVerify.mockResolvedValue(ghClaims({ branch: "feature-x" }));
    expect(await requireCronAuthAsync(bearer("oidc.jwt"), "admin")).toBe(false);
  });

  it("OIDC provider non-github → false", async () => {
    process.env.CRON_OIDC_REPO = "argo-web/secretvault";
    mockVerify.mockResolvedValue(ghClaims({ provider: "gitlab" }));
    expect(await requireCronAuthAsync(bearer("oidc.jwt"), "admin")).toBe(false);
  });

  it("OIDC token invalide → false", async () => {
    process.env.CRON_OIDC_REPO = "argo-web/secretvault";
    mockVerify.mockResolvedValue({ ok: false, reason: "expired" });
    expect(await requireCronAuthAsync(bearer("oidc.jwt"), "admin")).toBe(false);
  });

  it("CRON_OIDC_BRANCH override respecté", async () => {
    process.env.CRON_OIDC_REPO = "argo-web/secretvault";
    process.env.CRON_OIDC_BRANCH = "release";
    mockVerify.mockResolvedValue(ghClaims({ branch: "release" }));
    expect(await requireCronAuthAsync(bearer("oidc.jwt"), "admin")).toBe(true);
  });
});
