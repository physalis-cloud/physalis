// Suivi des déploiements (C-0051, Phase 1) — lib/deployment.ts.
// Cf. documentation/plans/guide-installation-projet.md §3.
//
// Base en mémoire : le module ne parle qu'à un sous-ensemble structurel de
// Prisma, on le reproduit au plus juste (clé unique composite, tri, skip).

import { describe, it, expect, vi } from "vitest";
import {
  DEPLOYMENT_RETENTION,
  MAX_DEPLOYMENT_DETAIL,
  deploymentPhase,
  deploymentRunUrl,
  isValidReportStatus,
  toDeploymentView,
  openDeployment,
  recordDeploymentReport,
  settleFromPlatform,
  SETTLE_MAX_ROWS,
} from "@/lib/deployment";

type Row = Record<string, unknown> & {
  id: string;
  environmentId: string;
  provider: string;
  runId: string;
  runAttempt: string;
  createdAt: Date;
};

function fakeDb() {
  const rows: Row[] = [];
  const projects = new Map<string, { setupCompletedAt: Date | null }>();
  let seq = 0;
  let clock = Date.parse("2026-10-03T10:00:00Z");

  const byUnique = (w: Record<string, unknown>) => {
    const k = w.environmentId_provider_runId_runAttempt as Record<string, string>;
    return rows.find(
      (r) =>
        r.environmentId === k.environmentId &&
        r.provider === k.provider &&
        r.runId === k.runId &&
        r.runAttempt === k.runAttempt,
    );
  };

  const db = {
    rows,
    projects,
    deployment: {
      findUnique: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        return byUnique(where) ?? null;
      }),
      findMany: vi.fn(
        async ({ where, skip }: { where: { environmentId: string }; skip: number }) =>
          rows
            .filter((r) => r.environmentId === where.environmentId)
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
            .slice(skip),
      ),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const dup = byUnique({ environmentId_provider_runId_runAttempt: data });
        if (dup) throw Object.assign(new Error("unique"), { code: "P2002" });
        const row = {
          status: "requested",
          bundleServedCount: 0,
          authorizedAt: null,
          reportedAt: null,
          detail: null,
          ...data,
          id: `d${++seq}`,
          createdAt: new Date((clock += 1000)),
        } as unknown as Row;
        rows.push(row);
        return { id: row.id };
      }),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const row = rows.find((r) => r.id === where.id)!;
          for (const [k, v] of Object.entries(data)) {
            if (v && typeof v === "object" && "increment" in v) {
              row[k] = (row[k] as number) + (v as { increment: number }).increment;
            } else row[k] = v;
          }
          return row;
        },
      ),
      deleteMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => {
        for (const id of where.id.in) rows.splice(rows.findIndex((r) => r.id === id), 1);
        return { count: where.id.in.length };
      }),
    },
    project: {
      updateMany: vi.fn(
        async ({ where, data }: { where: { id: string }; data: { setupCompletedAt: Date } }) => {
          const p = projects.get(where.id) ?? { setupCompletedAt: null };
          if (p.setupCompletedAt !== null) return { count: 0 };
          p.setupCompletedAt = data.setupCompletedAt;
          projects.set(where.id, p);
          return { count: 1 };
        },
      ),
    },
  };
  return db;
}

const target = (over: Partial<{ runId: string; attempt: string; env: string }> = {}) => ({
  projectId: "p1",
  environmentId: over.env ?? "e1",
  policyId: "pol1",
  ci: { provider: "github", repo: "acme/app", workflow: "deploy.yml", branch: "main" },
  run: { id: over.runId ?? "1001", attempt: over.attempt ?? "1", sha: "abc123" },
});

