// Types d'entrée du coffre personnel (V2.2).
//
// Une VaultEntry n'est plus forcément un couple login/mot de passe sur une
// URL. Quatre formes, portées par la colonne `VaultEntry.type` :
//
//   LOGIN  — url (optionnelle) + login + mot de passe + 2FA. Forme
//            historique, seule à alimenter l'autofill de l'extension.
//   SECRET — un nom + une valeur unique (clé d'API, licence, code).
//            Réutilise DÉLIBÉRÉMENT la colonne `encryptedPassword` : le
//            copier/révéler/charger-l'actuel existants marchent tels quels.
//   LIST   — n paires libellé/valeur (questions secrètes, jeu de codes).
//   NOTE   — un texte libre chiffré.
//
// LIST et NOTE stockent leur charge utile dans UN blob chiffré
// (`encryptedData`), pas dans des colonnes ni une table satellite : le
// coffre perso est petit (< 500 entrées), la révélation est déjà
// tout-ou-rien par entrée, et un blob unique garde l'écriture atomique.
//
// Les LIBELLÉS d'une LIST sont DANS le blob, donc chiffrés — « réponse à la
// question secrète » en dit plus long qu'une URL. Conséquence assumée : la
// recherche serveur ne les couvre pas (elle porte sur name/url/username), et
// la liste affiche « N secrets » via `itemCount`, stocké en clair.
//
// `type` est une colonne TEXTE, pas un enum PG : un enum tenant-only absent
// du schéma `public` casse le deploy admin (cf. mémoire OrgRole), et ajouter
// une 5ᵉ forme demanderait un ALTER TYPE … ADD VALUE avec le même piège.

export const VAULT_ENTRY_TYPES = ["LOGIN", "SECRET", "LIST", "NOTE"] as const;

export type VaultEntryType = (typeof VAULT_ENTRY_TYPES)[number];

export const VAULT_TYPE_LIMITS = {
  /** Nombre d'items d'une LIST. */
  itemsMax: 50,
  /** Libellé d'un item de LIST. */
  itemLabelMax: 200,
  /** Valeur d'un item de LIST — aligné sur PASSWORD_MAX. */
  itemValueMax: 4096,
  /** Texte d'une NOTE. */
  noteTextMax: 20000,
} as const;

export type VaultListItem = { label: string; value: string };

export function isVaultEntryType(v: unknown): v is VaultEntryType {
  return (
    typeof v === "string" &&
    (VAULT_ENTRY_TYPES as readonly string[]).includes(v)
  );
}

/** Type stocké → type valide. Toute valeur inconnue (donnée antérieure à la
 *  migration, ou écrite hors app) retombe sur LOGIN, la forme historique. */
export function normalizeEntryType(v: unknown): VaultEntryType {
  return isVaultEntryType(v) ? v : "LOGIN";
}

// ─── Ce que chaque type sait porter ──────────────────────────────────────
//
// Sert deux choses : effacer les champs étrangers quand une entrée change de
// type (pas de résidu chiffré fantôme), et décider si une conversion est
// permise (cf. conversionBlocker).

type Carries = {
  url: boolean;
  username: boolean;
  totp: boolean;
  /** Valeur unique, stockée dans encryptedPassword. */
  password: boolean;
  items: boolean;
  text: boolean;
};

export const CARRIES: Record<VaultEntryType, Carries> = {
  LOGIN: { url: true, username: true, totp: true, password: true, items: false, text: false },
  SECRET: { url: false, username: false, totp: false, password: true, items: false, text: false },
  LIST: { url: false, username: false, totp: false, password: false, items: true, text: false },
  NOTE: { url: false, username: false, totp: false, password: false, items: false, text: true },
};

/** Le score de force ne vaut que pour un vrai mot de passe. Le calculer sur
 *  une clé d'API ou une note polluerait le filtre « mots de passe faibles »
 *  et le tri par force. */
export function typeHasPasswordStrength(type: VaultEntryType): boolean {
  return type === "LOGIN";
}

// ─── Conversion entre types ──────────────────────────────────────────────

export type ConversionBlocker = "url" | "username" | "totp" | "items" | "value";

/** État d'une entrée suffisant pour statuer sur une conversion — que des
 *  métadonnées EN CLAIR, donc calculable côté client depuis la liste comme
 *  côté serveur sans déchiffrer. */
export type ConvertibleEntry = {
  type: VaultEntryType;
  url: string | null;
  username: string | null;
  hasTotpSecret: boolean;
  itemCount: number | null;
};

