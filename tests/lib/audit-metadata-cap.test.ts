// Garde-fou P5 (documentation/rapports/failles.md §40) : la metadata d'audit est bornée avant
// écriture, pour qu'une metadata anormalement grande ou non sérialisable ne
// puisse jamais faire échouer silencieusement l'écriture d'audit (seul vecteur
// théorique de l'échec silencieux du log — colonnes AccessLog toutes text/jsonb
// sans limite). `logAction` reste best-effort par design ; ce cap ferme le
// dernier moyen attaquant-influençable de provoquer sa perte.

import { describe, it, expect } from "vitest";
import { Prisma } from "@prisma/client";
import { capAuditMetadata } from "@/lib/audit";

describe("capAuditMetadata (P5 — borne défensive de la metadata d'audit)", () => {
  it("laisse passer une metadata légitime (petite) inchangée", () => {
    const meta = { reason: "invalid_token", slug: "acme", keys_count: 3 };
    expect(capAuditMetadata(meta)).toBe(meta);
  });

  it("undefined / null → Prisma.JsonNull (comportement historique)", () => {
    expect(capAuditMetadata(undefined)).toBe(Prisma.JsonNull);
    expect(capAuditMetadata(null as unknown as undefined)).toBe(Prisma.JsonNull);
  });

  it("une metadata > 16 KB est remplacée par un marqueur (entrée préservée)", () => {
    const huge = { blob: "x".repeat(20_000) };
    const out = capAuditMetadata(huge) as Record<string, unknown>;
    expect(out._audit).toBe("metadata_truncated");
    expect(typeof out._bytes).toBe("number");
    // Le contenu volumineux n'est PAS conservé.
    expect(JSON.stringify(out)).not.toContain("xxxx");
  });

  it("juste sous le cap passe, juste au-dessus est tronqué", () => {
    const under = { s: "a".repeat(16_000) };
    expect(capAuditMetadata(under)).toBe(under);
    const over = { s: "a".repeat(16_400) };
    expect((capAuditMetadata(over) as Record<string, unknown>)._audit).toBe(
      "metadata_truncated",
    );
  });

  it("une metadata non sérialisable (BigInt) → marqueur, jamais un throw", () => {
    const bad = { n: BigInt(1) } as unknown as Prisma.InputJsonValue;
    expect(() => capAuditMetadata(bad)).not.toThrow();
    expect((capAuditMetadata(bad) as Record<string, unknown>)._audit).toBe(
      "metadata_unserializable",
    );
  });
});
