// §4 — « Fermer le générateur ».
//
// Les 6 règles d'accès aux projets existaient en prose, ré-implémentées à la
// main sous TROIS formes incompatibles sur ~20 sites : rôle effectif sur un
// projet (« point »), clause WHERE d'un listing, filtre en mémoire. Les
// commentaires affirmaient « miroir STRICT » — rien ne le vérifiait.
//
// Ce test est le mécanisme qui manquait. Il évalue la matrice complète
// (platformRole × OrgRole × état de la ligne ProjectMember) et asserte que
// **les trois formes sont d'accord** sur chaque cas. Une divergence comme celle
// d'ADMIN_DEV (absent de `vault-access.ts`, présent dans `ORG_ROLE_RANK`) est
// exactement ce qu'il attrape.
//
// Aucune base : la forme WHERE est évaluée en mémoire par un mini-interpréteur
// des seules formes que `accessibleProjectsWhere` produit.

import { describe, it, expect } from "vitest";
import type { OrgRole, ProjectRole, Prisma } from "@prisma/client";
import {
  effectiveProjectRole,
  accessibleProjectsWhere,
  filterAccessibleProjects,
  hasProjectRole,
  resolveOrgRole,
  desiredMembershipRow,
  isDesiredProjectAccess,
  type DesiredProjectAccess,
} from "@/lib/project-access";

const ORG_ROLES: Array<OrgRole | null> = [
  "OWNER",
  "ADMIN",
  "ADMIN_DEV",
  "DEV",
  "MEMBER",
  null, // pas membre de l'org
];

type MembershipCase = {
  label: string;
  membership: { role: ProjectRole; hidden: boolean } | null;
};

const MEMBERSHIPS: MembershipCase[] = [
  { label: "aucune ligne", membership: null },
  { label: "hidden", membership: { role: "EDITOR", hidden: true } },
  { label: "VIEWER", membership: { role: "VIEWER", hidden: false } },
  { label: "EDITOR", membership: { role: "EDITOR", hidden: false } },
  { label: "OWNER", membership: { role: "OWNER", hidden: false } },
];

const PLATFORM_ROLES = ["MEMBER", "ADMIN", "SUPERADMIN"] as const;

const USER = "u1";
const ORG = "org1";

/**
 * Mini-interpréteur des SEULES formes produites par `accessibleProjectsWhere` :
 *   { organizationId }
 *   { organizationId, members: { none: { userId, hidden: true } } }
 *   { organizationId, members: { some: { userId, hidden: false } } }
 *
 * Throw sur toute autre forme : si la clause évolue, ce test doit être mis à
 * jour sciemment, pas silencieusement contourné.
 */
function whereMatches(
  where: Prisma.ProjectWhereInput,
  project: {
    organizationId: string;
    members: Array<{ userId: string; hidden: boolean }>;
  },
): boolean {
  const keys = Object.keys(where);
  const unknown = keys.filter((k) => k !== "organizationId" && k !== "members");
  if (unknown.length > 0) {
    throw new Error(`forme WHERE non gérée par le test : ${unknown.join(",")}`);
  }
  if (where.organizationId !== project.organizationId) return false;

  const members = where.members as
    | {
        none?: { userId: string; hidden: boolean };
        some?: { userId: string; hidden: boolean };
      }
    | undefined;
  if (!members) return true;

  if (members.none) {
    const { userId, hidden } = members.none;
    return !project.members.some(
      (m) => m.userId === userId && m.hidden === hidden,
    );
  }
  if (members.some) {
    const { userId, hidden } = members.some;
    return project.members.some(
      (m) => m.userId === userId && m.hidden === hidden,
    );
  }
  throw new Error("clause `members` sans `none` ni `some`");
}

