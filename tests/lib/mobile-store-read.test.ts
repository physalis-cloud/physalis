// Lecture des magasins (lib/mobile-store-read.ts) + numéro de build autoritatif
// (lib/mobile-bundle.ts) — Phase 5, cf. deploiement-mobile.md §4.5.
//
// Les appels HTTP eux-mêmes ne sont pas simulés : ils suivront la règle du
// chantier, un test de fumée sur du vrai matériel. Ce qui EST testé ici, c'est
// la logique qui décide — et qui, elle, se trompe en silence :
//
//   - `max(magasin, dernier servi) + 1` : un numéro régressif serait refusé par
//     Google, plusieurs minutes après le build ;
//   - le REPLI : `null` doit ramener exactement le comportement d'avant la
//     Phase 5, sans quoi une panne de Google casserait toutes les livraisons ;
//   - la traduction des états, où confondre « traité » et « en ligne » ferait
//     mentir l'écran.

import { describe, it, expect, vi } from "vitest";
import { consumeBuildNumber } from "@/lib/mobile-bundle";
import { ascStateToRelease, playStatusToRelease } from "@/lib/mobile-store-read";

/** Faux client Prisma : compteur en mémoire + un `$queryRaw` qui applique
 *  réellement le `GREATEST(...) + 1` du SQL, pour tester la RÈGLE. */
function fakeDb(initial: number, versionName: string | null = "1.0") {
  const state = { buildNumber: initial, versionName };
  return {
    state,
    mobileApp: {
      update: vi.fn(async () => {
        state.buildNumber += 1;
        return { buildNumber: state.buildNumber, versionName: state.versionName };
      }),
    },
    $queryRaw: vi.fn(async (_q: TemplateStringsArray, ...values: unknown[]) => {
      const [floor] = values as [number, string];
      state.buildNumber = Math.max(state.buildNumber, floor) + 1;
      return [{ buildNumber: state.buildNumber, versionName: state.versionName }];
    }),
  };
}

type Db = Parameters<typeof consumeBuildNumber>[0];

describe("consumeBuildNumber — le numéro autoritatif (§4.5)", () => {
  it("sans magasin, se comporte EXACTEMENT comme avant la Phase 5", async () => {
    const db = fakeDb(10);
    const r = await consumeBuildNumber(db as unknown as Db, "app1", null);
    expect(r.buildNumber).toBe(11);
    // Le chemin `increment` de Prisma, pas le SQL brut : c'est le repli, et il
    // ne doit rien coûter de plus.
    expect(db.mobileApp.update).toHaveBeenCalledOnce();
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });

  it("le magasin RATTRAPE un compteur local en retard", async () => {
    // Cas réel : quelqu'un a téléversé à la main depuis la console. Le magasin
    // est à 42, le compteur local est resté à 10.
    const db = fakeDb(10);
    const r = await consumeBuildNumber(db as unknown as Db, "app1", 42);
    expect(r.buildNumber).toBe(43);
  });

  it("le magasin ne fait JAMAIS reculer le compteur", async () => {
    // Cas symétrique, tout aussi réel : un build servi mais jamais téléversé
    // (run annulé). Le local est en avance ; suivre le magasin re-servirait un
    // numéro déjà distribué.
    const db = fakeDb(50);
    const r = await consumeBuildNumber(db as unknown as Db, "app1", 42);
    expect(r.buildNumber).toBe(51);
  });

  it("à égalité, avance quand même d'un cran", async () => {
    const db = fakeDb(42);
    const r = await consumeBuildNumber(db as unknown as Db, "app1", 42);
    expect(r.buildNumber).toBe(43);
  });

  it("un magasin à zéro n'écrase pas le compteur local", async () => {
    // `0` est une valeur, pas une absence — le piège classique du falsy.
    const db = fakeDb(7);
    const r = await consumeBuildNumber(db as unknown as Db, "app1", 0);
    expect(r.buildNumber).toBe(8);
  });

  it("deux appels successifs ne servent jamais le même numéro", async () => {
    const db = fakeDb(10);
    const a = await consumeBuildNumber(db as unknown as Db, "app1", 42);
    const b = await consumeBuildNumber(db as unknown as Db, "app1", 42);
    expect(a.buildNumber).toBe(43);
    expect(b.buildNumber).toBe(44);
  });

  it("lève si l'application a disparu entre-temps", async () => {
    const db = {
      mobileApp: { update: vi.fn() },
      $queryRaw: vi.fn(async () => []),
    };
    await expect(
      consumeBuildNumber(db as unknown as Db, "fantome", 1),
    ).rejects.toThrow(/introuvable/);
  });
});

describe("traduction des états magasin", () => {
  it("Play : un déploiement progressif EST en ligne", () => {
    // `inProgress` = servi à une fraction des utilisateurs. Le ranger ailleurs
    // que dans « en ligne » laisserait croire que rien n'est publié.
    expect(playStatusToRelease("inProgress")).toBe("live");
    expect(playStatusToRelease("completed")).toBe("live");
    expect(playStatusToRelease("halted")).toBe("halted");
    expect(playStatusToRelease("draft")).toBe("uploaded");
  });

  it("Apple : VALID veut dire « traité », PAS « en ligne »", () => {
    // Le passage en revue puis en vente relève d'appStoreVersions, que la
    // Phase 5 ne lit pas. Annoncer `live` ici serait un mensonge confortable.
    expect(ascStateToRelease("VALID")).toBe("uploaded");
    expect(ascStateToRelease("PROCESSING")).toBe("processing");
    expect(ascStateToRelease("FAILED")).toBe("failed");
    expect(ascStateToRelease("INVALID")).toBe("rejected");
  });

  it("un état inconnu ne casse pas l'écran", () => {
    expect(playStatusToRelease("quelqueChoseDeNeuf")).toBe("uploaded");
    expect(ascStateToRelease("QUELQUE_CHOSE")).toBe("uploaded");
  });
});
