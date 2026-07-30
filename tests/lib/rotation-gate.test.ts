// §2.24c — le gate d'org de la rotation (feature org activée ET projet non en
// pause) n'était appliqué que dans le cron et le PATCH settings ; les routes
// « Forcer » l'ignoraient. Le prédicat `rotationGateOpen` est le cœur du fix,
// posé au chokepoint (rotators). On teste ses 4 combinaisons.

import { describe, it, expect } from "vitest";
import { rotationGateOpen, RotationDisabledError } from "@/lib/rotation-gate";

describe("rotationGateOpen (§2.24c)", () => {
  it("ouvert : feature org activée ET projet non en pause", () => {
    expect(
      rotationGateOpen({
        rotationPaused: false,
        organization: { rotationFeatureEnabled: true },
      }),
    ).toBe(true);
  });

  it("fermé : feature org DÉSACTIVÉE (décision admin org écrasée par un EDITOR)", () => {
    expect(
      rotationGateOpen({
        rotationPaused: false,
        organization: { rotationFeatureEnabled: false },
      }),
    ).toBe(false);
  });

  it("fermé : projet en PAUSE (kill-switch OWNER)", () => {
    expect(
      rotationGateOpen({
        rotationPaused: true,
        organization: { rotationFeatureEnabled: true },
      }),
    ).toBe(false);
  });

  it("fermé : org absente (défensif)", () => {
    expect(
      rotationGateOpen({ rotationPaused: false, organization: null }),
    ).toBe(false);
  });

  it("RotationDisabledError est une Error nommée", () => {
    const e = new RotationDisabledError();
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("RotationDisabledError");
  });
});
