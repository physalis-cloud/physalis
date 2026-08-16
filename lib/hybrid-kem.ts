// lib/hybrid-kem.ts
//
// Échange de clés HYBRIDE classique + post-quantique pour SecretRequest
// (Phase 1, cf. documentation/plans/done/securite-post-quantique.md).
//
//   Classique : ECDH P-256        → résiste si ML-KEM s'avère immature
//   PQC        : ML-KEM-768       → résiste à un ordinateur quantique (Shor)
//
// Les deux secrets partagés sont combinés par un KDF (PAS un XOR : le XOR
// n'est pas un combineur sûr). HKDF-SHA256 sur la concaténation des deux
// secrets ET du transcript (ciphertext ML-KEM + clé publique éphémère
// ECDH) — combineur robuste type IETF, qui lie la clé dérivée à toute la
// transcription pour éviter les attaques de re-binding.
//
// Sortie : clé AES-256-GCM de 32 bytes, drop-in pour le même schéma de
// chiffrement que lib/secret-request-crypto.ts (ECDH seul, legacy).
//
// Browser-safe : utilise `crypto.subtle` (WebCrypto) + `@noble/post-quantum`
// (pur JS). Fonctionne à l'identique côté navigateur du tiers, navigateur
// admin, et tests Node.

import { generateEcdhKeypair } from "./secret-request-crypto";
import { mlKemDecapsulate, mlKemEncapsulate } from "./pqc";

/** Version du format hybride persistée en base (`SecretRequest.hybridVersion`). */
export const HYBRID_VERSION = 1;

/** Contexte HKDF — fige la sémantique de la clé dérivée. */
const HKDF_INFO = "physalis-secretrequest-hybrid-v1";

const ENC = new TextEncoder();
const DEC = new TextDecoder();

// ─── Base64 (standard, full-byte — cohérent avec secret-request-crypto) ──

function bytesToB64(bytes: Uint8Array): string {
  let str = "";
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]!);
  return btoa(str);
}

function b64ToBytes(b64: string): Uint8Array {
  const str = atob(b64);
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i);
  return bytes;
}

// ─── ECDH P-256 (raw shared bits, pas deriveKey — on combine nous-mêmes) ──

async function importEcdhPublic(json: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "jwk",
    JSON.parse(json) as JsonWebKey,
    { name: "ECDH", namedCurve: "P-256" },
    true,
    [],
  );
}

async function importEcdhPrivate(json: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "jwk",
    JSON.parse(json) as JsonWebKey,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
}

/** Secret partagé brut ECDH P-256 (32 bytes, coordonnée X). */
async function ecdhSharedBits(
  privateJwk: string,
  publicJwk: string,
): Promise<Uint8Array> {
  const priv = await importEcdhPrivate(privateJwk);
  const pub = await importEcdhPublic(publicJwk);
  const bits = await crypto.subtle.deriveBits(
    { name: "ECDH", public: pub },
    priv,
    256,
  );
  return new Uint8Array(bits);
}

/** Octets canoniques (raw, point non compressé 65 bytes) d'une clé pub ECDH. */
async function ecdhPublicRaw(publicJwk: string): Promise<Uint8Array> {
  const pub = await importEcdhPublic(publicJwk);
  return new Uint8Array(await crypto.subtle.exportKey("raw", pub));
}

// ─── Combineur HKDF ─────────────────────────────────────────────────────

function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/**
 * Dérive la clé AES-256-GCM finale depuis les deux secrets partagés et le
 * transcript. IKM = ssEcdh ‖ ssMlkem ‖ mlkemCiphertext ‖ ephemeralEcdhPub.
 */
