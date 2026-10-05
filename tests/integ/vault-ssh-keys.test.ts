// C-0050 (agent-ssh), phase 1 — clés SSH du coffre personnel, contre la stack
// réelle. L'invariant éprouvé partout : la clé privée ne sort JAMAIS — ni à la
// création, ni dans la liste, ni à la révélation, ni dans l'export RGPD — et
// aucune route générique ne peut convertir, modifier ou déplacer une clé.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Session,
  adminSession,
  TENANT_HOST,
  postJson,
  patchJson,
  deleteReq,
  TENANT_SCHEMA,
} from "./helpers/api";
import { execSqlValue } from "./helpers/db";

const HAS_SSH_KEYGEN = !spawnSync("ssh-keygen", ["-?"], { stdio: "ignore" }).error;
const RUN = `integ-ssh-${Date.now()}`;
const created: string[] = [];
let admin: Session;

type Entry = {
  id: string;
  type: string;
  name: string;
  sshPublicKey: string | null;
  sshFingerprint: string | null;
};

/** Aucune trace de clé privée dans une réponse, sous quelque forme que ce soit. */
function expectNoPrivateKey(body: unknown) {
  const text = JSON.stringify(body);
  expect(text).not.toMatch(/PRIVATE KEY/);
  expect(text).not.toMatch(/sshPrivateKey/);
  expect(text).not.toMatch(/encryptedData|dataIv|dataTag/);
}

async function createKey(body: Record<string, unknown>): Promise<Response> {
  const res = await postJson(admin, "/api/vault/ssh-keys", body);
  if (res.status === 201) {
    const { entry } = (await res.clone().json()) as { entry: Entry };
    created.push(entry.id);
  }
  return res;
}

beforeAll(async () => {
  admin = await adminSession();
});

afterAll(async () => {
  for (const id of created) await deleteReq(admin, `/api/vault/entries/${id}`);
});

describe("générer une clé SSH", () => {
  let entry: Entry;

  beforeAll(async () => {
    const res = await createKey({ name: `${RUN}-gen`, mode: "generate" });
    expect(res.status).toBe(201);
    const body = await res.json();
    expectNoPrivateKey(body);
    entry = (body as { entry: Entry }).entry;
  });

  it("rend la clé publique ed25519 et l'empreinte, rien d'autre", () => {
    expect(entry.type).toBe("SSH_KEY");
    expect(entry.sshPublicKey).toMatch(/^ssh-ed25519 AAAA/);
    expect(entry.sshFingerprint).toMatch(/^SHA256:/);
  });

  it("la clé privée est chiffrée en base, jamais en clair", async () => {
    const stored = await execSqlValue(
      `SELECT "encryptedData" FROM "${TENANT_SCHEMA}"."VaultEntry" WHERE id = '${entry.id}'`,
    );
    expect(stored.length).toBeGreaterThan(50);
    expect(stored).not.toMatch(/PRIVATE KEY/);
  });

  it("la liste la montre comme SSH_KEY, sans aucun champ chiffré", async () => {
    const res = await admin.fetch("/api/vault/entries");
    const body = (await res.json()) as { entries: Entry[] };
    const mine = body.entries.find((e) => e.id === entry.id);
    expect(mine?.type).toBe("SSH_KEY");
    expect(mine?.sshFingerprint).toBe(entry.sshFingerprint);
    expectNoPrivateKey(body);
  });

  it("la « révélation » ne rend que la partie publique", async () => {
    const res = await admin.fetch(`/api/vault/entries/${entry.id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entry: Record<string, unknown> };
    expectNoPrivateKey(body);
    expect(body.entry.sshPublicKey).toBe(entry.sshPublicKey);
    for (const k of ["password", "items", "text", "totpSecret"]) {
      expect(k in body.entry, k).toBe(false);
    }
  });

  it("on peut la renommer, mais ni la convertir ni toucher ses champs secrets", async () => {
    expect((await patchJson(admin, `/api/vault/entries/${entry.id}`, { name: `${RUN}-renommée` })).status).toBe(200);
    for (const patch of [{ type: "NOTE" }, { type: "LOGIN" }, { password: "x" }, { text: "x" }, { url: "https://x" }]) {
      const res = await patchJson(admin, `/api/vault/entries/${entry.id}`, patch);
      expect(res.status, JSON.stringify(patch)).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe("ssh_key_locked");
    }
    // Toujours une clé SSH, toujours la même.
    const after = (await (await admin.fetch(`/api/vault/entries/${entry.id}`)).json()) as { entry: Entry };
    expect(after.entry.type).toBe("SSH_KEY");
    expect(after.entry.sshFingerprint).toBe(entry.sshFingerprint);
  });

  it("elle ne se déplace pas vers le coffre d'équipe", async () => {
    const res = await postJson(admin, `/api/vault/entries/${entry.id}/move`, { target: "team_org", orgSlug: "x", collectionSlug: "y" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("type_not_movable");
  });

  it("l'export RGPD ne contient que la clé publique", async () => {
    const res = await admin.fetch("/api/me/export?scope=personal");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain(entry.sshFingerprint!);
    expect(text).not.toMatch(/PRIVATE KEY/);
  });
});

describe("routes génériques", () => {
  it("le POST générique refuse le type SSH_KEY (création par /api/vault/ssh-keys seulement)", async () => {
    const res = await postJson(admin, "/api/vault/entries", { name: `${RUN}-generique`, type: "SSH_KEY" });
    expect(res.status).toBe(400);
  });

  it("mode inconnu ou nom manquant → 400", async () => {
    expect((await createKey({ name: `${RUN}-x`, mode: "autre" })).status).toBe(400);
    expect((await createKey({ mode: "generate" })).status).toBe(400);
  });
});

describe.skipIf(!HAS_SSH_KEYGEN)("importer une clé produite par ssh-keygen", () => {
  let dir = "";
  let priv = "";
  let fp = "";

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "integ-ssh-"));
    const path = join(dir, "id");
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "phrase-de-test", "-C", RUN, "-f", path]);
    priv = readFileSync(path, "utf8");
    fp = execFileSync("ssh-keygen", ["-l", "-E", "sha256", "-f", `${path}.pub`]).toString().split(" ")[1]!;
  });

  it("refuse sans phrase de passe, ou avec la mauvaise", async () => {
    const without = await createKey({ name: `${RUN}-imp`, mode: "import", privateKey: priv });
    expect(((await without.json()) as { code: string }).code).toBe("passphrase_required");
    const wrong = await createKey({ name: `${RUN}-imp`, mode: "import", privateKey: priv, passphrase: "non" });
    expect(((await wrong.json()) as { code: string }).code).toBe("wrong_passphrase");
  });

  it("importe avec la bonne phrase de passe : même empreinte qu'OpenSSH", async () => {
    const res = await createKey({ name: `${RUN}-imp`, mode: "import", privateKey: priv, passphrase: "phrase-de-test" });
    expect(res.status).toBe(201);
    const body = await res.json();
    expectNoPrivateKey(body);
    expect((body as { entry: Entry }).entry.sshFingerprint).toBe(fp);
  });

  it("la même clé une deuxième fois → 409", async () => {
    const res = await createKey({ name: `${RUN}-imp2`, mode: "import", privateKey: priv, passphrase: "phrase-de-test" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("duplicate_key");
  });
});

describe("page", () => {
  it("/vault affiche la section « Clés SSH »", async () => {
    const res = await admin.fetch("/fr/vault", { headers: { "x-forwarded-host": TENANT_HOST } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Clés SSH");
  });
});
