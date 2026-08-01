// Règles des types d'entrée du coffre personnel (cf. lib/vault-entry-types.ts).
//
// Le cœur du fichier testé ici est conversionBlocker : c'est lui qui garantit
// qu'on ne perd jamais une URL, un login ou un secret 2FA en reclassant une
// entrée. Il tourne CÔTÉ CLIENT (grisage du sélecteur) ET côté serveur
// (refus du PATCH) — les deux doivent lire la même vérité.

import { describe, it, expect } from "vitest";
import {
  conversionBlocker,
  decodePayload,
  encodePayload,
  isVaultEntryType,
  itemCountFor,
  normalizeEntryType,
  typeHasPasswordStrength,
  validateListItems,
  validateNoteText,
  VAULT_TYPE_LIMITS,
  type ConvertibleEntry,
  type VaultEntryType,
} from "@/lib/vault-entry-types";

/** Entrée « nue » : un nom et rien d'autre que sa valeur. */
function bare(type: VaultEntryType, over: Partial<ConvertibleEntry> = {}): ConvertibleEntry {
  return {
    type,
    url: null,
    username: null,
    hasTotpSecret: false,
    itemCount: type === "LIST" ? 1 : null,
    ...over,
  };
}

describe("normalizeEntryType / isVaultEntryType", () => {
  it("accepte les 4 types", () => {
    for (const t of ["LOGIN", "SECRET", "LIST", "NOTE"]) {
      expect(isVaultEntryType(t)).toBe(true);
      expect(normalizeEntryType(t)).toBe(t);
    }
  });

  it("retombe sur LOGIN pour toute valeur inconnue", () => {
    // Données antérieures à la migration, ou écrites hors app.
    expect(normalizeEntryType(null)).toBe("LOGIN");
    expect(normalizeEntryType("")).toBe("LOGIN");
    expect(normalizeEntryType("CARD")).toBe("LOGIN");
    expect(normalizeEntryType(42)).toBe("LOGIN");
    expect(isVaultEntryType("login")).toBe(false); // sensible à la casse
  });
});

describe("conversionBlocker", () => {
  it("laisse passer la conversion vers le même type", () => {
    expect(conversionBlocker(bare("LOGIN", { url: "https://x.fr" }), "LOGIN")).toBeNull();
  });

  it("autorise un LOGIN nu vers les 3 autres formes (le cas visé)", () => {
    // Reclasser une entrée historique n'ayant qu'un nom et un mot de passe.
    for (const target of ["SECRET", "LIST", "NOTE"] as const) {
      expect(conversionBlocker(bare("LOGIN"), target)).toBeNull();
    }
  });

  it("refuse de convertir un LOGIN qui porte une URL", () => {
    const entry = bare("LOGIN", { url: "https://gmail.com" });
    expect(conversionBlocker(entry, "SECRET")).toBe("url");
    expect(conversionBlocker(entry, "LIST")).toBe("url");
    expect(conversionBlocker(entry, "NOTE")).toBe("url");
  });

  it("refuse de convertir un LOGIN qui porte un login", () => {
    expect(conversionBlocker(bare("LOGIN", { username: "gael" }), "NOTE")).toBe(
      "username",
    );
  });

  it("refuse de convertir un LOGIN qui porte un secret 2FA", () => {
    expect(conversionBlocker(bare("LOGIN", { hasTotpSecret: true }), "SECRET")).toBe(
      "totp",
    );
  });

  it("signale l'URL en priorité quand plusieurs champs bloquent", () => {
    const entry = bare("LOGIN", {
      url: "https://x.fr",
      username: "gael",
      hasTotpSecret: true,
    });
    expect(conversionBlocker(entry, "NOTE")).toBe("url");
  });

  it("autorise SECRET vers n'importe quelle forme", () => {
    for (const target of ["LOGIN", "LIST", "NOTE"] as const) {
      expect(conversionBlocker(bare("SECRET"), target)).toBeNull();
    }
  });

  it("refuse d'écraser une LIST à plusieurs items, NOTE comprise", () => {
    // Aucune cible n'échappe à la règle : la conversion ne transporte qu'UNE
    // valeur. Aplatir 3 items en un texte perdrait la structure sans retour
    // possible — on préfère refuser et laisser l'user vider sa liste.
    const list = bare("LIST", { itemCount: 3 });
    expect(conversionBlocker(list, "SECRET")).toBe("items");
    expect(conversionBlocker(list, "LOGIN")).toBe("items");
    expect(conversionBlocker(list, "NOTE")).toBe("items");
  });

  it("autorise une LIST à 0 ou 1 item vers une valeur unique", () => {
    expect(conversionBlocker(bare("LIST", { itemCount: 1 }), "SECRET")).toBeNull();
    expect(conversionBlocker(bare("LIST", { itemCount: 0 }), "LOGIN")).toBeNull();
    expect(conversionBlocker(bare("LIST", { itemCount: null }), "SECRET")).toBeNull();
  });

  it("autorise NOTE vers n'importe quelle forme", () => {
    // La seule limite (texte plus long qu'un mot de passe) ne se voit qu'après
    // déchiffrement : elle est vérifiée côté route, pas ici.
    for (const target of ["LOGIN", "SECRET", "LIST"] as const) {
      expect(conversionBlocker(bare("NOTE"), target)).toBeNull();
    }
  });
});

