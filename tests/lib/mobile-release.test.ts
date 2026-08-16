// Registre de livraisons (lib/mobile-release.ts) — Phase 3, cf.
// documentation/plans/deploiement-mobile.md §5.3.
//
// Ce qui mérite d'être testé ici n'est pas « Prisma écrit une ligne », c'est la
// RÈGLE DE RATTACHEMENT : un rapport du CI doit rejoindre la ligne ouverte au
// moment où le bundle a été servi, parce que c'est elle qui porte les empreintes
// du matériel. Se tromper de ligne ferait silencieusement perdre la corrélation
// matériel↔version, c'est-à-dire l'essentiel de la valeur de la phase.
//
// Le client Prisma est remplacé par un faux en mémoire : la logique testée est
// du choix de ligne, pas du SQL.

import { describe, it, expect, beforeEach } from "vitest";
import {
  isValidReleaseStatus,
  isValidTrack,
  openRelease,
  recordReport,
} from "@/lib/mobile-release";

type Row = Record<string, unknown> & { id: string };

/** Faux client : un tableau de lignes + le strict nécessaire de l'API Prisma. */
function fakeDb() {
  const rows: Row[] = [];
  let seq = 0;
  const matches = (row: Row, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => row[k] === v);

  return {
    rows,
    /** Force l'échec de `create` — pour prouver que `openRelease` ne lève pas. */
    breakCreate: false,
    mobileRelease: {
      async findFirst(args: unknown) {
        const a = args as { where: Record<string, unknown> };
        // `orderBy: requestedAt desc` : les lignes sont insérées dans l'ordre,
        // donc la plus récente est la dernière qui correspond.
        const found = [...rows].reverse().find((r) => matches(r, a.where));
        return found ?? null;
      },
      async create(args: unknown) {
        const self = db as { breakCreate: boolean };
        if (self.breakCreate) throw new Error("écriture refusée");
        const a = args as { data: Record<string, unknown> };
        const row: Row = { id: `rel_${++seq}`, ...a.data };
        rows.push(row);
        return row;
      },
      async update(args: unknown) {
        const a = args as { where: { id: string }; data: Record<string, unknown> };
        const row = rows.find((r) => r.id === a.where.id);
        if (!row) throw new Error("ligne absente");
        Object.assign(row, a.data);
        return row;
      },
    },
  };
}

let db: ReturnType<typeof fakeDb>;
beforeEach(() => {
  db = fakeDb();
});

const CI = { provider: "github", repo: "argo-web/app", ref: "main" };
const SHA = { ios_p12: "AAAA", ios_profile: "BBBB" };

describe("vocabulaire fermé", () => {
  it("n'accepte que les pistes et statuts connus", () => {
    expect(isValidTrack("internal")).toBe(true);
    expect(isValidTrack("testflight")).toBe(true);
    expect(isValidTrack("prod")).toBe(false);
    expect(isValidReleaseStatus("live")).toBe(true);
    expect(isValidReleaseStatus("publié")).toBe(false);
  });
});

describe("openRelease", () => {
  it("ouvre la ligne en `pending` avec les empreintes réellement servies", async () => {
    const id = await openRelease(db, {
      appId: "app1",
      buildNumber: 42,
      versionName: "1.4",
      credentialsSha: SHA,
      ci: CI,
    });
    expect(id).toBeTruthy();
    expect(db.rows[0]).toMatchObject({
      track: "pending",
      status: "requested",
      // Numéro de build STOCKÉ EN TEXTE : iOS accepte "1.2.3", pas seulement
      // un entier.
      buildNumber: "42",
      credentialsSha: SHA,
      ciRepo: "argo-web/app",
    });
  });

  it("ne lève JAMAIS — le registre ne doit pas casser un déploiement", async () => {
    db.breakCreate = true;
    // C'est l'invariant qui compte : le bundle est le chemin critique, le
    // registre est de l'observabilité. Même arbitrage que le miroir
    // admin.policies et que le numéro de build (§4.5).
    await expect(
      openRelease(db, {
        appId: "app1",
        buildNumber: 1,
        versionName: null,
        credentialsSha: {},
        ci: CI,
      }),
    ).resolves.toBeNull();
  });
});

