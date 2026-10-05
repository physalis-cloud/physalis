// Les quatre formes d'entrée dans le coffre d'ÉQUIPE (C-0047 / T-0253).
//
// ⚠️ Ce qui se teste ici, ce sont les deux endroits où une erreur DÉTRUIT des
// données au lieu de lever : un type deviné à l'écriture, et une conversion qui
// laisse tomber un champ que la forme cible ne porte pas. Les deux rendent 200.

import { describe, expect, it } from "vitest";
import { validateEntryCreate, validateEntryPatch } from "@/lib/vault-entries";
import { conversionBlocker } from "@/lib/vault-entry-types";

const ok = <T extends { ok: boolean }>(v: T) => {
  expect(v.ok, JSON.stringify(v)).toBe(true);
  return v as Extract<T, { ok: true }>;
};

describe("création : le type et sa charge utile", () => {
  it("sans `type`, une entrée reste LOGIN — la forme historique", () => {
    // ⚠️ C'est ce qui rend le chantier rétro-compatible : l'extension, le CLI,
    // le SDK et l'import créent des entrées sans jamais parler de type.
    const v = ok(validateEntryCreate({ name: "Compte", password: "x" }));
    expect(v.type).toBe("LOGIN");
    expect(v.payload).toBeNull();
    expect(v.itemCount).toBeNull();
  });

  it("une LIST sérialise ses items et compte combien il y en a EN CLAIR", () => {
    const v = ok(validateEntryCreate({
      name: "Boîte support",
      type: "LIST",
      items: [
        { label: "host", value: "imap.exemple.fr" },
        { label: "port", value: "993" },
        { label: "user", value: "support@exemple.fr" },
      ],
    }));
    expect(v.type).toBe("LIST");
    expect(v.itemCount).toBe(3);
    // Les LIBELLÉS partent dans le blob chiffré — « réponse à la question
    // secrète » en dit plus long qu'une URL.
    expect(JSON.parse(v.payload!).items).toHaveLength(3);
  });

  it("un `type` inconnu se REFUSE, il ne retombe pas sur LOGIN", () => {
    // ⚠️ `normalizeEntryType` existe pour LIRE une valeur déjà en base. À
    // l'écriture, il transformerait une faute de frappe en entrée
    // silencieusement mal typée.
    expect(validateEntryCreate({ name: "x", type: "LOGINN" }).ok).toBe(false);
  });

  it("une NOTE porte son texte, et pas de mot de passe", () => {
    const v = ok(validateEntryCreate({ name: "Procédure", type: "NOTE", text: "abc" }));
    expect(JSON.parse(v.payload!).text).toBe("abc");
    expect(v.itemCount).toBeNull();
  });
});

describe("la forme décide de ce qui est STOCKÉ, et le serveur tranche", () => {
  it("une LIST créée AVEC une url n'en garde pas — sinon l'extension la propose", () => {
    // ⚠️ Défaut trouvé en relisant `/api/plugin/match` : il sélectionne les
    // entrées par `url: { not: null }`. Une LIST portant une URL serait donc
    // proposée en REMPLISSAGE AUTOMATIQUE sur un vrai site, avec un mot de
    // passe vide. L'écran n'affiche pas le champ pour une LIST, mais l'API
    // accepte n'importe quel appelant — l'écran n'est pas un garde-fou.
    const v = ok(validateEntryCreate({
      name: "Boîte",
      type: "LIST",
      url: "https://exemple.fr",
      username: "moi",
      password: "secret",
      items: [{ label: "host", value: "imap.exemple.fr" }],
    }));
    expect(v.url).toBeNull();
    expect(v.username).toBeNull();
    expect(v.password).toBeNull();
  });

  it("une NOTE ne garde ni mot de passe ni secret 2FA", () => {
    const v = ok(validateEntryCreate({
      name: "Procédure", type: "NOTE", text: "abc", password: "x",
    }));
    expect(v.password).toBeNull();
    expect(v.totpSecret).toBeNull();
  });

  it("une LOGIN garde tout : la coupe ne s'applique qu'à ce qui n'est pas porté", () => {
    const v = ok(validateEntryCreate({
      name: "Compte", url: "https://exemple.fr", username: "moi", password: "x",
    }));
    expect(v.url).toBe("https://exemple.fr");
    expect(v.username).toBe("moi");
    expect(v.password).toBe("x");
  });

  it("un SECRET garde sa valeur mais perd url et identifiant", () => {
    const v = ok(validateEntryCreate({
      name: "Clé", type: "SECRET", url: "https://x.fr", username: "moi", password: "sk_live",
    }));
    expect(v.password).toBe("sk_live");
    expect(v.url).toBeNull();
    expect(v.username).toBeNull();
  });
});

