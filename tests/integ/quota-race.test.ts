// §2.24e — check-then-create non atomique : N requêtes concurrentes lisaient
// toutes count<max et créaient toutes → dépassement du quota. Fix = création SOUS
// verrou consultatif (tenant, kind) + RE-COMPTE sous le verrou.
//
// Test : on fixe le quota d'orgs de `test` à (courant + 1) — donc UN seul slot
// libre — puis on tire une rafale de POST /api/orgs concurrents. Attendu : très
// exactement 1 création (201), le reste refusé (403), et le total d'orgs ne
// dépasse jamais le quota. Sans le verrou, plusieurs 201 passaient.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Session, adminSession, postJson, TENANT_SCHEMA } from "./helpers/api";
import { execSql, execSqlValue } from "./helpers/db";

const BURST = 5;
let admin: Session;
let baseline = 0; // nb d'orgs avant la rafale
let savedQuota = { maxOrgs: 0, extraOrgs: 0, bonusOrgs: 0 };

async function orgCount(): Promise<number> {
  return Number(
    (
      await execSqlValue(
        `SELECT count(*) FROM "${TENANT_SCHEMA}"."Organization"`,
      )
    ).trim(),
  );
}

beforeAll(async () => {
  admin = await adminSession();

  // Sauvegarde le quota courant pour restauration.
  const row = await execSqlValue(
    `SELECT max_orgs||'|'||extra_orgs||'|'||bonus_orgs FROM admin.clients WHERE slug='test'`,
  );
  const [m, e, b] = row.trim().split("|").map(Number);
  savedQuota = { maxOrgs: m, extraOrgs: e, bonusOrgs: b };

  baseline = await orgCount();
  // Quota effectif = max_orgs + extra_orgs + bonus_orgs → on le fixe à baseline+1
  // (un seul slot libre) via max_orgs, extras à 0.
  await execSql(
    `UPDATE admin.clients SET max_orgs=${baseline + 1}, extra_orgs=0, bonus_orgs=0 WHERE slug='test'`,
  );
});

afterAll(async () => {
  // Supprime les orgs créées par la rafale + restaure le quota.
  await execSql(
    `DELETE FROM "${TENANT_SCHEMA}"."Organization" WHERE name LIKE 'qrace-%'`,
  ).catch(() => {});
  await execSql(
    `UPDATE admin.clients SET max_orgs=${savedQuota.maxOrgs}, extra_orgs=${savedQuota.extraOrgs}, bonus_orgs=${savedQuota.bonusOrgs} WHERE slug='test'`,
  ).catch(() => {});
});

describe("§2.24e — la création d'orgs reste bornée au quota sous rafale concurrente", () => {
  it("un seul slot libre : 1 seule création réussit, le total ne dépasse pas le quota", async () => {
    const results = await Promise.all(
      Array.from({ length: BURST }, (_, i) =>
        postJson(admin, "/api/orgs", { name: `qrace-${Date.now()}-${i}` }),
      ),
    );
    const statuses = results.map((r) => r.status);
    const created = statuses.filter((s) => s === 201).length;
    const refused = statuses.filter((s) => s === 403).length;

    // Coeur du fix : exactement 1 création malgré BURST requêtes concurrentes.
    expect(created).toBe(1);
    expect(refused).toBe(BURST - 1);

    // Invariant dur : le total d'orgs n'a pas dépassé le quota (baseline + 1).
    expect(await orgCount()).toBe(baseline + 1);
  });
});
