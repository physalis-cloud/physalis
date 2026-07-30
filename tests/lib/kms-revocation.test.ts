// Révocation KMS d'un tenant supprimé.
//
// L'invariant que ce fichier existe pour tenir : **la KEK transit n'est JAMAIS
// supprimée**. Une régression qui l'ajouterait à la liste rendrait
// définitivement illisibles les sauvegardes des clients — sur LEUR propre
// infrastructure, puisque `{blob, wDEK}` y sont stockés et que Physalis n'en
// détient aucune copie. Elle ne se verrait qu'après coup, au moment où
// quelqu'un essaierait de restaurer.
//
// Et l'inverse importe autant : conserver la KEK ne retient aucune donnée
// (sans le wDEK ni le blob, elle n'ouvre rien d'atteignable), donc il n'y a
// aucun compromis à faire — seulement un piège à éviter.
//
// Cf. lib/kms.ts et docs/steps-docs/todo/suppression-compte.md §D.

import { describe, expect, it } from "vitest";
import {
  kmsKeyNameForTenant,
  tenantKmsRevocationTargets,
} from "@/lib/kms";

const SLUG = "acme";

describe("tenantKmsRevocationTargets", () => {
  const targets = tenantKmsRevocationTargets(SLUG);
  const paths = targets.map((t) => t.path);

  it("INVARIANT — ne touche JAMAIS à la KEK transit", () => {
    const keyName = kmsKeyNameForTenant(SLUG); // "tenant-acme"
    for (const path of paths) {
      expect(path).not.toContain(`/keys/${keyName}`);
      expect(path).not.toContain("transit");
    }
  });

  it("révoque exactement les 2 AppRole et leurs 2 policies", () => {
    expect(targets.map((t) => t.label)).toEqual([
      "role/agent-tenant-acme",
      "role/restore-tenant-acme",
      "policy/agent-tenant-acme",
      "policy/restore-tenant-acme",
    ]);
  });

  it("supprime les RÔLES avant les policies", () => {
    // Une interruption au milieu doit laisser au pire une policy orpheline
    // (inoffensive), jamais un rôle vivant dont la policy a disparu.
    const firstPolicy = paths.findIndex((p) => p.includes("/policies/"));
    const lastRole = paths.map((p) => p.includes("/role/")).lastIndexOf(true);
    expect(lastRole).toBeLessThan(firstPolicy);
  });

  it("rejette un slug hors format (les chemins en dérivent)", () => {
    // Les noms de rôle et de policy sont interpolés dans une URL : un slug non
    // borné serait une injection de chemin sur l'API OpenBao.
    expect(() => tenantKmsRevocationTargets("../admin")).toThrow();
    expect(() => tenantKmsRevocationTargets("A_CME")).toThrow();
    expect(() => tenantKmsRevocationTargets("")).toThrow();
  });
});
