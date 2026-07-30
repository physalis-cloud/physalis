// #2 — parsing défensif des accès projet stockés sur une invitation.

import { describe, it, expect } from "vitest";
import { parseInvitationProjectAccess } from "@/lib/invitation-project-access";

describe("parseInvitationProjectAccess", () => {
  it("garde les entrées valides {projectId, role}", () => {
    expect(
      parseInvitationProjectAccess([
        { projectId: "p1", role: "VIEWER" },
        { projectId: "p2", role: "EDITOR" },
        { projectId: "p3", role: "OWNER" },
      ]),
    ).toEqual([
      { projectId: "p1", role: "VIEWER" },
      { projectId: "p2", role: "EDITOR" },
      { projectId: "p3", role: "OWNER" },
    ]);
  });

  it("null / non-tableau → []", () => {
    expect(parseInvitationProjectAccess(null)).toEqual([]);
    expect(parseInvitationProjectAccess(undefined)).toEqual([]);
    expect(parseInvitationProjectAccess("x")).toEqual([]);
    expect(parseInvitationProjectAccess({})).toEqual([]);
  });

  it("ignore les entrées malformées (rôle invalide, projectId manquant, doublons)", () => {
    expect(
      parseInvitationProjectAccess([
        { projectId: "p1", role: "ADMIN" }, // rôle projet invalide
        { projectId: "", role: "VIEWER" }, // vide
        { role: "VIEWER" }, // pas de projectId
        { projectId: "p2" }, // pas de rôle
        "nope",
        null,
        { projectId: "p3", role: "VIEWER" }, // valide
        { projectId: "p3", role: "OWNER" }, // doublon → ignoré
      ]),
    ).toEqual([{ projectId: "p3", role: "VIEWER" }]);
  });
});
