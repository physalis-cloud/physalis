// lib/pqc.ts
//
// Abstraction des opérations post-quantiques (Phase 1 du plan PQC, cf.
// documentation/plans/done/securite-post-quantique.md).
//
// Algorithme : ML-KEM-768 (NIST FIPS 203) — KEM standardisé, niveau de
// sécurité 3. On passe par `@noble/post-quantum` : pur JS, fonctionne à
// l'identique côté navigateur (WebCrypto n'expose pas encore ML-KEM) et
// côté Node, sans dépendance C native (important pour l'image Alpine).
//
// Ne JAMAIS importer `@noble/post-quantum` ailleurs : tout passe par ici,
// sur le modèle de lib/crypto.ts pour AES. Voir lib/hybrid-kem.ts pour la
// combinaison hybride ECDH P-256 + ML-KEM.

import { ml_kem768 } from "@noble/post-quantum/ml-kem.js";

/** Tailles attendues (bytes) pour ML-KEM-768 — sanity checks. */
export const ML_KEM_768 = {
  publicKeyBytes: 1184,
  secretKeyBytes: 2400,
  ciphertextBytes: 1088,
  sharedSecretBytes: 32,
} as const;

/** Génère une paire de clés ML-KEM-768. */
export function mlKemGenerateKeyPair(): {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
} {
  const { publicKey, secretKey } = ml_kem768.keygen();
  return { publicKey, secretKey };
}

/**
 * Encapsule un secret partagé contre une clé publique ML-KEM.
 * Retourne le ciphertext (à transmettre) et le secret partagé (32 bytes,
 * à combiner — ne jamais transmettre tel quel).
 */
export function mlKemEncapsulate(publicKey: Uint8Array): {
  ciphertext: Uint8Array;
  sharedSecret: Uint8Array;
} {
  if (publicKey.length !== ML_KEM_768.publicKeyBytes) {
    throw new Error(
      `ML-KEM-768 public key invalide (${publicKey.length} bytes, attendu ${ML_KEM_768.publicKeyBytes})`,
    );
  }
  const { cipherText, sharedSecret } = ml_kem768.encapsulate(publicKey);
  return { ciphertext: cipherText, sharedSecret };
}

/**
 * Décapsule le secret partagé depuis un ciphertext + la clé secrète.
 * ML-KEM est IND-CCA2 : un ciphertext altéré ne lève pas d'erreur mais
 * produit un secret partagé différent (rejet implicite) → l'AEAD en aval
 * (AES-GCM) échouera à l'authentification. C'est le comportement attendu.
 */
export function mlKemDecapsulate(
  ciphertext: Uint8Array,
  secretKey: Uint8Array,
): Uint8Array {
  if (ciphertext.length !== ML_KEM_768.ciphertextBytes) {
    throw new Error(
      `ML-KEM-768 ciphertext invalide (${ciphertext.length} bytes, attendu ${ML_KEM_768.ciphertextBytes})`,
    );
  }
  if (secretKey.length !== ML_KEM_768.secretKeyBytes) {
    throw new Error(
      `ML-KEM-768 secret key invalide (${secretKey.length} bytes, attendu ${ML_KEM_768.secretKeyBytes})`,
    );
  }
  return ml_kem768.decapsulate(ciphertext, secretKey);
}
