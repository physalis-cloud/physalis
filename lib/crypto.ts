import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

const ALGORITHM = "aes-256-gcm";

function parseKey(raw: string | undefined, label: string): Buffer {
  if (!raw) throw new Error(`${label} is not set`);
  const key = Buffer.from(raw, "hex");
  if (key.length !== 32) {
    throw new Error(`${label} must be 32 bytes (64 hex chars)`);
  }
  return key;
}

/** Clé primaire : chiffre TOUT et déchiffre par défaut. */
function getKey(): Buffer {
  return parseKey(process.env.ENCRYPTION_KEY, "ENCRYPTION_KEY");
}

/** Clé sortante optionnelle, présente seulement pendant une rotation.
 *  Si `ENCRYPTION_KEY_OLD` est définie, `decrypt()` y retombe quand la primaire
 *  échoue → les lignes encore chiffrées sous l'ancienne clé restent lisibles
 *  pendant un re-keying progressif (zéro downtime). Absente = comportement
 *  historique strictement inchangé. */
function getOldKey(): Buffer | null {
  const raw = process.env.ENCRYPTION_KEY_OLD;
  if (!raw) return null;
  return parseKey(raw, "ENCRYPTION_KEY_OLD");
}

export type EncryptedPayload = {
  encryptedValue: string;
  iv: string;
  tag: string;
};

export function encrypt(plaintext: string): EncryptedPayload {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, getKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return {
    encryptedValue: encrypted.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
  };
}

function decryptWith(payload: EncryptedPayload, key: Buffer): string {
  const decipher = createDecipheriv(
    ALGORITHM,
    key,
    Buffer.from(payload.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(payload.encryptedValue, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

export function decrypt(payload: EncryptedPayload): string {
  try {
    return decryptWith(payload, getKey());
  } catch (err) {
    // Pendant une rotation : retomber sur l'ancienne clé si elle est fournie.
    const old = getOldKey();
    if (!old) throw err;
    return decryptWith(payload, old);
  }
}

/** Re-chiffre un payload sous la clé courante, pour le script de re-keying.
 *  Idempotent et rejouable : si le payload est déjà déchiffrable sous la clé
 *  courante, il est considéré comme déjà migré et `null` est renvoyé (skip).
 *  Sinon il est déchiffré sous `ENCRYPTION_KEY_OLD` puis re-chiffré sous la
 *  courante. L'auth GCM (tag 128 bits) garantit qu'un « succès » sous la clé
 *  courante n'est jamais un faux positif. Lève si la rotation est nécessaire
 *  mais qu'aucune ancienne clé n'est configurée. */
export function rekeyToCurrent(
  payload: EncryptedPayload,
): EncryptedPayload | null {
  try {
    decryptWith(payload, getKey());
    return null; // déjà sous la clé courante → rien à faire
  } catch {
    const old = getOldKey();
    if (!old) {
      throw new Error(
        "rekeyToCurrent: payload illisible sous ENCRYPTION_KEY et ENCRYPTION_KEY_OLD absente",
      );
    }
    return encrypt(decryptWith(payload, old));
  }
}
