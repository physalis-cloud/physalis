// Parité des clés d'email entre fr / en / es.
//
// Une clé absente d'UNE SEULE langue ne casse ni le typage ni le build : elle
// ne se manifeste qu'au runtime, en production, et seulement pour les
// utilisateurs de cette langue — c'est-à-dire au pire endroit et au pire
// moment. Les emails sont particulièrement exposés : ils partent depuis des
// routes API, des webhooks et des crons, donc loin de tout écran où l'anomalie
// se verrait.
//
// Ce test compare la FORME (l'arborescence des clés), pas les traductions.

import { describe, expect, it } from "vitest";
import en from "../../messages/en.json";
import fr from "../../messages/fr.json";
import es from "../../messages/es.json";

/** Chemins de toutes les feuilles, triés — « emails.invitation.subject », … */
function leafPaths(node: unknown, prefix = ""): string[] {
  if (node === null || typeof node !== "object") return [prefix];
  return Object.entries(node as Record<string, unknown>)
    .flatMap(([k, v]) => leafPaths(v, prefix ? `${prefix}.${k}` : k))
    .sort();
}

const LOCALES = { fr, es } as const;

describe("parité des clés du namespace `emails`", () => {
  const reference = leafPaths((en as Record<string, unknown>).emails);

  it("le namespace de référence n'est pas vide (garde anti-test-creux)", () => {
    // Sans cette assertion, un renommage du namespace rendrait le test vert en
    // comparant deux ensembles vides.
    expect(reference.length).toBeGreaterThan(20);
  });

  for (const [name, messages] of Object.entries(LOCALES)) {
    it(`${name} a exactement les mêmes clés que en`, () => {
      const paths = leafPaths((messages as Record<string, unknown>).emails);
      expect({
        manquantes: reference.filter((k) => !paths.includes(k)),
        enTrop: paths.filter((k) => !reference.includes(k)),
      }).toEqual({ manquantes: [], enTrop: [] });
    });
  }
});
