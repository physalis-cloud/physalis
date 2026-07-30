// Fenêtre de récupération « suppression de compte » — règles pures.
//
// Ce fichier existe surtout pour UN cas : le webhook Stripe
// `customer.subscription.deleted` écrasait `PENDING_DELETION` en `SUSPENDED`,
// ce qui faisait disparaître le compte du filtre de `runAccountPurge` — la
// suppression demandée n'arrivait jamais, sans le moindre signal. Le défaut
// était invisible en FREE (pas d'abonnement → pas de webhook) et systématique
// en payant, donc exactement le genre de chose qu'un flux jamais exercé en
// live ne révèle pas.

import { describe, expect, it } from "vitest";
import {
  RECOVERY_WINDOW_DAYS,
  accountLockState,
  daysUntilPurge,
  hasExportedSinceRequest,
  orgsLeftWithoutOwner,
  tenantPurgeEligibility,
  IMMEDIATE_PURGE_FLOOR_DAYS,
  subscriptionDeletedOutcome,
} from "@/lib/deletion-window";

const REQUESTED = new Date("2026-07-26T10:00:00Z");

describe("RECOVERY_WINDOW_DAYS", () => {
  it("vaut 30 jours (règle métier, pas un réglage technique)", () => {
    expect(RECOVERY_WINDOW_DAYS).toBe(30);
  });
});

describe("subscriptionDeletedOutcome", () => {
  it("RÉGRESSION — compte PAYANT en cours de suppression : le statut est préservé", () => {
    // Le cas qui cassait : /api/account/delete annule l'abonnement puis pose
    // PENDING_DELETION ; le webhook arrive après. S'il repasse en SUSPENDED,
    // le compte sort du filtre de purge et n'est JAMAIS supprimé.
    expect(
      subscriptionDeletedOutcome({
        plan: "SHARED",
        deletionRequestedAt: REQUESTED,
      }),
    ).toBe("keep_deletion_pending");
  });

  it("compte FREE en cours de suppression : préservé aussi, et signalé comme tel", () => {
    // Les deux gardes s'appliquent ; la suppression prime pour que la note
    // d'audit dise la bonne chose.
    expect(
      subscriptionDeletedOutcome({
        plan: "FREE",
        deletionRequestedAt: REQUESTED,
      }),
    ).toBe("keep_deletion_pending");
  });

  it("downgrade volontaire vers FREE : statut préservé (garde préexistant)", () => {
    expect(
      subscriptionDeletedOutcome({ plan: "FREE", deletionRequestedAt: null }),
    ).toBe("keep_free");
  });

  it("fin d'abonnement subie sur un compte payant : SUSPENDED (chemin nominal)", () => {
    // Le correctif ne doit pas neutraliser le comportement normal du webhook.
    expect(
      subscriptionDeletedOutcome({ plan: "SHARED", deletionRequestedAt: null }),
    ).toBe("suspend");
    expect(
      subscriptionDeletedOutcome({
        plan: "DEDICATED",
        deletionRequestedAt: null,
      }),
    ).toBe("suspend");
  });

  it("client introuvable (plan null) : traité comme une suspension", () => {
    // Défensif : le handler passe null quand le findUnique ne renvoie rien.
    // Suspendre est le choix conservateur — réversible, contrairement à une
    // purge.
    expect(
      subscriptionDeletedOutcome({ plan: null, deletionRequestedAt: null }),
    ).toBe("suspend");
  });
});