describe("modification : ne jamais deviner la forme", () => {
  it("un PATCH sans `type` ne touche pas au type", () => {
    const v = ok(validateEntryPatch({ name: "Renommée" }));
    expect(v.forme).toBeUndefined();
  });

  it("`items` SANS `type` est refusé — sinon la liste serait effacée", () => {
    // ⚠️ Le défaut que ce test existe pour empêcher : un type absent retombe
    // sur LOGIN à la création. Appliqué à un PATCH, envoyer les items d'une
    // LIST sans rappeler son type la convertirait en LOGIN, effacerait la
    // liste, et rendrait 200.
    const v = validateEntryPatch({ items: [{ label: "a", value: "b" }] });
    expect(v.ok).toBe(false);
  });

  it("`type: LIST` SANS `items` est refusé — sinon la liste se vide en silence", () => {
    // ⚠️ La réciproque du test précédent, et le défaut vu en vrai le
    // 2026-08-31 : l'écran passait une entrée en LIST sans envoyer les items
    // (secrets non chargés), le serveur sérialisait une liste vide, écrivait
    // `encryptedData = NULL` et rendait 200. L'utilisateur saisissait ses
    // secrets et rien n'était gardé.
    expect(validateEntryPatch({ type: "LIST" }).ok).toBe(false);
    expect(validateEntryPatch({ type: "NOTE" }).ok).toBe(false);
  });

  it("`type` + `items` ensemble passent", () => {
    const v = ok(validateEntryPatch({ type: "LIST", items: [{ label: "a", value: "b" }] }));
    expect(v.forme?.type).toBe("LIST");
    expect(v.forme?.itemCount).toBe(1);
    expect(v.changed).toContain("type");
  });
});

describe("conversion : ce qui bloque, et qui doit bloquer", () => {
  const entree = {
    type: "LOGIN" as const,
    url: "https://exemple.fr",
    username: "moi",
    hasTotpSecret: false,
    itemCount: null,
  };

  it("refuse de convertir vers une forme qui ne porte pas l'URL", () => {
    // SECRET ne porte ni url ni username : convertir sans le dire perdrait les
    // deux, chiffrés, sans retour possible.
    expect(conversionBlocker(entree, "SECRET")).toBe("url");
  });

  it("une LOGIN dépouillée se convertit librement", () => {
    const nue = { ...entree, url: null, username: null };
    for (const cible of ["SECRET", "LIST", "NOTE"] as const) {
      expect(conversionBlocker(nue, cible), cible).toBeNull();
    }
  });

  it("une LIST à plusieurs items ne se convertit vers RIEN, NOTE comprise", () => {
    // Aplatir des items en texte perdrait la structure sans retour possible.
    const liste = { type: "LIST" as const, url: null, username: null, hasTotpSecret: false, itemCount: 3 };
    expect(conversionBlocker(liste, "NOTE")).toBe("items");
    expect(conversionBlocker(liste, "SECRET")).toBe("items");
  });

  it("un secret 2FA bloque autant qu'une URL", () => {
    const avec2fa = { ...entree, url: null, username: null, hasTotpSecret: true };
    expect(conversionBlocker(avec2fa, "SECRET")).toBe("totp");
  });
});