describe("openDeployment", () => {
  it("ouvre une ligne requested avec le premier bundle servi", async () => {
    const db = fakeDb();
    const id = await openDeployment(db, target());
    expect(id).toBe("d1");
    expect(db.rows[0]).toMatchObject({
      status: "requested",
      bundleServedCount: 1,
      sha: "abc123",
      policyId: "pol1",
    });
    expect(db.rows[0].authorizedAt).toBeInstanceOf(Date);
  });

  it("deux bundles du même run (build puis deploy) rejoignent la même ligne", async () => {
    const db = fakeDb();
    await openDeployment(db, target());
    const first = db.rows[0].authorizedAt;
    const id = await openDeployment(db, target());
    expect(id).toBe("d1");
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0].bundleServedCount).toBe(2);
    // Le PREMIER service ancre les paliers d'attente.
    expect(db.rows[0].authorizedAt).toBe(first);
  });

  it("une relance (nouvel attempt) ouvre une nouvelle ligne", async () => {
    const db = fakeDb();
    await openDeployment(db, target());
    await openDeployment(db, target({ attempt: "2" }));
    expect(db.rows).toHaveLength(2);
  });

  it("rejoint la ligne créée par un job concurrent (P2002)", async () => {
    const db = fakeDb();
    await openDeployment(db, target());
    // Simule la course : la lecture ne voit rien, la création tombe sur l'unique.
    db.deployment.findUnique.mockResolvedValueOnce(null);
    const id = await openDeployment(db, target());
    expect(id).toBe("d1");
    expect(db.rows[0].bundleServedCount).toBe(2);
  });

  it("ne lève jamais : une base en panne rend null", async () => {
    const db = fakeDb();
    db.deployment.findUnique.mockRejectedValueOnce(new Error("db down"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(openDeployment(db, target())).resolves.toBeNull();
    spy.mockRestore();
  });

  it(`ne garde que les ${DEPLOYMENT_RETENTION} derniers par environnement`, async () => {
    const db = fakeDb();
    for (let i = 0; i < DEPLOYMENT_RETENTION + 3; i++) {
      await openDeployment(db, target({ runId: String(i) }));
    }
    await openDeployment(db, target({ runId: "autre-env", env: "e2" }));
    const e1 = db.rows.filter((r) => r.environmentId === "e1");
    expect(e1).toHaveLength(DEPLOYMENT_RETENTION);
    // Les plus anciens sont partis.
    expect(e1.map((r) => r.runId)).not.toContain("0");
    expect(db.rows.filter((r) => r.environmentId === "e2")).toHaveLength(1);
  });
});

describe("recordDeploymentReport", () => {
  it("rejoint la ligne ouverte : corrélé", async () => {
    const db = fakeDb();
    await openDeployment(db, target());
    const out = await recordDeploymentReport(db, {
      ...target(),
      status: "succeeded",
      detail: null,
    });
    expect(out).toEqual({ deploymentId: "d1", correlated: true });
    expect(db.rows[0]).toMatchObject({ status: "succeeded" });
    expect(db.rows[0].reportedAt).toBeInstanceOf(Date);
  });

  it("sans bundle servi : crée une ligne NON corrélée", async () => {
    const db = fakeDb();
    const out = await recordDeploymentReport(db, {
      ...target(),
      status: "succeeded",
      detail: null,
    });
    expect(out.correlated).toBe(false);
    expect(db.rows[0]).toMatchObject({ bundleServedCount: 0, status: "succeeded" });
  });

  it("le dernier rapport gagne (relance d'un job seul)", async () => {
    const db = fakeDb();
    await openDeployment(db, target());
    await recordDeploymentReport(db, { ...target(), status: "failed", detail: "compose pull" });
    await recordDeploymentReport(db, { ...target(), status: "succeeded", detail: null });
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0]).toMatchObject({ status: "succeeded", detail: null });
  });

  it("borne le détail libre", async () => {
    const db = fakeDb();
    await recordDeploymentReport(db, {
      ...target(),
      status: "failed",
      detail: "x".repeat(MAX_DEPLOYMENT_DETAIL + 50),
    });
    expect((db.rows[0].detail as string).length).toBe(MAX_DEPLOYMENT_DETAIL);
  });

  it("le premier succès corrélé pose setupCompletedAt, une seule fois", async () => {
    const db = fakeDb();
    await openDeployment(db, target());
    await recordDeploymentReport(db, { ...target(), status: "succeeded", detail: null });
    const first = db.projects.get("p1")?.setupCompletedAt;
    expect(first).toBeInstanceOf(Date);

    await openDeployment(db, target({ runId: "1002" }));
    await recordDeploymentReport(db, {
      ...target({ runId: "1002" }),
      status: "succeeded",
      detail: null,
    });
    expect(db.projects.get("p1")?.setupCompletedAt).toBe(first);
  });

  it("un échec ne ferme pas le guide", async () => {
    const db = fakeDb();
    await openDeployment(db, target());
    await recordDeploymentReport(db, { ...target(), status: "failed", detail: null });
    expect(db.project.updateMany).not.toHaveBeenCalled();
  });

  it("un succès NON corrélé ne ferme pas le guide", async () => {
    const db = fakeDb();
    await recordDeploymentReport(db, { ...target(), status: "succeeded", detail: null });
    expect(db.project.updateMany).not.toHaveBeenCalled();
  });
});

