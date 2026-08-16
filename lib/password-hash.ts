// Source UNIQUE du coût bcrypt des mots de passe de COMPTE, et du hash factice
// anti-timing qui doit lui correspondre (documentation/rapports/rapport-security.md F3.1).
//
// Le problème que ce module ferme : la mitigation anti-timing du login compare
// le mot de passe soumis à un hash factice quand le compte n'existe pas, pour
// que « email inconnu » et « email connu, mauvais mot de passe » coûtent le
// même temps. Elle ne vaut que si les DEUX hashs ont le même coût. Le facteur
// était écrit en dur à sept endroits : 12 sur tous les chemins d'écriture, 10
// sur le hash factice. Mesuré sur bcryptjs : 74 ms contre 299 ms de
// `bcrypt.compare` — un écart déterministe de ~225 ms qui rend le compte
// existant reconnaissable, c'est-à-dire exactement le signal que la mitigation
// est censée effacer.
//
// D'où : le coût est une constante partagée, et le hash factice en est DÉRIVÉ.
// Les deux ne peuvent plus diverger, y compris entre le build SaaS et le build
// self-host (scripts/public-overlay/lib/auth.ts importe le même module).
//
// Hors périmètre volontaire : `lib/totp.ts` (codes de secours) et
// `app/api/share/route.ts` (mot de passe d'un partage) hashent d'autres
// artefacts, jamais comparés au hash factice du login — leur coût peut diverger
// sans créer d'oracle. Ils gardent leur propre constante.

import bcrypt from "bcryptjs";

/** Facteur de coût bcrypt des mots de passe de compte. */
export const PASSWORD_BCRYPT_ROUNDS = 12;

/** Hash un mot de passe de compte. À utiliser sur TOUS les chemins d'écriture
 *  (signup, register, register-and-accept, reset, création de tenant admin). */
export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, PASSWORD_BCRYPT_ROUNDS);
}

/**
 * Hash factice calculé une fois au chargement, au MÊME coût que les hashs
 * réels. Sert aux chemins de rejet rapide du login (compte inconnu, tenant
 * introuvable, rôle insuffisant) : y comparer le mot de passe soumis aligne
 * leur latence sur celle du chemin « compte connu, mauvais mot de passe ».
 *
 * Le calcul coûte ~300 ms, une seule fois par processus. Ne pas le remplacer
 * par une chaîne littérale : la dérivation depuis `PASSWORD_BCRYPT_ROUNDS` est
 * ce qui rend la divergence impossible.
 */
export const DUMMY_PASSWORD_HASH = bcrypt.hashSync(
  "dummy-anti-timing-attack-payload",
  PASSWORD_BCRYPT_ROUNDS,
);
