import { describe, it, expect } from "vitest";
import {
  SECRET_CATEGORIES,
  SECRET_CATEGORY_LABELS,
  isValidCategory,
  resolveCategoryFromComment,
} from "@/lib/categories";

describe("lib/categories", () => {
  it("la liste est non vide et chaque entree a un label", () => {
    expect(SECRET_CATEGORIES.length).toBeGreaterThan(0);
    for (const cat of SECRET_CATEGORIES) {
      expect(SECRET_CATEGORY_LABELS[cat]).toBeTruthy();
    }
  });

  it("isValidCategory accepte chaque valeur de la liste", () => {
    for (const cat of SECRET_CATEGORIES) {
      expect(isValidCategory(cat)).toBe(true);
    }
  });

  it("isValidCategory refuse les valeurs hors liste", () => {
    expect(isValidCategory("misc")).toBe(false);
    expect(isValidCategory("Database")).toBe(false); // casse
    expect(isValidCategory("DATABASE")).toBe(false);
    expect(isValidCategory("")).toBe(false);
    expect(isValidCategory(null)).toBe(false);
    expect(isValidCategory(undefined)).toBe(false);
    expect(isValidCategory(42)).toBe(false);
    expect(isValidCategory({})).toBe(false);
  });

  it("l'ordre est figé : ports, database, auth, services, email, infra, application", () => {
    expect([...SECRET_CATEGORIES]).toEqual([
      "ports",
      "database",
      "auth",
      "services",
      "email",
      "infra",
      "application",
    ]);
  });
});

describe("resolveCategoryFromComment", () => {
  it("reconnait les en-tetes ecrits par l'export .env", () => {
    // L'export ecrit le slug brut : c'est le cas d'usage n°1 (aller-retour
    // export → reimport dans un autre environnement).
    expect(resolveCategoryFromComment("application")).toBe("application");
    expect(resolveCategoryFromComment("infra")).toBe("infra");
    expect(resolveCategoryFromComment("ports")).toBe("ports");
    expect(resolveCategoryFromComment("services")).toBe("services");
  });

  it("reconnait « Sans categorie » et renvoie une categorie vide", () => {
    expect(resolveCategoryFromComment("Sans catégorie")).toBe("none");
    expect(resolveCategoryFromComment("Uncategorized")).toBe("none");
  });

  it("ignore la casse, les accents et la ponctuation d'encadrement", () => {
    expect(resolveCategoryFromComment("  DATABASE ")).toBe("database");
    expect(resolveCategoryFromComment("--- Infra ---")).toBe("infra");
    expect(resolveCategoryFromComment("Base de données :")).toBe("database");
  });

  it("accepte quelques synonymes courants", () => {
    expect(resolveCategoryFromComment("DB")).toBe("database");
    expect(resolveCategoryFromComment("SMTP")).toBe("email");
    expect(resolveCategoryFromComment("Infrastructure")).toBe("infra");
  });

  it("ne range RIEN sur un commentaire libre", () => {
    // Regle centrale : un .env du monde reel est plein de commentaires
    // qui ne sont pas des titres de section. Ils ne doivent pas ranger.
    expect(resolveCategoryFromComment("TODO: rotate this key")).toBeNull();
    expect(resolveCategoryFromComment("généré le 2026-08-10")).toBeNull();
    expect(resolveCategoryFromComment("")).toBeNull();
    expect(resolveCategoryFromComment(undefined)).toBeNull();
  });
});
