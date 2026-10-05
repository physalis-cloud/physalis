// L'origine PUBLIQUE d'une requete — celle que voit le navigateur.
//
// ⚠️ **Extrait de `lib/automation/oauth-custody.ts` le 2026-09-16, pas
// reecrit.** La meme deduction sert desormais a deux endroits qui n'ont rien a
// voir : l'URI de redirection OAuth, et l'URL absolue des images Open Graph.
// Deux implementations auraient diverge, et elles se trompent de la meme facon
// — voir le piege ci-dessous, qui a deja coute une URI `0.0.0.0:3000`.
//
// ⚠️ **`req.url` ne convient PAS.** En Next standalone derriere un proxy — ou
// simplement dans un conteneur avec un port publie — il porte l'ADRESSE DE BIND
// (`http://0.0.0.0:3000`), pas l'URL demandee par le navigateur.

/** Ce qu'on lit : `Headers` d'une `Request` comme le `headers()` de Next. */
type EnTetes = { get(nom: string): string | null };

/**
 * L'origine deduite des en-tetes, ou `null` s'il n'y a aucun hote a lire.
 *
 * ⚠️ **`null` et pas un defaut.** L'appelant sait, lui, ce qu'il peut mettre a
 * la place : une `Request` retombe sur son `req.url`, un layout n'affiche
 * simplement pas d'URL absolue. Choisir ici un `https://localhost` ferait
 * fabriquer des URL fausses que rien ne signalerait.
 */
export function originePubliqueDesEnTetes(h: EnTetes): string | null {
  const brut = h.get("x-forwarded-host") ?? h.get("host") ?? "";
  // Un `x-forwarded-*` peut porter une LISTE (`a, b`) quand plusieurs proxys se
  // succedent : c'est le premier qui est l'hote d'origine.
  const host = brut.split(",")[0]?.trim() ?? "";
  if (!host) return null;
  // ⚠️ Le protocole : `x-forwarded-proto` quand le proxy le pose ; sinon on le
  // DEDUIT de l'hote plutot que de choisir un defaut fixe. « https » par defaut
  // donnerait `https://localhost:3006` en dev ; « http » par defaut donnerait
  // une URL en clair le jour ou un proxy oublie l'en-tete. Deduire est le seul
  // des trois qui ne se trompe dans aucun des deux sens.
  const proto = (h.get("x-forwarded-proto") ?? "").split(",")[0]?.trim()
    || (/^(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(host) ? "http" : "https");
  return `${proto}://${host}`;
}
