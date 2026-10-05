// Stub self-host : pas de plans ni de gel de sièges (SaaS).
// Le source renvoie déjà `false` quand `tenantSlug` est null, ce qui est
// TOUJOURS le cas en mono-tenant.
// ⚠️ N'exporte volontairement PAS `requireFeature` : un fichier synchronisé
// qui gate par plan doit casser `tsc` et recevoir un jumeau (cf. les routes
// rotation), pas passer en silence.
// Signatures alignées sur le source SaaS.

export async function seatFrozenForUser(_input: {
  tenantSlug: string | null;
  userId: string;
  isPlatformAdmin: boolean;
}): Promise<boolean> {
  return false;
}
