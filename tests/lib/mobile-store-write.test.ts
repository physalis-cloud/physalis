// Actions sur les magasins (lib/mobile-store-write.ts) — Phase 6.
//
// ⚠️ Aucun appel réseau n'est simulé ici : ces fonctions modifient l'état PUBLIC
// d'une application, et un mock ne ferait que confirmer mes hypothèses sur
// l'API de Google. Elles suivront la règle du chantier — un test de fumée réel,
// et sur une piste sans conséquence.
//
// Ce qui EST testé, c'est la validation des ENTRÉES : c'est elle qui empêche
// qu'une saisie absurde parte jusqu'au magasin, et elle se vérifie sans réseau.

import { describe, it, expect } from "vitest";
import { isPlayTrack, isValidUserFraction } from "@/lib/mobile-store-write";

describe("isPlayTrack", () => {
  it("n'accepte que les quatre pistes de Play", () => {
    for (const t of ["internal", "alpha", "beta", "production"]) {
      expect(isPlayTrack(t), t).toBe(true);
    }
    // `pending` est notre vocabulaire interne (bundle servi, piste inconnue) :
    // le laisser passer promouvrait vers une piste qui n'existe pas chez Google.
    expect(isPlayTrack("pending")).toBe(false);
    expect(isPlayTrack("testflight")).toBe(false);
    expect(isPlayTrack("")).toBe(false);
  });
});

describe("isValidUserFraction — bornes STRICTES des deux côtés", () => {
  it("accepte une fraction d'échelonnement réelle", () => {
    expect(isValidUserFraction(0.01)).toBe(true);
    expect(isValidUserFraction(0.5)).toBe(true);
    expect(isValidUserFraction(0.99)).toBe(true);
  });

  it("refuse 0 : suspendre n'est pas échelonner à zéro", () => {
    // Play rejette `userFraction: 0`. C'est `halt` qui suspend, et le confondre
    // produirait une erreur d'API incompréhensible.
    expect(isValidUserFraction(0)).toBe(false);
  });

  it("refuse 1 : une diffusion complète s'exprime par le STATUT", () => {
    // `userFraction: 1` avec `inProgress` n'est pas la même chose que
    // `completed` — et Play n'accepte pas le premier.
    expect(isValidUserFraction(1)).toBe(false);
  });

  it("refuse tout ce qui n'est pas un nombre fini", () => {
    for (const v of [undefined, null, "0.5", NaN, Infinity, -0.2, 1.5, {}]) {
      expect(isValidUserFraction(v), String(v)).toBe(false);
    }
  });
});
