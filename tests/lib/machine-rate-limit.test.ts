// #2 — rate-limit par token des endpoints de fetch machine (Bearer).
// Teste le contrat du helper : plafond 120/min PAR token, 429 au dépassement,
// log d'audit du 429, et buckets indépendants entre tokens.
//
// `logAction` est mocké → le test reste sans DB et vérifie que le 429 est bien
// journalisé (reason: rate_limited).

import { describe, it, expect, vi, beforeEach } from "vitest";

const logActionMock = vi.fn();
vi.mock("@/lib/audit", () => ({
  logAction: (...args: unknown[]) => logActionMock(...args),
}));

import { machineFetchRateLimited } from "@/lib/machine-rate-limit";

function fakeReq(): Request {
  return new Request("http://localhost/api/secrets/x/prod");
}

function audit(tokenId: string) {
  return { tokenId, tokenName: "ci", tenantSlug: "test", projectId: "p1" };
}

describe("machineFetchRateLimited (#2 — plafond par token)", () => {
  beforeEach(() => logActionMock.mockClear());

  it("laisse passer 120 requêtes puis bloque la 121e (429)", () => {
    const tokenId = `tok-${Math.floor(performance.now())}-a`;
    for (let i = 0; i < 120; i++) {
      expect(machineFetchRateLimited(fakeReq(), audit(tokenId))).toBeNull();
    }
    const blocked = machineFetchRateLimited(fakeReq(), audit(tokenId));
    expect(blocked).not.toBeNull();
    expect(blocked!.status).toBe(429);
  });

  it("journalise le 429 en TOKEN_USE_FAILED{reason:rate_limited} avec le tenant", () => {
    const tokenId = `tok-${Math.floor(performance.now())}-b`;
    for (let i = 0; i < 120; i++) machineFetchRateLimited(fakeReq(), audit(tokenId));
    expect(logActionMock).not.toHaveBeenCalled(); // aucun log sous la limite
    machineFetchRateLimited(fakeReq(), audit(tokenId)); // 121e
    expect(logActionMock).toHaveBeenCalledTimes(1);
    const entry = logActionMock.mock.calls[0][0];
    expect(entry.action).toBe("TOKEN_USE_FAILED");
    expect(entry.metadata).toMatchObject({ reason: "rate_limited", limitPerMin: 120 });
    expect(entry.tenantSlug).toBe("test");
    expect(entry.actor).toMatchObject({ kind: "token", tokenId });
  });

  it("chaque token a son propre bucket (pas d'impact croisé)", () => {
    const a = `tok-${Math.floor(performance.now())}-c`;
    const b = `tok-${Math.floor(performance.now())}-d`;
    for (let i = 0; i < 121; i++) machineFetchRateLimited(fakeReq(), audit(a)); // sature A
    // B n'est pas affecté par la saturation de A.
    expect(machineFetchRateLimited(fakeReq(), audit(b))).toBeNull();
  });
});