/**
 * Renvoie ce qui empêche de convertir `entry` vers `target`, ou null si la
 * conversion ne détruit rien.
 *
 * Règle unique : une conversion est permise quand la cible sait porter tout
 * ce que la source contient déjà. C'est ce qui autorise le cas visé —
 * reclasser une entrée LOGIN historique n'ayant qu'un nom et un mot de passe
 * vers SECRET / LIST / NOTE — sans jamais perdre silencieusement une URL, un
 * login ou un secret 2FA.
 *
 * La valeur unique (mot de passe, item unique, texte) survit à toutes les
 * conversions : chacun des quatre types sait en porter une. Seule exception
 * gérée à part par l'appelant : une NOTE trop longue pour tenir dans un mot
 * de passe (cf. VAULT_LIMITS.passwordMax), qui ne se voit qu'après
 * déchiffrement.
 *
 * Corollaire : une LIST à 2+ items ne se convertit vers RIEN, NOTE comprise.
 * Aplatir ses items en un texte perdrait la structure sans retour possible ;
 * on préfère refuser et laisser l'utilisateur vider sa liste lui-même.
 */
export function conversionBlocker(
  entry: ConvertibleEntry,
  target: VaultEntryType,
): ConversionBlocker | null {
  if (entry.type === target) return null;
  const to = CARRIES[target];
  if (entry.url && !to.url) return "url";
  if (entry.username && !to.username) return "username";
  if (entry.hasTotpSecret && !to.totp) return "totp";
  // Une LIST à 2+ items ne tient pas dans une valeur unique.
  if (
    entry.type === "LIST" &&
    !to.items &&
    (entry.itemCount ?? 0) > 1
  ) {
    return "items";
  }
  return null;
}

// ─── Charge utile chiffrée (LIST / NOTE) ─────────────────────────────────

/** Forme du JSON chiffré dans `encryptedData`. Discriminé par le `type` de
 *  la ligne, pas par un champ interne : le type fait foi côté colonne. */
export type VaultPayload = { items?: VaultListItem[]; text?: string };

/** Valide une liste d'items brute. Renvoie null si invalide (l'appelant
 *  répond 400). Les items entièrement vides sont ignorés — l'UI garde
 *  volontiers une ligne vierge en bas de formulaire. */
export function validateListItems(input: unknown): VaultListItem[] | null {
  if (!Array.isArray(input)) return null;
  if (input.length > VAULT_TYPE_LIMITS.itemsMax) return null;
  const out: VaultListItem[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") return null;
    const { label, value } = raw as { label?: unknown; value?: unknown };
    if (label !== undefined && typeof label !== "string") return null;
    if (value !== undefined && typeof value !== "string") return null;
    const l = (label ?? "").toString().trim();
    const v = (value ?? "").toString();
    if (!l && !v) continue;
    if (l.length > VAULT_TYPE_LIMITS.itemLabelMax) return null;
    if (v.length > VAULT_TYPE_LIMITS.itemValueMax) return null;
    out.push({ label: l, value: v });
  }
  return out;
}

/** Valide le texte d'une NOTE. Renvoie null si invalide. */
export function validateNoteText(input: unknown): string | null {
  if (typeof input !== "string") return null;
  if (input.length > VAULT_TYPE_LIMITS.noteTextMax) return null;
  return input;
}

/** Sérialise la charge utile à chiffrer. Renvoie null quand le type n'en a
 *  pas (LOGIN/SECRET) ou quand elle est vide — dans ce cas l'appelant met
 *  `encryptedData` à NULL plutôt que de chiffrer un objet creux. */
export function encodePayload(
  type: VaultEntryType,
  payload: VaultPayload,
): string | null {
  if (type === "LIST") {
    const items = payload.items ?? [];
    if (items.length === 0) return null;
    return JSON.stringify({ items });
  }
  if (type === "NOTE") {
    const text = payload.text ?? "";
    if (text.length === 0) return null;
    return JSON.stringify({ text });
  }
  return null;
}

/** Désérialise un blob déchiffré. Tolérant : un blob corrompu ou d'une forme
 *  inattendue renvoie une charge vide plutôt que de faire échouer la lecture
 *  de toute l'entrée. */
export function decodePayload(plaintext: string | null): VaultPayload {
  if (!plaintext) return {};
  try {
    const parsed = JSON.parse(plaintext) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const { items, text } = parsed as VaultPayload;
    const safeItems = Array.isArray(items)
      ? items
          .filter(
            (i): i is VaultListItem =>
              Boolean(i) &&
              typeof i === "object" &&
              typeof (i as VaultListItem).value === "string",
          )
          .map((i) => ({ label: String(i.label ?? ""), value: i.value }))
      : undefined;
    return {
      ...(safeItems ? { items: safeItems } : {}),
      ...(typeof text === "string" ? { text } : {}),
    };
  } catch {
    return {};
  }
}

/** Nombre d'items stocké en clair sur la ligne (affichage « N secrets »
 *  sans déchiffrer). NULL hors LIST. */
export function itemCountFor(
  type: VaultEntryType,
  payload: VaultPayload,
): number | null {
  return type === "LIST" ? (payload.items ?? []).length : null;
}
