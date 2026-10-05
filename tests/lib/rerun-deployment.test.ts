// Relance d'un déploiement précis (C-0051) — lib/redeploy.ts `rerunDeployment`.
// Le fetch est simulé : on vérifie l'appel fait à chaque plateforme.

import { describe, it, expect, vi, afterEach } from "vitest";
import { rerunDeployment } from "@/lib/redeploy";

const calls: { url: string; init?: RequestInit }[] = [];
function mockFetch(status = 204) {
  calls.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(status === 204 ? null : "nope", { status });
    }),
  );
}
afterEach(() => vi.unstubAllGlobals());

const base = {
  repo: "acme/app",
  runId: "123",
  branch: "main",
  status: "succeeded",
  envName: "production",
  token: "t0k",
  issuer: null,
};

describe("rerunDeployment", () => {
  it("GitHub : re-run du run lui-même", async () => {
    mockFetch(201);
    const r = await rerunDeployment({ ...base, provider: "github" });
    expect(r).toMatchObject({ ok: true, mode: "rerun" });
    expect(calls[0].url).toBe("https://api.github.com/repos/acme/app/actions/runs/123/rerun");
    expect(calls[0].init?.method).toBe("POST");
  });

  it("GitHub : refus de la plateforme remonté (ex. run de plus de 30 jours)", async () => {
    mockFetch(403);
    const r = await rerunDeployment({ ...base, provider: "github" });
    expect(r).toMatchObject({ ok: false, httpStatus: 403, error: "nope" });
  });

  it("GitHub : run invalide → aucun appel", async () => {
    mockFetch(201);
    const r = await rerunDeployment({ ...base, provider: "github", runId: "12a" });
    expect(r.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("GitLab : pipeline échoué → retry", async () => {
    mockFetch(201);
    const r = await rerunDeployment({
      ...base,
      provider: "gitlab",
      repo: "grp/app",
      status: "failed",
    });
    expect(r.mode).toBe("retry");
    expect(calls[0].url).toBe("https://gitlab.com/api/v4/projects/grp%2Fapp/pipelines/123/retry");
  });

  it("GitLab : pipeline réussi → nouveau pipeline sur la branche", async () => {
    mockFetch(201);
    const r = await rerunDeployment({ ...base, provider: "gitlab", repo: "grp/app" });
    expect(r.mode).toBe("new_pipeline");
    expect(calls[0].url).toBe("https://gitlab.com/api/v4/projects/grp%2Fapp/pipeline");
    expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({ ref: "main" });
  });

  it("Bitbucket : nouveau pipeline sur la branche", async () => {
    mockFetch(201);
    const r = await rerunDeployment({
      ...base,
      provider: "bitbucket",
      repo: "{uuid}",
      issuer: "https://api.bitbucket.org/2.0/workspaces/acme/pipelines-config/identity/oidc",
    });
    expect(r.mode).toBe("new_pipeline");
    expect(calls[0].url).toContain("/repositories/acme/");
  });
});
