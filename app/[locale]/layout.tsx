import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { headers } from "next/headers";
import { NextIntlClientProvider } from "next-intl";
import { getMessages } from "next-intl/server";
import { estHoteSaaS } from "@/lib/app-url";
import { originePubliqueDesEnTetes } from "@/lib/origine-publique";
import "../globals.css";

/**
 * Les metadonnees, dont **Open Graph — absent jusqu'au 2026-09-16**.
 *
 * ⚠️ **Le constat qui a ouvert ce chantier** : un lien de l'app colle dans
 * Slack n'affichait ni logo ni description. La vitrine, elle, porte un jeu
 * complet depuis toujours — ce domaine-ci ne servait que
 * `<title>Physalis</title>`. Slack n'avait donc rien a montrer : ce n'etait pas
 * un reglage casse, c'etait une surface jamais ecrite. Et les liens de PARTAGE
 * sont construits sur l'origine de l'app (`share-create-button.tsx`), donc
 * c'est ici qu'ils passent.
 *
 * ⚠️ **`generateMetadata` et non plus une constante, a cause de
 * `metadataBase`.** Next resout les URL relatives des images Open Graph contre
 * elle, et une valeur figee serait fausse partout ailleurs : sous-domaines de
 * tenant, portail `vault.`, et chaque instance auto-hebergee. On la deduit donc
 * des en-tetes de la requete, par le meme chemin que l'URI de redirection OAuth
 * — voir `lib/origine-publique.ts` pour le piege du `req.url` a `0.0.0.0:3000`.
 *
 * ⚠️ **Pas de `metadataBase` plutot qu'une fausse** : sans hote lisible, Next
 * emet l'image en relatif et les aspirateurs de liens l'ignorent. C'est
 * exactement ce qu'on veut — mieux vaut pas de carte qu'une carte qui pointe un
 * hote qui n'est pas le notre.
 */
export async function generateMetadata(): Promise<Metadata> {
  const enTetes = await headers();
  const origine = originePubliqueDesEnTetes(enTetes);
  const titre = "Physalis";
  /**
   * ⚠️ **« Self-hosted » etait FAUX sur `vault.physalis.cloud`**, qui est
   * justement l'offre hebergee — la phrase annoncait le contraire du service
   * qu'on vend, dans l'apercu de chaque lien partage. Elle reste vraie, et
   * utile, sur une instance auto-hebergee : c'est donc l'HOTE qui decide, pas
   * une constante.
   *
   * ⚠️ La formule SaaS reprend mot pour mot celle de la vitrine
   * (`physalis/frontend/index.html`) : la carte d'un lien d'app et celle du site
   * doivent se lire comme le meme produit. Deux accroches redigees separement
   * auraient diverge des la premiere retouche de l'une des deux.
   */
  const description = estHoteSaaS(
    enTetes.get("x-forwarded-host") ?? enTetes.get("host"),
  )
    ? "Secrets manager for developers"
    : "Self-hosted secrets manager";
  return {
    ...(origine ? { metadataBase: new URL(origine) } : {}),
    title: titre,
    description,
    openGraph: {
      type: "website",
      siteName: titre,
      title: titre,
      description,
      // ⚠️ **Le LOGO, pas la carte marketing de la vitrine.** Le premier jet
      // reprenait l'image 1200×630 de physalis.cloud — une composition avec
      // titre, accroche et nom de domaine, qui se lit comme une capture de la
      // page d'accueil au-dessus d'un lien d'application. Ce qu'un lien d'app
      // doit porter, c'est la marque.
      //
      // ⚠️ **`og-icon.png` EST `icon-128.png`, agrandi a 200×200.** Le logo du
      // produit, pas la carte marketing de la vitrine ni le rendu de
      // `public/logo.svg` — qui est un AUTRE dessin (la lanterne sur carre
      // sombre). Aucune version plus grande de cette marque n'existe dans
      // l'ecosysteme : la source reste `icon-128.png`, qui fait 165×165 malgre
      // son nom.
      //
      // ⚠️ **Pourquoi 200 et pas 165** : LinkedIn et Facebook ignorent toute
      // vignette sous 200×200. L'agrandissement n'est que de 1,21×, donc sans
      // adoucissement visible — la question ne se poserait pas a 3×.
      //
      // ⚠️ **Un fichier DEDIE, et pas `icon-128.png` ecrase** : six ecrans s'en
      // servent (invitation, paiement, page de partage). Le regenerer en place
      // aurait change leur rendu pour un besoin qui n'est pas le leur.
      //
      // ⚠️ Chemin RELATIF, resolu contre `metadataBase` : une URL absolue en dur
      // ferait servir l'image de physalis.cloud depuis une instance
      // auto-hebergee — soit une carte qui annonce un autre domaine que celui
      // du lien.
      images: [{
        url: "/og-icon.png",
        width: 200,
        height: 200,
        alt: "Physalis",
      }],
    },
    twitter: {
      // ⚠️ `summary` et non `summary_large_image` : la carte large attend une
      // banniere et recadre un carre. Avec un logo, c'est la vignette qu'on
      // veut — celle qui s'affiche a cote du titre.
      card: "summary",
      title: titre,
      description,
      images: ["/og-icon.png"],
    },
  };
}

// Sans cet export, mobile zoome-out a 980px par defaut et l'app n'est
// pas du tout responsive. Next 15 separe viewport de metadata.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default async function LocaleLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;

  // Lecture du header x-nonce pose par le middleware. Cet appel a un effet
  // de bord critique : il bascule TOUTES les pages en rendu dynamique au
  // lieu de prerender statique. Sans ca, les pages comme /login seraient
  // servies depuis le build cache (sans nonce dans les <script> inline) +
  // CSP fraiche (avec nonce different) → mismatch + browser block.
  await headers();

  const messages = await getMessages();

  return (
    <html lang={locale} className="h-full antialiased">
      <body className="min-h-full flex flex-col">
        <NextIntlClientProvider messages={messages}>
          {children}
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
