// Régression du bug ADMIN_DEV : la feature « demandes externes » filtrait les
// orgs avec ["OWNER","ADMIN","DEV"] en dur → ADMIN_DEV (pourtant DEV+) exclu.
// Source unique `ORG_DEV_PLUS_ROLES` + ce test empêchent la ré-omission (§4).

import { describe, it, expect } from "vitest";
import type { OrgRole } from "@prisma/client";
import { ORG_DEV_PLUS_ROLES, hasDevPrivileges } from "@/lib/roles";

const ALL_ORG_ROLES: OrgRole[] = [
  "OWNER",
  "ADMIN",
  "ADMIN_DEV",
  "DEV",
  "MEMBER",
];

describe("ORG_DEV_PLUS_ROLES (source unique DEV+)", () => {
  it("inclut ADMIN_DEV (le bug corrigé)", () => {
    expect(ORG_DEV_PLUS_ROLES).toContain<OrgRole>("ADMIN_DEV");
  });

  it("= {OWNER, ADMIN, ADMIN_DEV, DEV} et exclut MEMBER", () => {
    expect([...ORG_DEV_PLUS_ROLES].sort()).toEqual([
      "ADMIN",
      "ADMIN_DEV",
      "DEV",
      "OWNER",
    ]);
    expect(ORG_DEV_PLUS_ROLES).not.toContain<OrgRole>("MEMBER");
  });

  it("couvre TOUT rôle disposant des droits DEV (pas d'omission possible)", () => {
    for (const r of ALL_ORG_ROLES) {
      if (hasDevPrivileges(r)) {
        expect(ORG_DEV_PLUS_ROLES).toContain(r);
      }
    }
  });
});
