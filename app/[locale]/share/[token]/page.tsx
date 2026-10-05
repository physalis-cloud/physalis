// Page publique de consommation d'un OneTimeShare. Pas d'auth.
// Server component minimal qui delegue toute la logique au client (le
// decrypt necessite la cle dans le fragment `#`, indisponible cote serveur).

import type { Metadata } from "next";
import ShareConsumeClient from "./share-consume-client";

/**
 * La carte que Slack (ou tout autre aspirateur de liens) affiche sur un lien de
 * partage — ajoutee le 2026-09-16.
 *
 * ⚠️ **Elle ne dit RIEN du contenu partage, et ne le peut pas** : le secret est
 * chiffre, et sa cle vit dans le fragment `#` de l'URL, que le navigateur
 * n'envoie jamais au serveur. Cette page ne sait donc meme pas ce qu'elle
 * affichera. La carte annonce la NATURE du lien, pas ce qu'il y a dedans — et
 * c'est ce qu'on veut : le destinataire voit a quoi il a affaire, sans qu'une
 * ligne du secret parte dans un aperçu.
 *
 * ⚠️ **Le passage d'un robot ne consomme pas le partage.** La consommation est
 * un POST (`app/api/share/[token]/route.ts`) ; un aspirateur de liens ne fait
 * qu'un GET, et la cle lui manque de toute facon. Verifie avant d'ecrire ceci —
 * une carte qui bruleraient le lien avant son destinataire serait pire que pas
 * de carte.
 *
 * ⚠️ **Redeclarer `images` n'est pas une redondance.** Chez Next, un segment qui
 * declare `openGraph` REMPLACE celui du parent (`resolve-metadata.js` :
 * `target.openGraph = resolveOpenGraph(source.openGraph, …)`) — il ne le fusionne
 * pas. Sans cette ligne, cette page perdrait l'image du layout, c'est-a-dire
 * exactement le logo qu'on vient d'ajouter.
 *
 * ⚠️ **Pas de `robots: { index: false }` ici, et c'est delibere.** Le refus
 * d'indexation est porte par `public/robots.txt`, qui ferme la porte aux
 * moteurs ET la laisse ouverte aux aspirateurs de liens nommement. Un
 * `noindex` dans la page risquerait de faire renoncer certains d'entre eux —
 * donc de supprimer la carte pour se proteger de ce que robots.txt interdit
 * deja.
 */
export async function generateMetadata(): Promise<Metadata> {
  // ⚠️ En francais, comme la page elle-meme : `share-consume-client.tsx`
  // n'est pas traduit (« Partage a usage unique » y est en dur), quel que soit
  // le segment de langue de l'URL. Une carte traduite au-dessus d'une page qui
  // ne l'est pas serait un mensonge de plus, pas une amelioration.
  const titre = "Partage à usage unique — Physalis";
  const description = "Quelqu'un vous a partagé un secret. Il se déchiffre dans "
    + "votre navigateur et se détruit côté serveur : vous ne pourrez le voir "
    + "qu'une seule fois.";
  return {
    title: titre,
    description,
    openGraph: {
      type: "website",
      siteName: "Physalis",
      title: titre,
      description,
      // Le logo, comme le layout — voir l'explication du choix la-bas.
      images: [{
        url: "/og-icon.png",
        width: 200,
        height: 200,
        alt: "Physalis",
      }],
    },
    twitter: {
      card: "summary",
      title: titre,
      description,
      images: ["/og-icon.png"],
    },
  };
}

export default async function SharePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return (
    <div className="login-wrap">
      <ShareConsumeClient token={token} />
    </div>
  );
}
