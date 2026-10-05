// Jumeau self-host de `lib/cli-tenant.ts` (C-0050).
//
// Mono-tenant : pas de sous-domaine client, pas de table admin.client, pas
// d'admin.token_index. Le tenant vaut `null` et `withTenantSchema` l'ignore.
// ⚠️ Aucun appelant ne doit traiter `tenantSlug === null` comme un refus
// (mémoire monotenant-tenantslug-dead-guard) : c'est l'état NORMAL ici.
// Signatures alignées sur le source SaaS.

export type CliTenant =
  | { ok: true; tenantSlug: string | null }
  | { ok: false; status: number; error: string };

export async function resolveCliTenant(
  _req: Request,
  _bodySlug?: unknown,
): Promise<CliTenant> {
  return { ok: true, tenantSlug: null };
}

/** Pas d'index en mono-tenant : le jeton se cherche directement dans CliSession. */
export async function tenantOfCliToken(
  _tokenHash: string,
): Promise<{ tenantSlug: string | null } | null> {
  return { tenantSlug: null };
}

export async function indexCliToken(
  _tokenHash: string,
  _tenantSlug: string | null,
): Promise<void> {
  // no-op
}

export function cliTenantOfWebSession(_tenantSlug: string | null): CliTenant {
  return { ok: true, tenantSlug: null };
}
