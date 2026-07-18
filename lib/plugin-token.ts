// Tokens de session pour l'extension navigateur (cf. spec
// docs/navigateurs-extension.md). Cycle de vie :
//
//   1. POST /api/plugin/auth { email, password, totp }
//      → genere `sv_plugin_<hex>`, stocke SHA-256 en base avec expiresAt
//        et userAgent, retourne le brut UNE SEULE FOIS au client.
//   2. GET /api/plugin/match Authorization: Bearer sv_plugin_<hex>
//      → validate via hash, met a jour lastUsedAt en arriere-plan.
//   3. Expiration silencieuse : passe expiresAt → 401, l'extension
//      redemande TOTP.
//   4. Revocation manuelle via /settings/security : revokedAt = now.
//
// Le prefixe `sv_plugin_` permet de distinguer ces tokens des
// MachineToken `sv_<hex>` dans les logs et les scans de secrets.

import { createHash, randomBytes } from "crypto";
// Validation tenant-aware via admin.token_index. Pas de fallback legacy
// sur public.PluginToken : tout token actif doit avoir une entrée dans
// admin.token_index (cf. scripts/migrate-tokens-to-admin.mjs).
import { resolveTokenIndex } from "./token-index";
import { withTenantSchema } from "./tenant";
import { isSessionInvalidated } from "./session-validity";

const TOKEN_PREFIX = "sv_plugin_";
const DEFAULT_TTL_SECONDS = 14400; // 4h

/**
 * TTLs autorises pour un PluginToken (proposes au user via le popup
 * de l'extension). Liste fermee : on n'accepte aucune autre valeur,
 * pour eviter qu'un client bricolé demande 30 jours.
 */
export const ALLOWED_TTLS = [3600, 14400, 28800] as const;
export type AllowedTtl = (typeof ALLOWED_TTLS)[number];

export function isAllowedTtl(value: unknown): value is AllowedTtl {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    (ALLOWED_TTLS as readonly number[]).includes(value)
  );
}

export function getPluginSessionTtl(): number {
  const raw = process.env.PLUGIN_SESSION_TTL;
  if (!raw) return DEFAULT_TTL_SECONDS;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TTL_SECONDS;
}

export function generatePluginToken(): string {
  return TOKEN_PREFIX + randomBytes(32).toString("hex");
}

export function hashPluginToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function isPluginTokenFormat(value: string): boolean {
  return /^sv_plugin_[0-9a-f]{64}$/.test(value);
}

/**
 * Resout un Bearer token plugin. Retourne le PluginToken + User si valide,
 * null sinon. Met `lastUsedAt` a jour de maniere asynchrone (non-bloquant).
 *
 * Verifications :
 *   - Prefixe + format hex strict (rejet rapide avant lookup DB)
 *   - Hash existe en base
 *   - Pas revoque (revokedAt = null)
 *   - Pas expire (expiresAt > now)
 *   - Pas anterieur a la borne d'invalidation de l'user (sessionsValidFrom) :
 *     un reset de mot de passe / 2FA disable coupe TOUTES les sessions emises
 *     avant. Un PluginToken est une session au meme titre qu'un JWT web — son
 *     `createdAt` est l'equivalent du `loginAt` du JWT (instant ou le flux
 *     /api/plugin/auth a prouve email+password+TOTP). Sans ce controle, un
 *     token vole survivait au reset cense l'evincer, ET pouvait etre echange
 *     contre une session web fraiche via le provider Credentials `pluginToken`
 *     (auth.ts) — qui appelle CETTE fonction en premier.
 */
export async function validatePluginToken(token: string) {
  if (!isPluginTokenFormat(token)) return null;
  const tokenHash = hashPluginToken(token);

  const indexEntry = await resolveTokenIndex(tokenHash);
  if (!indexEntry || indexEntry.kind !== "PLUGIN") return null;

  const pluginToken = await withTenantSchema(indexEntry.tenantSlug, (tx) =>
    tx.pluginToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    }),
  );
  if (!pluginToken) return null;
  if (pluginToken.revokedAt) return null;
  if (pluginToken.expiresAt <= new Date()) return null;
  // Meme borne que les JWT web (cf. isSessionInvalidated) : le token est mort
  // s'il precede la borne. `createdAt` = instant d'emission du token.
  if (
    isSessionInvalidated(
      pluginToken.createdAt.getTime(),
      pluginToken.user.sessionsValidFrom,
    )
  ) {
    return null;
  }

  withTenantSchema(indexEntry.tenantSlug, (tx) =>
    tx.pluginToken.update({
      where: { id: pluginToken.id },
      data: { lastUsedAt: new Date() },
    }),
  ).catch((err) =>
    console.error("[plugin-token] failed to update lastUsedAt:", err),
  );

  return { ...pluginToken, tenantSlug: indexEntry.tenantSlug };
}

/**
 * Extrait le token Bearer de l'header Authorization. Retourne null si
 * absent ou format invalide.
 */
export function extractPluginBearer(req: Request): string | null {
  const h =
    req.headers.get("authorization") ?? req.headers.get("Authorization");
  if (!h || typeof h !== "string") return null;
  const m = h.match(/^Bearer\s+(.+)$/);
  return m && m[1] ? m[1].trim() : null;
}
