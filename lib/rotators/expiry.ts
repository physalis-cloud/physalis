// §2.23 — dérivation de l'expiration d'une clé de remplacement lors d'une
// rotation (Gateway API keys).
//
// Fichier volontairement SANS dépendance (fonction pure) : testable sans DB ni
// contexte tenant, et sûr à importer partout.

/**
 * Calcule l'`expiresAt` de la clé neuve à partir de l'ancienne.
 *
 * On NE recopie PAS `oldExpiresAt` tel quel : sa date pourrait être déjà dépassée
 * au moment de la rotation → la clé neuve naîtrait expirée → coupure de service.
 * On re-dérive `now + TTL`, où TTL = durée de vie INITIALE de l'ancienne clé
 * (`oldExpiresAt - oldCreatedAt`). Comme `expiresAt` est toujours postérieur à
 * `createdAt` à la création (cf. keys/route.ts : `now + expiresIn`, expiresIn>0),
 * le TTL est positif et la clé neuve expire toujours dans le futur.
 *
 * Une clé sans expiration (`oldExpiresAt = null`) reste sans expiration.
 */
export function deriveRotatedExpiry(
  oldExpiresAt: Date | null,
  oldCreatedAt: Date,
  now: Date,
): Date | null {
  if (!oldExpiresAt) return null;
  const ttlMs = oldExpiresAt.getTime() - oldCreatedAt.getTime();
  return new Date(now.getTime() + ttlMs);
}
