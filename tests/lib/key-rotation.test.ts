// Test unitaire : rotation de la clé de chiffrement (Chiffrement #5).
//
// Le modèle est une clé maître unique (`ENCRYPTION_KEY`, lue à chaque appel
// par lib/crypto.getKey()) sans versioning de clé dans le payload. Conséquence
// opérationnelle : faire tourner la clé n'est PAS transparent — un secret
// chiffré sous l'ancienne clé devient illisible sous la nouvelle (l'auth GCM
// échoue). La rotation exige donc une procédure de re-keying : déchiffrer
// sous l'ancienne clé, rechiffrer sous la nouvelle.
//
// Ce test verrouille cet invariant (c'est la garantie « anciens secrets
// déchiffrables après rotation » du catalogue) : il prouve (1) qu'un re-key
// préserve le plaintext et (2) qu'un changement de clé SANS re-key casse la
// lecture — donc qu'on ne peut pas oublier l'étape de re-chiffrement.

import { describe, it, expect, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import {
  encrypt,
  decrypt,
  rekeyToCurrent,
  type EncryptedPayload,
} from "@/lib/crypto";

const ORIGINAL_KEY = process.env.ENCRYPTION_KEY;
const ORIGINAL_OLD_KEY = process.env.ENCRYPTION_KEY_OLD;
const newHexKey = () => randomBytes(32).toString("hex");

function setKey(hex: string) {
  process.env.ENCRYPTION_KEY = hex;
}

function setOldKey(hex: string | undefined) {
  if (hex === undefined) delete process.env.ENCRYPTION_KEY_OLD;
  else process.env.ENCRYPTION_KEY_OLD = hex;
}

/** Re-key un payload : déchiffre sous `from`, rechiffre sous `to`.
 *  Clés explicites (pas de dépendance à l'état global courant) → sûr en lot. */
function rekey(
  payload: EncryptedPayload,
  from: string,
  to: string,
): EncryptedPayload {
  setKey(from);
  const plain = decrypt(payload);
  setKey(to);
  return encrypt(plain);
}

afterEach(() => {
  // Restaure les clés du harness pour les autres suites.
  if (ORIGINAL_KEY === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = ORIGINAL_KEY;
  setOldKey(ORIGINAL_OLD_KEY);
});

describe("Chiffrement #5 — rotation de clé", () => {
  it("re-keying : un secret reste déchiffrable et identique après rotation", () => {
    const k1 = newHexKey();
    const k2 = newHexKey();
    const plain = "sk-prod-API_KEY=très-secret-$$-日本語";

    setKey(k1);
    const underK1 = encrypt(plain);
    expect(decrypt(underK1)).toBe(plain); // lisible sous K1

    const underK2 = rekey(underK1, k1, k2); // décrypte sous K1, rechiffre sous K2
    expect(decrypt(underK2)).toBe(plain); // toujours lisible, valeur préservée
  });

  it("changer de clé SANS re-key rend l'ancien payload illisible (auth GCM échoue)", () => {
    const k1 = newHexKey();
    const k2 = newHexKey();

    setKey(k1);
    const underK1 = encrypt("secret-value");

    // Rotation « naïve » : on bascule la clé sans re-chiffrer le stock.
    setKey(k2);
    expect(() => decrypt(underK1)).toThrow(); // tag GCM invalide
  });

  it("re-keying d'un lot : toutes les valeurs survivent à la rotation", () => {
    const k1 = newHexKey();
    const k2 = newHexKey();
    const values = ["", "a", "DATABASE_URL=postgres://x", "X".repeat(4096)];

    setKey(k1);
    const encrypted = values.map((v) => encrypt(v));

    // Re-key le lot entier sous K2.
    const rotated = encrypted.map((p) => rekey(p, k1, k2));

    setKey(k2);
    rotated.forEach((p, i) => expect(decrypt(p)).toBe(values[i]));
  });

  it("un nouveau secret chiffré sous K2 n'est pas lisible si on revient à K1", () => {
    const k1 = newHexKey();
    const k2 = newHexKey();

    setKey(k2);
    const underK2 = encrypt("post-rotation-secret");

    setKey(k1);
    setOldKey(undefined); // pas de fallback configuré
    expect(() => decrypt(underK2)).toThrow();
  });
});

describe("Chiffrement #5 — fallback ENCRYPTION_KEY_OLD (rotation en ligne)", () => {
  it("decrypt() lit un payload sous l'ancienne clé quand ENCRYPTION_KEY_OLD est fournie", () => {
    const oldK = newHexKey();
    const newK = newHexKey();
    const plain = "DATABASE_URL=postgres://still-old";

    setKey(oldK);
    const underOld = encrypt(plain);

    // Bascule vers la nouvelle clé, l'ancienne devient le fallback.
    setKey(newK);
    setOldKey(oldK);
    expect(decrypt(underOld)).toBe(plain); // lisible via fallback
  });

  it("sans ENCRYPTION_KEY_OLD, decrypt() reste strict (pas de fallback masquant)", () => {
    const oldK = newHexKey();
    const newK = newHexKey();

    setKey(oldK);
    const underOld = encrypt("secret");

    setKey(newK);
    setOldKey(undefined);
    expect(() => decrypt(underOld)).toThrow();
  });
});

describe("Chiffrement #5 — rekeyToCurrent (cœur du script de re-keying)", () => {
  it("re-chiffre un payload de l'ancienne clé vers la courante", () => {
    const oldK = newHexKey();
    const newK = newHexKey();
    const plain = "sk-prod-API_KEY=très-secret-$$-日本語";

    setKey(oldK);
    const underOld = encrypt(plain);

    setKey(newK);
    setOldKey(oldK);
    const migrated = rekeyToCurrent(underOld);
    expect(migrated).not.toBeNull();

    // Lisible sous la seule clé courante (plus besoin de l'ancienne).
    setOldKey(undefined);
    expect(decrypt(migrated!)).toBe(plain);
  });

  it("est idempotent : un payload déjà sous la clé courante renvoie null (skip)", () => {
    const oldK = newHexKey();
    const newK = newHexKey();

    setKey(newK);
    setOldKey(oldK);
    const underNew = encrypt("already-migrated");

    // Déjà sous la clé courante → rien à re-chiffrer (rejouable sans dommage).
    expect(rekeyToCurrent(underNew)).toBeNull();
  });

  it("lève si la rotation est nécessaire mais qu'aucune ancienne clé n'est fournie", () => {
    const oldK = newHexKey();
    const newK = newHexKey();

    setKey(oldK);
    const underOld = encrypt("secret");

    setKey(newK);
    setOldKey(undefined);
    expect(() => rekeyToCurrent(underOld)).toThrow();
  });
});