describe("statut rapportable", () => {
  it("vocabulaire fermé, requested réservé à Physalis", () => {
    expect(isValidReportStatus("succeeded")).toBe(true);
    expect(isValidReportStatus("failed")).toBe(true);
    expect(isValidReportStatus("requested")).toBe(false);
    expect(isValidReportStatus("ok")).toBe(false);
  });
});

describe("deploymentPhase — paliers d'attente (A6)", () => {
  const t0 = new Date("2026-10-03T10:00:00Z");
  const at = (min: number) => new Date(t0.getTime() + min * 60_000);
  const pending = { status: "requested", authorizedAt: t0, createdAt: t0 };

  it.each([
    [0, "running"],
    [14.9, "running"],
    [15, "long"],
    [29.9, "long"],
    [30, "abnormal"],
    [44.9, "abnormal"],
    [45, "expired"],
    [600, "expired"],
  ])("%s min sans rapport → %s", (min, phase) => {
    expect(deploymentPhase(pending, at(min as number))).toBe(phase);
  });

  it("un rapport tardif remplace « expiré » : le timeout n'est pas un verdict", () => {
    expect(deploymentPhase({ ...pending, status: "succeeded" }, at(600))).toBe("succeeded");
    expect(deploymentPhase({ ...pending, status: "failed" }, at(600))).toBe("failed");
  });

  it("sans autorisation (ligne née du rapport), l'ancre est createdAt", () => {
    expect(
      deploymentPhase({ status: "requested", authorizedAt: null, createdAt: t0 }, at(31)),
    ).toBe("abnormal");
  });
});

describe("deploymentRunUrl — lien reconstruit, jamais fourni par le pipeline", () => {
  const gh = { provider: "github", repo: "acme/app", runId: "123", runAttempt: "1" };

  it("GitHub", () => {
    expect(deploymentRunUrl(gh, null)).toBe("https://github.com/acme/app/actions/runs/123");
    expect(deploymentRunUrl({ ...gh, runAttempt: "3" }, null)).toBe(
      "https://github.com/acme/app/actions/runs/123/attempts/3",
    );
  });

  it("GitLab.com et self-hosted (origine de l'issuer seulement)", () => {
    const gl = { provider: "gitlab", repo: "grp/sub/app", runId: "9", runAttempt: "1" };
    expect(deploymentRunUrl(gl, null)).toBe("https://gitlab.com/grp/sub/app/-/pipelines/9");
    expect(deploymentRunUrl(gl, "https://git.acme.io/some/path")).toBe(
      "https://git.acme.io/grp/sub/app/-/pipelines/9",
    );
  });

  it("refuse tout ce qui ne se reconstruit pas proprement", () => {
    expect(deploymentRunUrl({ ...gh, runId: "12a" }, null)).toBeNull();
    expect(deploymentRunUrl({ ...gh, repo: "acme/app/../x" }, null)).toBeNull();
    expect(deploymentRunUrl({ ...gh, repo: "javascript:alert(1)" }, null)).toBeNull();
    expect(
      deploymentRunUrl({ provider: "gitlab", repo: "g/a", runId: "1", runAttempt: "1" }, "http://insecure"),
    ).toBeNull();
    // Bitbucket : uniquement des UUID dans le jeton, pas d'URL web constructible.
    expect(
      deploymentRunUrl({ provider: "bitbucket", repo: "{u}", runId: "{p}", runAttempt: "1" }, null),
    ).toBeNull();
  });
});

