// Chantier "Déploiement mobile" — Phase 1 (socle credentials).
// Cf. documentation/plans/deploiement-mobile.md §4.4.
//
// ⚠️ Module IMPORTÉ PAR UN COMPOSANT CLIENT (`mobile-panel.tsx` y prend la
// liste des kinds) : il doit rester exempt de tout import Node. `sha256Hex`
// vivait ici et tirait `node:crypto` dans le bundle navigateur — `tsc` et
// `eslint` restaient verts, mais `next build` échouait sur la trace
// `node:crypto → lib/mobile-credentials.ts → mobile-panel.tsx`. L'empreinte
// est donc dans lib/mobile-fingerprint.ts, server-only.

/** Plafond dur par credential (plan §4.4) — les tailles réelles (250 o à
 *  15 Ko) tiennent très largement dedans ; le plafond n'existe que pour
 *  refuser un mauvais upload, pas pour accommoder un usage légitime. */
export const MOBILE_CREDENTIAL_MAX_BYTES = 256 * 1024;

export const ANDROID_CREDENTIAL_KINDS = [
  "android_keystore",
  "android_keystore_password",
  "android_key_alias",
  "android_key_password",
  "play_service_account",
] as const;

export const IOS_CREDENTIAL_KINDS = [
  "ios_p12",
  "ios_p12_password",
  "ios_profile",
  "asc_api_key",
  "asc_key_id",
  "asc_issuer_id",
] as const;

export const MOBILE_CREDENTIAL_KINDS = [
  ...ANDROID_CREDENTIAL_KINDS,
  ...IOS_CREDENTIAL_KINDS,
] as const;

/** Kinds dont la valeur est un FICHIER binaire (keystore, .p12, profil, JSON,
 *  clé .p8) — par opposition à un texte (mot de passe, alias, identifiant). La
 *  distinction pilote deux choses : l'input à l'import (upload vs champ), et le
 *  décodage du bundle servi au CI — un fichier ressort en base64 (le CI l'écrit
 *  tel quel), un texte ressort décodé. Server-safe (aucune dépendance). */
export const MOBILE_FILE_KINDS = new Set<string>([
  "android_keystore",
  "play_service_account",
  "ios_p12",
  "ios_profile",
  "asc_api_key",
]);

export type MobileCredentialKind = (typeof MOBILE_CREDENTIAL_KINDS)[number];

export function isValidMobileCredentialKind(
  kind: string,
): kind is MobileCredentialKind {
  return (MOBILE_CREDENTIAL_KINDS as readonly string[]).includes(kind);
}

/** Kinds qui PORTENT une date d'expiration. Ailleurs, `expiresAt = null` est
 *  normal (mot de passe, identifiant texte, clé .p8) ; ici, c'est un échec
 *  d'extraction — la distinction doit être faite côté serveur ET côté UI,
 *  d'où cette liste partagée. */
export const MOBILE_EXPIRY_KINDS = new Set<string>([
  "ios_p12",
  "android_keystore",
  "ios_profile",
]);

/** applicationId Android / bundleId iOS : forme reverse-DNS conventionnelle,
 *  identique sur les deux plateformes (ex. com.exemple.app). */
export const BUNDLE_ID_RE = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/;

export function isValidMobilePlatform(
  platform: string,
): platform is "android" | "ios" {
  return platform === "android" || platform === "ios";
}

/** Base64 strict : `Buffer.from(s, "base64")` IGNORE les caractères invalides
 *  au lieu de lever — sans ce test, une saisie qui n'est pas du base64 était
 *  stockée telle quelle, avec une empreinte SHA-256 calculée sur des octets
 *  tronqués. Accepte le padding, refuse tout le reste (y compris les blancs :
 *  les producteurs de valeurs sont `fileToBase64`/`textToBase64`, jamais un
 *  base64 replié à 64 colonnes). */
export function isStrictBase64(value: string): boolean {
  return value.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}