describe("accountLockState", () => {
  it("sa propre suppression → espace verrouillé", () => {
    expect(
      accountLockState({
        userDeletionRequestedAt: REQUESTED,
        tenantStatus: "ACTIVE",
      }),
    ).toBe("locked");
  });

  it("suppression du TENANT seule → lecture seule, PAS de verrou", () => {
    // Arbitrage explicite : un blocage dur arrêterait l'entreprise pendant
    // toute la fenêtre, et si l'owner se ravise au jour 20 cette coupure
    // n'aura servi à rien. Bandeau + export suffisent.
    expect(
      accountLockState({
        userDeletionRequestedAt: null,
        tenantStatus: "PENDING_DELETION",
      }),
    ).toBe("read_only");
  });

  it("les deux à la fois → le verrou personnel prime", () => {
    expect(
      accountLockState({
        userDeletionRequestedAt: REQUESTED,
        tenantStatus: "PENDING_DELETION",
      }),
    ).toBe("locked");
  });

  it("rien en cours → aucun état", () => {
    expect(
      accountLockState({ userDeletionRequestedAt: null, tenantStatus: "ACTIVE" }),
    ).toBe("none");
    expect(
      accountLockState({ userDeletionRequestedAt: null, tenantStatus: null }),
    ).toBe("none");
  });
});

describe("daysUntilPurge", () => {
  const now = new Date("2026-07-26T10:00:00Z");

  it("arrondit au SUPÉRIEUR — 6 h restantes annoncent encore 1 jour", () => {
    // Annoncer « 0 jour » à quelqu'un qui a encore six heures pour récupérer
    // ses secrets serait le pire des arrondis.
    expect(daysUntilPurge(new Date("2026-07-26T16:00:00Z"), now)).toBe(1);
  });

  it("compte les jours pleins", () => {
    expect(daysUntilPurge(new Date("2026-08-25T10:00:00Z"), now)).toBe(30);
  });

  it("échéance dépassée → 0, jamais un négatif", () => {
    // Une purge en retard (cron muet) doit afficher « aujourd'hui », pas
    // « il y a -3 jours ».
    expect(daysUntilPurge(new Date("2026-07-23T10:00:00Z"), now)).toBe(0);
  });

  it("pas d'échéance → null", () => {
    expect(daysUntilPurge(null, now)).toBeNull();
  });
});

describe("hasExportedSinceRequest", () => {
  it("export ANTÉRIEUR à la demande : ne compte pas", () => {
    // Un export d'il y a six mois ne dit rien de la volonté de la personne de
    // récupérer ses données maintenant — sinon le plancher côté owner
    // s'ouvrirait sur des exports fantômes.
    expect(
      hasExportedSinceRequest({
        dataExportedAt: new Date("2026-01-01T00:00:00Z"),
        deletionRequestedAt: REQUESTED,
      }),
    ).toBe(false);
  });

  it("export postérieur à la demande : compte", () => {
    expect(
      hasExportedSinceRequest({
        dataExportedAt: new Date("2026-07-26T11:00:00Z"),
        deletionRequestedAt: REQUESTED,
      }),
    ).toBe(true);
  });

  it("jamais exporté : ne compte pas", () => {
    expect(
      hasExportedSinceRequest({
        dataExportedAt: null,
        deletionRequestedAt: REQUESTED,
      }),
    ).toBe(false);
  });

  it("hors processus de suppression : tout export compte", () => {
    expect(
      hasExportedSinceRequest({
        dataExportedAt: new Date("2026-01-01T00:00:00Z"),
        deletionRequestedAt: null,
      }),
    ).toBe(true);
  });
});