describe("toDeploymentView", () => {
  it("expose la phase calculée et la corrélation, rien de plus", () => {
    const t0 = new Date("2026-10-03T10:00:00Z");
    const view = toDeploymentView(
      {
        id: "d1",
        status: "requested",
        statusSource: null,
        bundleServedCount: 0,
        provider: "github",
        repo: "acme/app",
        workflow: "deploy.yml",
        branch: "main",
        runId: "5",
        runAttempt: "1",
        sha: "abc",
        detail: null,
        authorizedAt: null,
        reportedAt: null,
        createdAt: t0,
      },
      null,
      new Date(t0.getTime() + 20 * 60_000),
    );
    expect(view).toMatchObject({ phase: "long", correlated: false });
    expect(view).not.toHaveProperty("repo");
    expect(view).not.toHaveProperty("runId");
    expect(view.runUrl).toBe("https://github.com/acme/app/actions/runs/5");
  });
});

describe("settleFromPlatform — issue lue chez la plateforme, sans étape de rapport", () => {
  const t0 = new Date("2026-10-03T10:00:00Z");
  const at = (min: number) => new Date(t0.getTime() + min * 60_000);
  const pending = (over: Partial<{ id: string; bundleServedCount: number; authorizedAt: Date }> = {}) => ({
    id: over.id ?? "d1",
    projectId: "p1",
    provider: "github",
    repo: "acme/app",
    runId: "1001",
    runAttempt: "1",
    bundleServedCount: over.bundleServedCount ?? 1,
    authorizedAt: over.authorizedAt ?? t0,
    createdAt: t0,
  });
  const seeded = async () => {
    const db = fakeDb();
    await openDeployment(db, target());
    return db;
  };

  it("succès constaté → succeeded, source platform, le guide se ferme", async () => {
    const db = await seeded();
    const n = await settleFromPlatform(db, [pending()], async () => "success", at(5));
    expect(n).toBe(1);
    expect(db.rows[0]).toMatchObject({ status: "succeeded", statusSource: "platform" });
    expect(db.projects.get("p1")?.setupCompletedAt).toEqual(at(5));
  });

  it("échec constaté → failed, le guide reste ouvert", async () => {
    const db = await seeded();
    await settleFromPlatform(db, [pending()], async () => "failure", at(5));
    expect(db.rows[0]).toMatchObject({ status: "failed", statusSource: "platform" });
    expect(db.project.updateMany).not.toHaveBeenCalled();
  });

  it("run en cours ou plateforme illisible → ligne intacte", async () => {
    for (const o of ["running", "unknown"] as const) {
      const db = await seeded();
      expect(await settleFromPlatform(db, [pending()], async () => o, at(5))).toBe(0);
      expect(db.rows[0]).toMatchObject({ status: "requested" });
    }
  });

  it("une lecture qui lève ne casse rien", async () => {
    const db = await seeded();
    const n = await settleFromPlatform(
      db,
      [pending()],
      async () => {
        throw new Error("network");
      },
      at(5),
    );
    expect(n).toBe(0);
  });

  it("laisse une minute au pipeline pour rapporter lui-même", async () => {
    const read = vi.fn(async () => "success" as const);
    const db = await seeded();
    await settleFromPlatform(db, [pending()], read, at(0.5));
    expect(read).not.toHaveBeenCalled();
  });

  it("ne relit pas un run de plus de 7 jours", async () => {
    const read = vi.fn(async () => "success" as const);
    const db = await seeded();
    await settleFromPlatform(db, [pending()], read, at(8 * 24 * 60));
    expect(read).not.toHaveBeenCalled();
  });

  it(`borne le nombre de lectures (${SETTLE_MAX_ROWS})`, async () => {
    const read = vi.fn(async () => "running" as const);
    const db = await seeded();
    const rows = Array.from({ length: SETTLE_MAX_ROWS + 5 }, (_, i) => pending({ id: `x${i}` }));
    await settleFromPlatform(db, rows, read, at(5));
    expect(read).toHaveBeenCalledTimes(SETTLE_MAX_ROWS);
  });

  it("un succès sans bundle servi ne ferme pas le guide", async () => {
    const db = await seeded();
    await settleFromPlatform(db, [pending({ bundleServedCount: 0 })], async () => "success", at(5));
    expect(db.project.updateMany).not.toHaveBeenCalled();
  });

  it("un rapport du pipeline est marqué « reported »", async () => {
    const db = await seeded();
    await recordDeploymentReport(db, { ...target(), status: "succeeded", detail: null });
    expect(db.rows[0]).toMatchObject({ statusSource: "reported" });
  });
});