async function deriveHybridAesKey(
  ssEcdh: Uint8Array,
  ssMlkem: Uint8Array,
  mlkemCiphertext: Uint8Array,
  ephemeralEcdhPubRaw: Uint8Array,
): Promise<CryptoKey> {
  const ikm = concatBytes(ssEcdh, ssMlkem, mlkemCiphertext, ephemeralEcdhPubRaw);
  const hkdfKey = await crypto.subtle.importKey(
    "raw",
    ikm as unknown as BufferSource,
    "HKDF",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: ENC.encode(HKDF_INFO),
    },
    hkdfKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

// ─── API publique ───────────────────────────────────────────────────────

export type HybridEncryptedPayload = {
  /** Ciphertext AES-GCM, base64. */
  ciphertext: string;
  /** IV AES-GCM (12 bytes), base64. */
  iv: string;
  /** Clé publique éphémère ECDH du chiffreur, JWK sérialisée JSON. */
  ephemeralPublicJwk: string;
  /** Ciphertext ML-KEM-768, base64. */
  mlkemCiphertext: string;
  /** Version du format hybride. */
  hybridVersion: number;
};

/**
 * Chiffre un secret pour un destinataire hybride (clé pub ECDH + clé pub
 * ML-KEM). Génère une paire ECDH éphémère + encapsule ML-KEM, combine les
 * deux secrets via HKDF, chiffre en AES-256-GCM.
 *
 * Appelé côté navigateur du tiers externe sur `/request/[token]`.
 */
export async function hybridEncryptForRecipient(
  plaintext: string,
  recipientPublicJwk: string,
  recipientMlkemPublicKeyB64: string,
): Promise<HybridEncryptedPayload> {
  const ephemeral = await generateEcdhKeypair();

  const ssEcdh = await ecdhSharedBits(ephemeral.privateJwk, recipientPublicJwk);
  const { ciphertext: mlkemCt, sharedSecret: ssMlkem } = mlKemEncapsulate(
    b64ToBytes(recipientMlkemPublicKeyB64),
  );
  const ephPubRaw = await ecdhPublicRaw(ephemeral.publicJwk);

  const aesKey = await deriveHybridAesKey(ssEcdh, ssMlkem, mlkemCt, ephPubRaw);

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    aesKey,
    ENC.encode(plaintext),
  );

  return {
    ciphertext: bytesToB64(new Uint8Array(ciphertext)),
    iv: bytesToB64(iv),
    ephemeralPublicJwk: ephemeral.publicJwk,
    mlkemCiphertext: bytesToB64(mlkemCt),
    hybridVersion: HYBRID_VERSION,
  };
}

/**
 * Déchiffre un secret hybride : reconstruit ssEcdh via ECDH(privAdmin,
 * pubEphémère), ssMlkem via décapsulation, recombine et déchiffre.
 *
 * Appelé côté navigateur de l'admin au moment du "Révéler".
 */
export async function hybridDecryptFromSender(
  payload: {
    ciphertext: string;
    iv: string;
    ephemeralPublicJwk: string;
    mlkemCiphertext: string;
  },
  recipientPrivateJwk: string,
  recipientMlkemSecretKeyB64: string,
): Promise<string> {
  const mlkemCt = b64ToBytes(payload.mlkemCiphertext);

  const ssEcdh = await ecdhSharedBits(
    recipientPrivateJwk,
    payload.ephemeralPublicJwk,
  );
  const ssMlkem = mlKemDecapsulate(mlkemCt, b64ToBytes(recipientMlkemSecretKeyB64));
  const ephPubRaw = await ecdhPublicRaw(payload.ephemeralPublicJwk);

  const aesKey = await deriveHybridAesKey(ssEcdh, ssMlkem, mlkemCt, ephPubRaw);

  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64ToBytes(payload.iv) as unknown as BufferSource },
    aesKey,
    b64ToBytes(payload.ciphertext) as unknown as BufferSource,
  );
  return DEC.decode(plain);
}

// ─── Clé privée composite (transport admin ↔ coffre) ────────────────────

/**
 * Format de la clé privée composite remise à l'admin à la création d'une
 * demande hybride. Sérialisée JSON, stockée par l'admin (coffre Physalis
 * ou hors-ligne). `ecdh` = JWK JSON (string), `mlkem` = secret key base64.
 */
export type CompositePrivateKey = {
  v: number;
  ecdh: string;
  mlkem: string;
};

export function serializeCompositePrivateKey(ecdhPrivateJwk: string, mlkemSecretKeyB64: string): string {
  const composite: CompositePrivateKey = {
    v: HYBRID_VERSION,
    ecdh: ecdhPrivateJwk,
    mlkem: mlkemSecretKeyB64,
  };
  return JSON.stringify(composite);
}

/**
 * Parse une clé privée saisie par l'admin. Détecte automatiquement le
 * format : composite hybride (`{ v, ecdh, mlkem }`) ou JWK ECDH legacy
 * (`{ kty: "EC", ... }`).
 */
export function parsePrivateKey(
  raw: string,
): { kind: "hybrid"; ecdh: string; mlkem: string } | { kind: "legacy"; ecdh: string } {
  const trimmed = raw.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error("Clé privée invalide (JSON attendu).");
  }
  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.ecdh === "string" && typeof obj.mlkem === "string") {
      return { kind: "hybrid", ecdh: obj.ecdh, mlkem: obj.mlkem };
    }
    if (obj.kty === "EC") {
      return { kind: "legacy", ecdh: trimmed };
    }
  }
  throw new Error("Format de clé privée non reconnu.");
}

export { bytesToB64, b64ToBytes };