describe("orgsLeftWithoutOwner", () => {
  it("seul OWNER → l'org bloque, et elle est NOMMÉE", () => {
    // Le nom compte : la modale annonce « vous êtes le seul propriétaire de X »
    // AVANT toute saisie, au lieu de laisser l'utilisateur se heurter à un
    // refus générique après avoir tout tapé.
    expect(
      orgsLeftWithoutOwner([{ id: "o1", name: "Acme", ownerCount: 1 }]),
    ).toEqual([{ id: "o1", name: "Acme" }]);
  });

  it("co-propriétaire → ne bloque pas", () => {
    expect(
      orgsLeftWithoutOwner([{ id: "o1", name: "Acme", ownerCount: 2 }]),
    ).toEqual([]);
  });

  it("la règle porte sur TOUTES les orgs, pas seulement la principale", () => {
    // Partir en orphelinant une org secondaire est le même défaut que pour la
    // principale.
    expect(
      orgsLeftWithoutOwner([
        { id: "o1", name: "Principale", ownerCount: 3 },
        { id: "o2", name: "Secondaire", ownerCount: 1 },
      ]),
    ).toEqual([{ id: "o2", name: "Secondaire" }]);
  });

  it("aucune org possédée → rien ne bloque", () => {
    expect(orgsLeftWithoutOwner([])).toEqual([]);
  });

  it("ownerCount à 0 (donnée incohérente) → bloque quand même", () => {
    // Fail-closed : une org sans propriétaire du tout est déjà cassée, ce n'est
    // pas le moment d'y supprimer un compte de plus.
    expect(
      orgsLeftWithoutOwner([{ id: "o1", name: "Orpheline", ownerCount: 0 }]),
    ).toEqual([{ id: "o1", name: "Orpheline" }]);
  });
});

describe("tenantPurgeEligibility — le plancher", () => {
  const requested = new Date("2026-07-01T10:00:00Z");
  const exportedAfter = { dataExportedAt: new Date("2026-07-02T10:00:00Z") };
  const exportedBefore = { dataExportedAt: new Date("2026-06-01T10:00:00Z") };
  const never = { dataExportedAt: null };

  it("tous ont exporté → purge ouverte DÈS LE LENDEMAIN", () => {
    // Une équipe réactive ne doit pas retenir l'owner 7 jours pour rien.
    const r = tenantPurgeEligibility({
      deletionRequestedAt: requested,
      members: [exportedAfter, exportedAfter],
      now: new Date("2026-07-02T12:00:00Z"),
    });
    expect(r.allowed).toBe(true);
    expect(r).toMatchObject({ exported: 2, total: 2 });
  });

  it("un membre n'a pas exporté → bloqué tant que le plancher court", () => {
    const r = tenantPurgeEligibility({
      deletionRequestedAt: requested,
      members: [exportedAfter, never],
      now: new Date("2026-07-02T12:00:00Z"),
    });
    expect(r.allowed).toBe(false);
    expect(r).toMatchObject({ exported: 1, total: 2 });
    expect(r.floorDaysRemaining).toBeGreaterThan(0);
  });

  it("plancher écoulé → purge ouverte même si personne n'a exporté", () => {
    // Un salarié inactif ne prend pas le client en otage indéfiniment.
    const r = tenantPurgeEligibility({
      deletionRequestedAt: requested,
      members: [never, never],
      now: new Date(
        requested.getTime() + IMMEDIATE_PURGE_FLOOR_DAYS * 86_400_000,
      ),
    });
    expect(r.allowed).toBe(true);
    expect(r.floorDaysRemaining).toBe(0);
  });

  it("un export ANTÉRIEUR à la demande ne compte pas", () => {
    // Sinon le plancher s'ouvrirait sur des exports fantômes, vieux de six mois.
    const r = tenantPurgeEligibility({
      deletionRequestedAt: requested,
      members: [exportedBefore],
      now: new Date("2026-07-02T12:00:00Z"),
    });
    expect(r.allowed).toBe(false);
    expect(r.exported).toBe(0);
  });

  it("aucune demande en cours → jamais autorisé", () => {
    const r = tenantPurgeEligibility({
      deletionRequestedAt: null,
      members: [exportedAfter],
      now: new Date("2026-07-02T12:00:00Z"),
    });
    expect(r.allowed).toBe(false);
  });

  it("tenant sans membre → le plancher seul décide", () => {
    // `total === 0` ne doit pas passer pour « tout le monde a exporté » : la
    // condition serait vraie par vacuité et ouvrirait la purge immédiatement.
    const r = tenantPurgeEligibility({
      deletionRequestedAt: requested,
      members: [],
      now: new Date("2026-07-02T12:00:00Z"),
    });
    expect(r.allowed).toBe(false);
  });
});