describe("lib/project-access", () => {
  describe("effectiveProjectRole — les 6 règles", () => {
    it("règle 1 : OrgOWNER/ADMIN → OWNER, `hidden` ignoré", () => {
      for (const orgRole of ["OWNER", "ADMIN"] as const) {
        expect(
          effectiveProjectRole({
            orgRole,
            membership: { role: "VIEWER", hidden: true },
          }),
        ).toBe("OWNER");
      }
    });

    it("règle 1 : admin plateforme sans appartenance org → OWNER", () => {
      expect(
        effectiveProjectRole({
          orgRole: null,
          membership: null,
          platformRole: "SUPERADMIN",
        }),
      ).toBe("OWNER");
    });

    it("une appartenance org EXPLICITE prime sur l'admin plateforme", () => {
      // Comportement de requireProjectMember, à ne pas « simplifier » : un
      // SUPERADMIN qui est aussi OrgMEMBER reste MEMBER.
      expect(resolveOrgRole("MEMBER", "SUPERADMIN")).toBe("MEMBER");
      expect(
        effectiveProjectRole({
          orgRole: "MEMBER",
          membership: null,
          platformRole: "SUPERADMIN",
        }),
      ).toBeNull();
    });

    it("règle 2 : une ligne masquée bloque, SANS retomber sur le fallback DEV", () => {
      // Le cœur de la famille de bugs `hidden`.
      for (const orgRole of ["DEV", "ADMIN_DEV"] as const) {
        expect(
          effectiveProjectRole({
            orgRole,
            membership: { role: "OWNER", hidden: true },
          }),
        ).toBeNull();
      }
    });

    it("règle 3 : une ligne visible donne son rôle explicite", () => {
      for (const role of ["VIEWER", "EDITOR", "OWNER"] as const) {
        expect(
          effectiveProjectRole({
            orgRole: "MEMBER",
            membership: { role, hidden: false },
          }),
        ).toBe(role);
      }
    });

    it("règle 4 : DEV **et ADMIN_DEV** sans ligne → EDITOR implicite", () => {
      // ADMIN_DEV est précisément le rôle oublié par lib/vault-access.ts.
      for (const orgRole of ["DEV", "ADMIN_DEV"] as const) {
        expect(effectiveProjectRole({ orgRole, membership: null })).toBe(
          "EDITOR",
        );
      }
    });

    it("règle 5 : MEMBER sans ligne → aucun accès", () => {
      expect(
        effectiveProjectRole({ orgRole: "MEMBER", membership: null }),
      ).toBeNull();
    });

    it("règle 6 : non-membre de l'org sans ligne → aucun accès", () => {
      expect(
        effectiveProjectRole({ orgRole: null, membership: null }),
      ).toBeNull();
    });

    it("règle 6 : une ligne résiduelle ferait foi — d'où l'invariant maintenu en amont", () => {
      // Documente le comportement RÉEL, contraire à la prose d'origine (qui
      // annonçait un 403). Ce n'est PAS une faille : l'état « ligne
      // ProjectMember sans OrgMember » est rendu inatteignable par les deux
      // seules voies d'écriture — l'ajout exige l'appartenance org (404 sinon),
      // le retrait d'org purge en cascade. Ce test fige la conséquence si cet
      // invariant venait à tomber ; la cascade est gardée par un test integ.
      expect(
        effectiveProjectRole({
          orgRole: null,
          membership: { role: "EDITOR", hidden: false },
        }),
      ).toBe("EDITOR");
    });
  });

  describe("hasProjectRole", () => {
    it("respecte le rang VIEWER < EDITOR < OWNER", () => {
      expect(hasProjectRole("VIEWER", "EDITOR")).toBe(false);
      expect(hasProjectRole("EDITOR", "EDITOR")).toBe(true);
      expect(hasProjectRole("OWNER", "EDITOR")).toBe(true);
      expect(hasProjectRole(null, "VIEWER")).toBe(false);
    });
  });

  // ── LE test : les trois formes doivent être d'accord ──────────────────────
  describe("accord des trois formes sur la matrice complète", () => {
    const cases: Array<{
      platformRole: string;
      orgRole: OrgRole | null;
      m: MembershipCase;
    }> = [];
    for (const platformRole of PLATFORM_ROLES) {
      for (const orgRole of ORG_ROLES) {
        for (const m of MEMBERSHIPS) cases.push({ platformRole, orgRole, m });
      }
    }

    it(`couvre ${PLATFORM_ROLES.length} × ${ORG_ROLES.length} × ${MEMBERSHIPS.length} cas`, () => {
      expect(cases.length).toBe(
        PLATFORM_ROLES.length * ORG_ROLES.length * MEMBERSHIPS.length,
      );
    });

    for (const { platformRole, orgRole, m } of cases) {
      const label = `platform=${platformRole} org=${orgRole ?? "aucun"} membre=${m.label}`;

      it(`accord — ${label}`, () => {
        const resolved = resolveOrgRole(orgRole, platformRole);

        // Forme 1 — point.
        const role = effectiveProjectRole({
          orgRole,
          membership: m.membership,
          platformRole,
        });
        const pointGrants = role !== null;

        // Le projet tel qu'il existe en base.
        const project = {
          organizationId: ORG,
          members: m.membership
            ? [{ userId: USER, hidden: m.membership.hidden }]
            : [],
        };

        // Forme 2 — WHERE Prisma, évaluée en mémoire.
        const whereGrants = whereMatches(
          accessibleProjectsWhere(ORG, USER, resolved),
          project,
        );

        // Forme 3 — filtre mémoire.
        const memoryGrants =
          filterAccessibleProjects([project], USER, orgRole, platformRole)
            .length === 1;

        expect(
          { point: pointGrants, where: whereGrants, memory: memoryGrants },
          `divergence sur ${label} (rôle effectif = ${role})`,
        ).toEqual({
          point: pointGrants,
          where: pointGrants,
          memory: pointGrants,
        });
      });
    }
  });

  // NB : pas de test d'équivalence avec `lib/api.ts` — sa copie a été
  // supprimée, il ré-exporte celle-ci. Il n'y a plus qu'UNE implémentation,
  // ce qui vaut mieux qu'un test qui vérifierait que deux copies s'accordent.
  // (Et `lib/api.ts` tire next-auth : il est de toute façon inimportable en
  // test unitaire pur — raison d'être de ce module sans dépendance.)

  describe("filterAccessibleProjects", () => {
    it("ne retient que les projets accessibles", () => {
      const projects = [
        { id: "visible", members: [{ userId: USER, hidden: false }] },
        { id: "masqué", members: [{ userId: USER, hidden: true }] },
        { id: "sans ligne", members: [] },
        { id: "ligne d'un autre", members: [{ userId: "u2", hidden: false }] },
      ];
      // MEMBER : seule une ligne explicite non masquée donne accès.
      expect(
        filterAccessibleProjects(projects, USER, "MEMBER").map((p) => p.id),
      ).toEqual(["visible"]);
      // DEV : tout sauf ce qui le masque explicitement.
      expect(
        filterAccessibleProjects(projects, USER, "DEV").map((p) => p.id),
      ).toEqual(["visible", "sans ligne", "ligne d'un autre"]);
      // ADMIN_DEV doit se comporter comme DEV (le bug de vault-access.ts).
      expect(
        filterAccessibleProjects(projects, USER, "ADMIN_DEV").map((p) => p.id),
      ).toEqual(["visible", "sans ligne", "ligne d'un autre"]);
      // OWNER : tout, `hidden` ignoré.
      expect(filterAccessibleProjects(projects, USER, "OWNER")).toHaveLength(4);
    });
  });

  // Forme ÉCRITURE — réciproque de la forme POINT. Sans cet aller-retour, une
  // règle d'écriture (« décocher un DEV pose hidden ») pourrait diverger de la
  // règle de lecture sans que rien ne le signale : exactement le générateur de
  // bugs que ce module ferme.
  describe("desiredMembershipRow — aller-retour avec effectiveProjectRole", () => {
    const DESIRED: DesiredProjectAccess[] = [
      "NONE",
      "VIEWER",
      "EDITOR",
      "OWNER",
    ];

    for (const orgRole of ["ADMIN_DEV", "DEV", "MEMBER"] as const) {
      for (const desired of DESIRED) {
        it(`org=${orgRole} désiré=${desired} → accès effectif = ${desired}`, () => {
          const row = desiredMembershipRow(orgRole, desired);
          expect(
            effectiveProjectRole({ orgRole, membership: row }),
          ).toBe(desired === "NONE" ? null : desired);
        });
      }
    }

    it("n'écrit rien quand l'implicite suffit déjà", () => {
      // Un DEV a EDITOR partout sans ligne (règle 4) : lui « donner » EDITOR ne
      // doit PAS figer de ligne, qui lui survivrait à une rétrogradation.
      expect(desiredMembershipRow("DEV", "EDITOR")).toBeNull();
      expect(desiredMembershipRow("ADMIN_DEV", "EDITOR")).toBeNull();
      // Un MEMBER n'a rien sans ligne (règle 5) : le bloquer = ne rien écrire,
      // une barrière serait redondante.
      expect(desiredMembershipRow("MEMBER", "NONE")).toBeNull();
    });

    it("pose une barrière — et pas un rôle — pour couper un accès implicite", () => {
      expect(desiredMembershipRow("DEV", "NONE")).toEqual({
        role: "VIEWER",
        hidden: true,
      });
    });

    it("ne produit aucune ligne pour les cibles où elle serait sans effet", () => {
      // OrgOWNER/ADMIN : OWNER implicite, `hidden` ignoré (règle 1).
      for (const orgRole of ["OWNER", "ADMIN"] as const) {
        for (const desired of DESIRED) {
          expect(desiredMembershipRow(orgRole, desired)).toBeNull();
        }
      }
      // Non-membre de l'org : règle 6, aucune ligne ne doit subsister.
      for (const desired of DESIRED) {
        expect(desiredMembershipRow(null, desired)).toBeNull();
      }
    });

    it("valide les valeurs venues du réseau", () => {
      expect(isDesiredProjectAccess("NONE")).toBe(true);
      expect(isDesiredProjectAccess("EDITOR")).toBe(true);
      expect(isDesiredProjectAccess("editor")).toBe(false);
      expect(isDesiredProjectAccess("ADMIN")).toBe(false);
      expect(isDesiredProjectAccess(null)).toBe(false);
    });
  });
});
