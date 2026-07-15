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
