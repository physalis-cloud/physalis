// Phase 9 — Helpers serveur pour les SecretRequest (cf. docs/secret-externe.md).
//
// Token format : `sv_extreq_<32 hex>` (= 8 chars prefix + 64 hex = 72 chars).
// Hashé SHA-256 en base. Le brut n'est jamais persisté.
//
// Jumeau SELF-HOST : `resolveSecretRequestTenantSlug` et
// `indexSecretRequestToken` sont RETIRÉS. Ils servent, côté SaaS, à résoudre
// depuis le portail partagé `vault.physalis.cloud/request/<token>` quel tenant
// possède un token — problème qui n'existe pas ici : il n'y a qu'une base et
// qu'un schéma, le `tokenHash` est unique, on lit la ligne directement.
//
// Ce n'était pas seulement inutile, c'était CASSANT : `indexSecretRequestToken`
// n'avait aucun appelant dans le build, donc `TokenIndex` restait vide et la
// résolution renvoyait toujours null → toute demande de secret externe créée
// depuis une instance auto-hébergée produisait un lien en 404 permanent.

import { createHash, randomBytes } from "node:crypto";

const TOKEN_PREFIX = "sv_extreq_";
export const SECRET_REQUEST_TTL_MS = 48 * 60 * 60 * 1000; // 48h (défaut)

/** #5 — options d'expiration proposées à la création d'une demande externe
 *  (« Autoriser un partage externe »). Bornées côté serveur : pas de TTL
 *  arbitraire depuis le client. Heures : 1h · 24h · 48h · 7j. */
export const SECRET_REQUEST_TTL_OPTIONS_HOURS = [1, 24, 48, 168] as const;

/** Résout un nombre d'heures demandé (body POST) en millisecondes, validé
 *  contre l'allowlist. `undefined`/`null` → défaut 48h ; valeur hors
 *  allowlist → `null` (le caller renvoie 400). */
export function resolveSecretRequestTtlMs(hours: unknown): number | null {
  if (hours === undefined || hours === null) return SECRET_REQUEST_TTL_MS;
  if (
    typeof hours === "number" &&
    (SECRET_REQUEST_TTL_OPTIONS_HOURS as readonly number[]).includes(hours)
  ) {
    return hours * 60 * 60 * 1000;
  }
  return null;
}

export function generateSecretRequestToken(): string {
  return TOKEN_PREFIX + randomBytes(32).toString("hex");
}

export function hashSecretRequestToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function isSecretRequestTokenFormat(value: string): boolean {
  return /^sv_extreq_[0-9a-f]{64}$/.test(value);
}

/** Statut UI dérivé d'un SecretRequest. */
export type SecretRequestStatus =
  | "pending"
  | "received"
  | "imported"
  | "revoked"
  | "expired";

export function deriveStatus(req: {
  submittedAt: Date | null;
  importedAt: Date | null;
  revokedAt: Date | null;
  expiresAt: Date;
}): SecretRequestStatus {
  if (req.revokedAt) return "revoked";
  if (req.importedAt) return "imported";
  if (req.submittedAt) return "received";
  if (req.expiresAt <= new Date()) return "expired";
  return "pending";
}
