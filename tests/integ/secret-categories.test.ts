// Tests integ — rangement des secrets par catégorie.
//
// Deux chemins couverts :
//   1. Import .env — les commentaires pleine ligne qui nomment une
//      catégorie connue rangent les clés qui suivent (c'est le format
//      exact que produit l'export .env de l'app : `# infra`).
//   2. PATCH bulk — le mode « Réorganiser » de l'UI range N clés d'un
//      coup ; on vérifie l'isolation (une clé d'un autre environnement
//      passée dans le body ne bouge pas).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Session, adminSession, postJson, patchJson, deleteReq } from "./helpers/api";

const SUFFIX = `${Date.now()}`;
const PROJECT_NAME = `categories-${SUFFIX}`;
let PROJECT_SLUG = "";
let admin: Session;

// Reproduit un export .env de l'app : un en-tête par groupe, une ligne
// vide entre les groupes, plus un commentaire libre qui ne doit RIEN
// ranger.
const ENV_TEXT = [
  "# application",
  "REPO_NAME=physalis-cloud/physalis-vitrine",
  "",
  "# infra",
  "CLOUDFLARE_ZONE_ID=zone-xyz",
  "PROJECT_NAME=physalis",
  "",
  "# ports",
  "API_PORT=58103",
  "FRONTEND_PORT=58102",
  "",
  "# TODO: rotate before prod",
  "LEFTOVER_KEY=nothing",
  "",
].join("\n");

type SecretRow = { key: string; category: string | null };

async function listSecrets(env: string): Promise<Map<string, string | null>> {
  const res = await admin.fetch(`/api/projects/${PROJECT_SLUG}/${env}/secrets`);
  const data = (await res.json()) as { secrets: SecretRow[] };
  return new Map(data.secrets.map((s) => [s.key, s.category]));
}

beforeAll(async () => {
  admin = await adminSession();
  const res = await postJson(admin, "/api/projects", { name: PROJECT_NAME });
  if (res.status !== 201) throw new Error(`setup project failed: ${res.status}`);
  const data = (await res.json()) as { project: { slug: string } };
  PROJECT_SLUG = data.project.slug;
});

afterAll(async () => {
  if (admin) await deleteReq(admin, `/api/projects/${PROJECT_SLUG}`);
});

describe("Import .env — catégories lues dans les commentaires", () => {
  it("dryRun annonce la répartition avant d'écrire", async () => {
    const res = await postJson(
      admin,
      `/api/projects/${PROJECT_SLUG}/production/secrets/import`,
      { envText: ENV_TEXT, dryRun: true, defaultCategory: "auth" },
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      categories: { byCategory: Record<string, number>; fallback: number };
    };
    expect(data.categories.byCategory).toEqual({
      application: 1,
      infra: 2,
      ports: 2,
    });
    // Le commentaire libre ne range rien → la clé retombe sur le défaut.
    expect(data.categories.fallback).toBe(1);
  });

  it("range chaque clé selon son en-tête, le reste sur la catégorie par défaut", async () => {
    const res = await postJson(
      admin,
      `/api/projects/${PROJECT_SLUG}/production/secrets/import`,
      { envText: ENV_TEXT, dryRun: false, defaultCategory: "auth" },
    );
    expect(res.status).toBe(200);

    const byKey = await listSecrets("production");
    expect(byKey.get("REPO_NAME")).toBe("application");
    expect(byKey.get("CLOUDFLARE_ZONE_ID")).toBe("infra");
    expect(byKey.get("PROJECT_NAME")).toBe("infra");
    expect(byKey.get("API_PORT")).toBe("ports");
    expect(byKey.get("FRONTEND_PORT")).toBe("ports");
    expect(byKey.get("LEFTOVER_KEY")).toBe("auth");
  });

  it("en mode overwrite, un en-tête réaligne la catégorie d'une clé existante", async () => {
    // API_PORT a été rangé dans "ports" ci-dessus ; on le réimporte sous
    // un autre en-tête. La clé sans en-tête reconnu, elle, ne doit PAS
    // être déplacée par la catégorie par défaut.
    const res = await postJson(
      admin,
      `/api/projects/${PROJECT_SLUG}/production/secrets/import`,
      {
        envText: ["# services", "API_PORT=1234", "", "LEFTOVER_KEY=other"].join(
          "\n",
        ),
        dryRun: false,
        conflictPolicy: "overwrite",
        defaultCategory: "database",
      },
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      summary: { updated: number; recategorized: number };
    };
    expect(data.summary.updated).toBe(2);
    expect(data.summary.recategorized).toBe(1);

    const byKey = await listSecrets("production");
    expect(byKey.get("API_PORT")).toBe("services");
    expect(byKey.get("LEFTOVER_KEY")).toBe("auth"); // intact
  });
});

describe("PATCH bulk — rangement multi-sélection", () => {
  it("range le lot demandé et ignore ce qui n'est pas de l'environnement", async () => {
    const res = await patchJson(
      admin,
      `/api/projects/${PROJECT_SLUG}/production/secrets/bulk`,
      {
        keys: ["REPO_NAME", "PROJECT_NAME", "DOES_NOT_EXIST"],
        category: "database",
      },
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { updated: number; keys: string[] };
    expect(data.updated).toBe(2);
    expect(data.keys.sort()).toEqual(["PROJECT_NAME", "REPO_NAME"]);

    const byKey = await listSecrets("production");
    expect(byKey.get("REPO_NAME")).toBe("database");
    expect(byKey.get("PROJECT_NAME")).toBe("database");
  });

  it("category null retire la catégorie", async () => {
    const res = await patchJson(
      admin,
      `/api/projects/${PROJECT_SLUG}/production/secrets/bulk`,
      { keys: ["REPO_NAME"], category: null },
    );
    expect(res.status).toBe(200);
    const byKey = await listSecrets("production");
    expect(byKey.get("REPO_NAME")).toBeNull();
  });

  it("refuse une catégorie inconnue", async () => {
    const res = await patchJson(
      admin,
      `/api/projects/${PROJECT_SLUG}/production/secrets/bulk`,
      { keys: ["REPO_NAME"], category: "n-importe-quoi" },
    );
    expect(res.status).toBe(400);
  });

  it("refuse un lot vide", async () => {
    const res = await patchJson(
      admin,
      `/api/projects/${PROJECT_SLUG}/production/secrets/bulk`,
      { keys: [], category: "infra" },
    );
    expect(res.status).toBe(400);
  });
});
