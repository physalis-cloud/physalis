// Format du payload chiffre d'un OneTimeShare.
//
// Le serveur ne voit qu'un ciphertext opaque (cf. lib/share-crypto.ts) : il
// ignore totalement ce qu'il y a dedans. On en profite pour transporter, dans
// un seul partage, PLUSIEURS items (secrets texte + petits fichiers texte)
// regroupes dans une enveloppe versionnee, chiffree d'un bloc cote navigateur.
//
//   { v: 1, items: [
//       { type: "text", title?, content },
//       { type: "file", filename, content },
//   ] }
//
// Tout (titres par item, noms de fichiers) vit DANS le chiffre → invisible du
// serveur. Seul le `title` du partage (colonne DB, liste "Mes partages") reste
// en clair, comme avant.
//
// Retro-compat : les anciens partages chiffraient une string brute, pas une
// enveloppe JSON. `decodeEnvelope` detecte ce cas et le presente comme un item
// texte unique → aucune regression a la lecture.

export const ENVELOPE_VERSION = 1 as const;

// Budgets cote client. La somme des contenus (plaintext de l'enveloppe) doit
// rester sous ENVELOPE_PLAINTEXT_MAX pour que le ciphertext base64 tienne sous
// le cap serveur (CIPHERTEXT_MAX dans app/api/share/route.ts).
export const TEXT_ITEM_MAX = 10_000;
export const FILE_ITEM_MAX = 32_768;
export const ENVELOPE_PLAINTEXT_MAX = 180_000;
export const MAX_ITEMS = 20;

export type ShareTextItem = { type: "text"; title?: string; content: string };
export type ShareFileItem = { type: "file"; filename: string; content: string };
export type ShareItem = ShareTextItem | ShareFileItem;

export type ShareEnvelope = { v: typeof ENVELOPE_VERSION; items: ShareItem[] };

/**
 * Serialise les items en JSON d'enveloppe, pret a etre chiffre via
 * encryptShareContent(). C'est cette string qui devient le plaintext.
 */
export function encodeEnvelope(items: ShareItem[]): string {
  const envelope: ShareEnvelope = { v: ENVELOPE_VERSION, items };
  return JSON.stringify(envelope);
}

/**
 * Decode le plaintext dechiffre en liste d'items.
 *
 * - Enveloppe v1 valide → renvoie ses items.
 * - Tout le reste (ancienne string brute, JSON non conforme) → fallback en un
 *   seul item texte contenant le plaintext tel quel (retro-compat).
 */
export function decodeEnvelope(plaintext: string): ShareItem[] {
  try {
    const parsed = JSON.parse(plaintext) as unknown;
    if (isEnvelope(parsed)) {
      return parsed.items.filter(isShareItem);
    }
  } catch {
    // plaintext non-JSON → ancien format string brute, on tombe dans le fallback
  }
  return [{ type: "text", content: plaintext }];
}

/**
 * Taille (en octets UTF-8) du plaintext qui sera chiffre. Sert a la validation
 * de budget cote client avant chiffrement.
 */
export function encodedByteLength(items: ShareItem[]): number {
  return new TextEncoder().encode(encodeEnvelope(items)).length;
}

function isEnvelope(value: unknown): value is ShareEnvelope {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { v?: unknown }).v === ENVELOPE_VERSION &&
    Array.isArray((value as { items?: unknown }).items)
  );
}

function isShareItem(value: unknown): value is ShareItem {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.type === "text") return typeof v.content === "string";
  if (v.type === "file")
    return typeof v.content === "string" && typeof v.filename === "string";
  return false;
}
