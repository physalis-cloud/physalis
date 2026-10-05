/**
 * URL publique canonique de l'instance Physalis — source de vérité de « l'URL de
 * l'app » pour : les URLs absolues passées aux AGENTS (backup, rotation) qui
 * doivent rappeler Physalis, et le fallback des liens email (invitation, reset)
 * quand le host de la requête n'est pas disponible.
 *
 * ⚠️ Découplée de NEXTAUTH_URL À DESSEIN. Depuis le SSO multi-tenant, on veut
 * pouvoir RETIRER NEXTAUTH_URL/AUTH_URL : next-auth dérive alors le host de
 * CHAQUE requête (via `trustHost`), ce qui permet le SSO natif par sous-domaine
 * (le `redirect_uri` suit le host du tenant). Mais « l'URL de l'app » pour les
 * agents/emails doit rester une valeur fixe → c'est le rôle de PHYSALIS_URL.
 *
 * Chaîne de transition (rétro-compatible) : PHYSALIS_URL → NEXTAUTH_URL →
 * AUTH_URL → fallback. Tant que PHYSALIS_URL n'est pas posée, le comportement
 * est STRICTEMENT INCHANGÉ (fallback sur NEXTAUTH_URL comme avant).
 *
 * @param fallback Valeur si aucune variable n'est posée (défaut localhost ; les
 *   agents passent "" pour conserver leur ancien défaut vide).
 */
export function physalisBaseUrl(fallback = "http://localhost:3000"): string {
  const raw =
    process.env.PHYSALIS_URL ??
    process.env.NEXTAUTH_URL ??
    process.env.AUTH_URL ??
    fallback;
  return raw.replace(/\/$/, "");
}

const TENANT_DOMAIN = process.env.PHYSALIS_TENANT_DOMAIN ?? "physalis.cloud";

/**
 * Origine publique du workspace d'un tenant, reconstruite depuis son slug.
 *
 * ⚠️ À utiliser pour tout lien EMBARQUÉ DANS UN EMAIL. Ces liens partent vers
 * une victime potentielle : les dériver d'un en-tête de requête (`Host`,
 * `X-Forwarded-Host`) laisse l'émetteur du mail choisir le domaine de
 * destination, donc envoyer un lien de phishing signé par notre DKIM avec le
 * branding réel (cf. documentation/rapports/failles.md §2.11). Le slug, lui, vient de la session
 * authentifiée — il n'est pas forgeable par un en-tête.
 *
 * `tenantSlug` null → instance mono-tenant (self-host) : repli sur l'URL
 * canonique, qui est alors la bonne.
 */
export function tenantBaseUrl(tenantSlug: string | null): string {
  return tenantSlug
    ? `https://${tenantSlug}.${TENANT_DOMAIN}`
    : physalisBaseUrl();
}

/**
 * Cet hôte est-il celui du SaaS — par opposition à une instance auto-hébergée ?
 *
 * ⚠️ **Sert à ce que l'app DIT d'elle-même**, pas à une décision d'accès : la
 * description Open Graph annonçait « Self-hosted secrets manager » sur
 * `vault.physalis.cloud`, qui est précisément l'offre hébergée. Ne JAMAIS s'en
 * servir pour autoriser quoi que ce soit — un `Host` est choisi par l'appelant,
 * et `tenantBaseUrl` explique juste au-dessus pourquoi on n'en dérive pas de
 * lien sensible.
 *
 * ⚠️ **Elle est ICI et pas dans `lib/tenant-host.ts`, qui porte pourtant déjà
 * `isTenantDomainHost`.** Ce module-là est RETIRÉ du dépôt public
 * (`scripts/build-public.mjs`) : la notion de tenant n'existe pas en
 * mono-tenant, et ses trois appelants ont tous un jumeau overlay qui ne
 * l'importe pas. L'importer depuis un layout — qui, lui, n'a pas de jumeau —
 * aurait casse la compilation du build self-host, sans que rien ici ne le
 * signale. `app-url.ts` survit aux deux builds et porte déjà `TENANT_DOMAIN`.
 *
 * En auto-hébergé, l'hôte est celui du client et `PHYSALIS_TENANT_DOMAIN` n'est
 * pas posée : la réponse est donc `false`, ce qui est la bonne.
 */
export function estHoteSaaS(host: string | null | undefined): boolean {
  if (!host) return false;
  // Port et casse ignorés : `vault.physalis.cloud:443` est le même hôte.
  const nom = host.split(":")[0]?.toLowerCase() ?? "";
  return nom === TENANT_DOMAIN || nom.endsWith(`.${TENANT_DOMAIN}`);
}
