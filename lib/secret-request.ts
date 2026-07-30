// Phase 9 — Helpers serveur pour les SecretRequest (cf. docs/secret-externe.md).
//
// Token format : `sv_extreq_<32 hex>` (= 8 chars prefix + 64 hex = 72 chars).
// Hashé SHA-256 en base. Le brut n'est jamais persisté.
// Indexé dans `admin.token_index` (kind=SECRET_REQUEST) pour permettre la
// résolution cross-tenant depuis l'URL publique `vault.physalis.cloud/request/<token>`.

import { createHash, randomBytes } from "node:crypto";
import { adminPrisma } from "./prisma";

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

/**
 * Résout un token brut vers le tenant qui le possède via admin.token_index.
 * Retourne le slug ou null si le token est inconnu.
 */
export async function resolveSecretRequestTenantSlug(
  token: string,
): Promise<string | null> {
  if (!isSecretRequestTokenFormat(token)) return null;
  const tokenHash = hashSecretRequestToken(token);
  const row = await adminPrisma.tokenIndex.findUnique({
    where: { tokenHash },
    select: { tenantSlug: true, kind: true },
  });
  if (!row || row.kind !== "SECRET_REQUEST") return null;
  return row.tenantSlug;
}

/** Insère l'entrée dans admin.token_index. À appeler juste après création
 *  de la SecretRequest. */
export async function indexSecretRequestToken(
  tokenHash: string,
  tenantSlug: string,
): Promise<void> {
  await adminPrisma.tokenIndex.create({
    data: { tokenHash, tenantSlug, kind: "SECRET_REQUEST" },
  });
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
