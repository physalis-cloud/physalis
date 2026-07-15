// Garde-fou : la crypto inlinée dans scripts/rekey-encryption.mjs doit être
// 100 % interopérable avec lib/crypto.ts. Si lib/crypto change de format
// (algo, IV, encodage), ce test casse → on est prévenu avant que le script de
// re-keying ne corrompe des données.

import { describe, it, expect, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import { encrypt, decrypt } from "@/lib/crypto";
// Le .mjs n'exécute main() que lancé directement → import sûr ici.
import {
  encryptWith,
  decryptWith,
  rekeyPayload,
  parseKey,
} from "../../scripts/rekey-encryption.mjs";

const ORIGINAL_KEY = process.env.ENCRYPTION_KEY;
const hexKey = () => randomBytes(32).toString("hex");

afterEach(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = ORIGINAL_KEY;
});

describe("rekey-script ↔ lib/crypto — interopérabilité", () => {
  it("lib/crypto chiffre → le script déchiffre (même format)", () => {
    const k = hexKey();
    process.env.ENCRYPTION_KEY = k;
    const plain = "DATABASE_URL=postgres://x-$$-日本語";
    const payload = encrypt(plain);
    expect(decryptWith(payload, parseKey(k, "k"))).toBe(plain);
  });

  it("le script chiffre → lib/crypto déchiffre (même format)", () => {
    const k = hexKey();
    process.env.ENCRYPTION_KEY = k;
    const plain = "sk-prod-API_KEY=secret";
    const payload = encryptWith(plain, parseKey(k, "k"));
    expect(decrypt(payload)).toBe(plain);
  });

  it("rekeyPayload migre de K1 vers K2 et préserve le clair", () => {
    const k1 = parseKey(hexKey(), "k1");
    const k2 = parseKey(hexKey(), "k2");
    const plain = "valeur-à-roter";
    const underK1 = encryptWith(plain, k1);

    const migrated = rekeyPayload(underK1, k2, k1);
    expect(migrated).not.toBeNull();
    expect(decryptWith(migrated!, k2)).toBe(plain);
  });

  it("rekeyPayload est idempotent : déjà sous K2 → null", () => {
    const k1 = parseKey(hexKey(), "k1");
    const k2 = parseKey(hexKey(), "k2");
    const underK2 = encryptWith("déjà-migré", k2);
    expect(rekeyPayload(underK2, k2, k1)).toBeNull();
  });

  it("rekeyPayload lève si illisible sous K1 et K2", () => {
    const k1 = parseKey(hexKey(), "k1");
    const k2 = parseKey(hexKey(), "k2");
    const kOther = parseKey(hexKey(), "kOther");
    const underOther = encryptWith("orphelin", kOther);
    expect(() => rekeyPayload(underOther, k2, k1)).toThrow();
  });
});
