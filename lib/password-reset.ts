// Phase 7 — Password reset.
//
// Token format : `sv_reset_<32 hex>` (40 chars total). Stocké en base sous
// forme SHA-256 (jamais le brut). TTL 1h. Single-use.
//
// Le token vit dans `admin.password_reset_tokens` avec `tenant_slug` +
// `user_id` pour retrouver le user dans le bon `client_<slug>` au moment
// du reset.

import { createHash, randomBytes } from "node:crypto";
import { adminPrisma } from "./prisma";

const TOKEN_PREFIX = "sv_reset_";
const TOKEN_TTL_MS = 60 * 60 * 1000; // 1h

export function generateResetToken(): string {
  return TOKEN_PREFIX + randomBytes(32).toString("hex");
}

export function hashResetToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function isResetTokenFormat(value: string): boolean {
  return /^sv_reset_[0-9a-f]{64}$/.test(value);
}

export type ResetTokenPayload = {
  tenantSlug: string | null;
  userId: string;
  email: string;
};

/**
 * Crée un token de reset pour le user (tenant_slug + user_id) et le stocke
 * en base. Retourne le token brut à inclure dans l'email — JAMAIS persisté.
 */
export async function createResetToken(
  payload: ResetTokenPayload,
): Promise<string> {
  const token = generateResetToken();
  const tokenHash = hashResetToken(token);
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);

  await adminPrisma.passwordResetToken.create({
    data: {
      tokenHash,
      tenantSlug: payload.tenantSlug,
      userId: payload.userId,
      email: payload.email,
      expiresAt,
    },
  });

  return token;
}

/**
 * Lookup d'un token brut. Retourne le record si valide (existe, pas expiré,
 * pas déjà utilisé), null sinon.
 */
export async function resolveResetToken(token: string) {
  if (!isResetTokenFormat(token)) return null;
  const tokenHash = hashResetToken(token);

  const record = await adminPrisma.passwordResetToken.findUnique({
    where: { tokenHash },
  });
  if (!record) return null;
  if (record.usedAt) return null;
  if (record.expiresAt <= new Date()) return null;
  return record;
}

/**
 * Marque un token comme utilisé (single-use) ET invalide les jetons frères
 * non consommés du même user. À appeler après reset réussi.
 *
 * §2.20b — sans la purge des frères, un jeton capturé (accès transitoire à la
 * boîte mail, jeton A jamais utilisé) reste valide dans sa fenêtre TTL même
 * après que la victime a fait son propre reset (jeton B) : `markResetTokenUsed`
 * ne ciblait que `tokenHash`. On supprime donc tous les jetons encore ouverts
 * du même (tenant, user) une fois qu'un reset a abouti.
 */
export async function markResetTokenUsed(tokenHash: string): Promise<void> {
  const used = await adminPrisma.passwordResetToken.update({
    where: { tokenHash },
    data: { usedAt: new Date() },
  });
  await adminPrisma.passwordResetToken.deleteMany({
    where: {
      tenantSlug: used.tenantSlug,
      userId: used.userId,
      usedAt: null,
    },
  });
}