describe("recordReport — la règle de rattachement", () => {
  it("rejoint la ligne `pending` du même build, et garde ses empreintes", async () => {
    await openRelease(db, {
      appId: "app1",
      buildNumber: 42,
      versionName: "1.4",
      credentialsSha: SHA,
      ci: CI,
    });

    const out = await recordReport(db, {
      appId: "app1",
      buildNumber: "42",
      track: "testflight",
      status: "uploaded",
      ci: CI,
    });

    expect(out.correlated).toBe(true);
    // UNE seule ligne : le rapport a rejoint l'existante, il n'en a pas créé
    // une seconde. Un doublon casserait l'historique en deux moitiés dont
    // aucune ne serait complète.
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0]).toMatchObject({
      track: "testflight",
      status: "uploaded",
      credentialsSha: SHA,
    });
    expect(db.rows[0].reportedAt).toBeInstanceOf(Date);
  });

  it("un second rapport affine le statut sans dupliquer la ligne", async () => {
    await openRelease(db, {
      appId: "app1",
      buildNumber: 42,
      versionName: "1.4",
      credentialsSha: SHA,
      ci: CI,
    });
    await recordReport(db, {
      appId: "app1", buildNumber: "42", track: "testflight", status: "uploaded", ci: CI,
    });
    const out = await recordReport(db, {
      appId: "app1", buildNumber: "42", track: "testflight", status: "live", ci: CI,
    });

    expect(db.rows).toHaveLength(1);
    expect(db.rows[0].status).toBe("live");
    // La corrélation SURVIT au second rapport : la ligne porte toujours les
    // empreintes, même si le `pending` a disparu.
    expect(out.correlated).toBe(true);
  });

  it("crée une ligne NON corrélée quand Physalis n'a pas servi le matériel", async () => {
    const out = await recordReport(db, {
      appId: "app1",
      buildNumber: "7",
      track: "internal",
      status: "uploaded",
      ci: CI,
    });
    // On enregistre quand même — un historique qui tait ce qu'il n'a pas
    // orchestré serait trompeur — mais sans empreintes, donc `correlated: false`.
    // C'est une information de sécurité : quelqu'un a publié sous une identité
    // de pipeline valide sans passer par le coffre.
    expect(out.correlated).toBe(false);
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0].credentialsSha).toEqual({});
  });

  it("ne rejoint PAS le `pending` d'un autre numéro de build", async () => {
    await openRelease(db, {
      appId: "app1", buildNumber: 42, versionName: "1.4", credentialsSha: SHA, ci: CI,
    });
    const out = await recordReport(db, {
      appId: "app1", buildNumber: "43", track: "internal", status: "uploaded", ci: CI,
    });
    expect(out.correlated).toBe(false);
    expect(db.rows).toHaveLength(2);
    // Le pending de 42 reste intact : un rapport sur 43 ne doit pas le
    // consommer, sinon le build 42 perdrait sa trace.
    expect(db.rows[0]).toMatchObject({ buildNumber: "42", track: "pending" });
  });

  it("ne rejoint PAS le `pending` d'une autre application", async () => {
    await openRelease(db, {
      appId: "app1", buildNumber: 42, versionName: null, credentialsSha: SHA, ci: CI,
    });
    const out = await recordReport(db, {
      appId: "app2", buildNumber: "42", track: "internal", status: "uploaded", ci: CI,
    });
    expect(out.correlated).toBe(false);
    expect(db.rows[0]).toMatchObject({ appId: "app1", track: "pending" });
  });

  it("le versionName du rapport ne peut pas EFFACER celui du bundle", async () => {
    await openRelease(db, {
      appId: "app1", buildNumber: 42, versionName: "1.4", credentialsSha: SHA, ci: CI,
    });
    await recordReport(db, {
      appId: "app1", buildNumber: "42", track: "internal", status: "uploaded",
      versionName: null, ci: CI,
    });
    // Physalis a servi "1.4" ; un rapport muet sur la version ne doit pas la
    // remplacer par du vide.
    expect(db.rows[0].versionName).toBe("1.4");
  });
});