describe("typeHasPasswordStrength", () => {
  it("ne score que le vrai mot de passe", () => {
    // Scorer une clé d'API polluerait le filtre « mots de passe faibles ».
    expect(typeHasPasswordStrength("LOGIN")).toBe(true);
    expect(typeHasPasswordStrength("SECRET")).toBe(false);
    expect(typeHasPasswordStrength("LIST")).toBe(false);
    expect(typeHasPasswordStrength("NOTE")).toBe(false);
  });
});

describe("validateListItems", () => {
  it("normalise les libellés et garde les valeurs telles quelles", () => {
    const out = validateListItems([{ label: "  PIN  ", value: " 1234 " }]);
    expect(out).toEqual([{ label: "PIN", value: " 1234 " }]);
  });

  it("ignore les lignes entièrement vides", () => {
    // L'UI garde volontiers une ligne vierge en bas de formulaire.
    expect(validateListItems([{ label: "", value: "" }])).toEqual([]);
    expect(validateListItems([{ label: "  ", value: "" }, { label: "a", value: "b" }])).toEqual(
      [{ label: "a", value: "b" }],
    );
  });

  it("garde une ligne dont seule la valeur est remplie", () => {
    expect(validateListItems([{ label: "", value: "v" }])).toEqual([
      { label: "", value: "v" },
    ]);
  });

  it("rejette ce qui n'est pas une liste d'objets", () => {
    expect(validateListItems("nope")).toBeNull();
    expect(validateListItems([null])).toBeNull();
    expect(validateListItems([{ label: 1, value: "x" }])).toBeNull();
    expect(validateListItems([{ label: "x", value: 1 }])).toBeNull();
  });

  it("rejette au-delà des limites", () => {
    const tooMany = Array.from({ length: VAULT_TYPE_LIMITS.itemsMax + 1 }, () => ({
      label: "a",
      value: "b",
    }));
    expect(validateListItems(tooMany)).toBeNull();
    expect(
      validateListItems([{ label: "a".repeat(VAULT_TYPE_LIMITS.itemLabelMax + 1), value: "b" }]),
    ).toBeNull();
    expect(
      validateListItems([{ label: "a", value: "b".repeat(VAULT_TYPE_LIMITS.itemValueMax + 1) }]),
    ).toBeNull();
  });
});

describe("validateNoteText", () => {
  it("accepte un texte dans la limite", () => {
    expect(validateNoteText("")).toBe("");
    expect(validateNoteText("multi\nligne")).toBe("multi\nligne");
  });

  it("rejette un non-texte ou un texte trop long", () => {
    expect(validateNoteText(42)).toBeNull();
    expect(validateNoteText("x".repeat(VAULT_TYPE_LIMITS.noteTextMax + 1))).toBeNull();
  });
});

describe("encodePayload / decodePayload", () => {
  it("ne produit rien pour les types sans charge utile", () => {
    expect(encodePayload("LOGIN", { text: "ignoré" })).toBeNull();
    expect(encodePayload("SECRET", { items: [{ label: "a", value: "b" }] })).toBeNull();
  });

  it("ne chiffre pas une charge vide (colonne NULL plutôt qu'objet creux)", () => {
    expect(encodePayload("LIST", { items: [] })).toBeNull();
    expect(encodePayload("NOTE", { text: "" })).toBeNull();
  });

  it("fait un aller-retour fidèle", () => {
    const items = [{ label: "PIN", value: "1234" }, { label: "", value: "x" }];
    expect(decodePayload(encodePayload("LIST", { items }))).toEqual({ items });
    expect(decodePayload(encodePayload("NOTE", { text: "hello" }))).toEqual({
      text: "hello",
    });
  });

  it("tolère un blob corrompu plutôt que de faire échouer la lecture", () => {
    expect(decodePayload(null)).toEqual({});
    expect(decodePayload("pas du json")).toEqual({});
    expect(decodePayload('"une chaîne"')).toEqual({});
    expect(decodePayload('{"items":[{"label":"a"}]}')).toEqual({ items: [] });
    expect(decodePayload('{"items":"nope"}')).toEqual({});
  });
});

describe("itemCountFor", () => {
  it("ne compte que pour les LIST", () => {
    expect(itemCountFor("LIST", { items: [{ label: "a", value: "b" }] })).toBe(1);
    expect(itemCountFor("LIST", {})).toBe(0);
    expect(itemCountFor("NOTE", { text: "x" })).toBeNull();
    expect(itemCountFor("LOGIN", {})).toBeNull();
  });
});
