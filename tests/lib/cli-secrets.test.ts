// C-0050 (agent-ssh), phase 2c — quels environnements `physalis pull` peut
// écrire en clair sur le poste. Le parcours HTTP est prouvé par
// tests/integ/cli-session.

import { describe, it, expect } from "vitest";
import { isPullableEnvironment } from "@/lib/cli-secrets";

describe("isPullableEnvironment — liste fermée de noms de dev", () => {
  it("accepte les noms de développement, quelle que soit la casse", () => {
    for (const name of ["development", "dev", "local", "test", "testing", "sandbox", "Development", " DEV "]) {
      expect(isPullableEnvironment(name), name).toBe(true);
    }
  });

  it("refuse la production sous tous ses noms, et staging", () => {
    for (const name of ["production", "prod", "main", "live", "prd", "staging", "preprod", "master"]) {
      expect(isPullableEnvironment(name), name).toBe(false);
    }
  });

  it("refuse un nom qui ne fait que ressembler à du dev", () => {
    for (const name of ["dev-prod", "development2", "developpement", "test-prod", ""]) {
      expect(isPullableEnvironment(name), name).toBe(false);
    }
  });
});
