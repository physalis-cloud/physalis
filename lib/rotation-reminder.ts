// Rotation REMINDER généralisée (Phase B) — helpers partagés par les modèles
// SANS versioning (Service, AppAccount, TeamVaultEntry). Pour ces cibles, la
// rotation est forcément manuelle/assistée (REMINDER) : Physalis n'applique
// jamais le credential à la source. On enregistre la nouvelle valeur + un
// historique capé à 3 (revert), et on recalcule l'échéance.
//
// Les secrets d'environnement (modèle Secret) n'utilisent PAS ce helper : ils
// ont le versioning complet (cf. mark-rotated/route.ts).

export type RotationHistoryEntry = {
  encryptedValue: string;
  iv: string;
  tag: string;
  /** ISO 8601 — quand cette valeur a été remplacée. */
  rotatedAt: string;
};

/** Nombre d'anciennes valeurs conservées pour revert (pas de versioning ici). */
export const ROTATION_HISTORY_CAP = 3;

/** Échéance du prochain rappel : `from + intervalDays`, ou null si pas d'intervalle. */
export function computeReminderNextAt(
  intervalDays: number | null | undefined,
  from: Date,
): Date | null {
  return intervalDays ? new Date(from.getTime() + intervalDays * 86_400_000) : null;
}

/**
 * Préfixe l'ancienne valeur chiffrée à l'historique et cape à 3.
 * `existing` = la colonne JSON Prisma (forme inconnue → on la valide).
 */
export function pushRotationHistory(
  existing: unknown,
  entry: RotationHistoryEntry,
): RotationHistoryEntry[] {
  const prev = Array.isArray(existing)
    ? (existing as RotationHistoryEntry[]).filter(
        (e) => e && typeof e.encryptedValue === "string",
      )
    : [];
  return [entry, ...prev].slice(0, ROTATION_HISTORY_CAP);
}
