// Stub self-host : pas d'AsyncLocalStorage du slug tenant (SaaS).
// En mono-tenant le slug vaut toujours `null` : le source exécute alors `fn`
// sans contexte, ce que fait ce stub dans tous les cas.
// N'exporte que ce que les fichiers synchronisés importent (lib/cli-secrets.ts,
// lib/cli-ssh.ts) : un nouvel import doit casser `tsc` et forcer la décision.
// Signatures alignées sur le source SaaS.

export function maybeRunWithTenant<T>(
  _slug: string | null,
  fn: () => Promise<T> | T,
): Promise<T> {
  return Promise.resolve(fn());
}
