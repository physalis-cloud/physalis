/**
 * Gabarit HTML partagé des emails transactionnels.
 *
 * Un seul endroit pour la mise en page : les 9 emails étaient jusqu'ici 9
 * copies d'un `<div>` nu, chacune avec ses propres couleurs (dont un bleu
 * marine #1a1f35 absent de la charte). Ils partagent désormais la carte, le
 * logo et les tokens du design system « Cuivre signature » (app/globals.css).
 *
 * ── Contraintes propres à l'email (à respecter en modifiant ce fichier) ──
 * - Mise en page en `<table>`, pas en flex/grid : Outlook (moteur Word) ne
 *   supporte ni l'un ni l'autre.
 * - Styles INLINE uniquement : Gmail retire les `<style>` et toute CSS externe.
 * - Pas d'unité relative sur les largeurs structurelles, pas de `position`.
 * - Le bouton est un `<td bgcolor>` + `<a>` : un `<a>` seul perd son fond sur
 *   les Outlook Windows.
 * - L'image du logo est absolue et hébergée : les `data:` URI sont bloqués par
 *   Gmail. Son URL vient de `physalisBaseUrl()`, qui doit donc être PUBLIQUEMENT
 *   JOIGNABLE — en dev local elle vaut `http://localhost:3001`, que le client
 *   mail du destinataire ne peut pas atteindre : le logo n'apparaît pas, c'est
 *   attendu. ⚠️ En prod, cela suppose `PHYSALIS_URL` posée : la chaîne de repli
 *   passe par `NEXTAUTH_URL`, or celle-ci est justement RETIRÉE quand le SSO
 *   natif par sous-domaine est actif (cf. lib/app-url) — sans `PHYSALIS_URL`
 *   l'URL retomberait sur localhost et le logo casserait aussi en prod.
 * - Le mot-marque « Physalis » est du TEXTE à côté du logo, et l'image porte un
 *   `alt` vide : si le client bloque les images, le nom reste lisible sans
 *   doublon pour les lecteurs d'écran.
 *
 * ── Contrat d'échappement (cf. docs/failles.md §2.11) ──
 * Les champs suffixés `Html` sont insérés TELS QUELS : c'est à l'appelant de
 * les échapper. Les autres champs sont du texte, échappés ici. Ce suffixe est
 * la convention qui rend la revue possible d'un coup d'œil.
 */

import { physalisBaseUrl } from "./app-url";

/** Tokens repris de app/globals.css (`:root`). */
const C = {
  bg: "#f5f3ef",
  surface: "#ffffff",
  fg: "#1a1a1a",
  muted: "#6b6258",
  border: "#e5e0d6",
  accentText: "#946420",
  accentBg: "#f4ebd7",
  accentSoft: "#dcbf62",
  codeBg: "#efeae0",
  // Bouton : valeurs de `.btn-primary` (globals.css) — crème doré à texte brun,
  // PAS le token `--primary` (#2d2d2d), dont le commentaire « fond des
  // btn-primary » est trompeur : la règle réelle utilise `--accent-bg`.
  btnBg: "#f4ebd7",
  btnFg: "#6a4c14",
  btnBorder: "#dcbf62",
} as const;

const FONT =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/**
 * Échappement HTML des valeurs dynamiques insérées dans un gabarit d'email.
 *
 * ⚠️ Le HTML UNIQUEMENT. `text` et `subject` sont du texte brut : les échapper
 * afficherait `&amp;` à l'écran. Et ce sont les VARIABLES passées à `t()` qu'il
 * faut échapper, pas sa sortie — `emailTranslator` fait un `replaceAll` brut,
 * et certaines chaînes de traduction reçoivent du markup volontairement.
 */
export function esc(value: string): string {
  return value
    .replaceAll("&", "&amp;") // en premier, sinon il ré-échappe les suivants
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export type EmailLayout = {
  /** Titre affiché dans la carte. Texte — échappé ici. */
  title: string;
  /** Corps principal. HTML — à échapper par l'appelant. */
  bodyHtml: string;
  /** Bouton d'action principal. `label` est du texte, échappé ici. */
  cta?: { label: string; url: string };
  /** Mentions en bas de carte (expiration, « ignorez ce message »). HTML. */
  footerHtml?: string;
};

/** Encadré neutre — utilisé pour un label mis en avant ou un récapitulatif. */
export function panel(innerHtml: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px"><tr><td style="background:${C.codeBg};border-radius:8px;padding:14px 16px;font-family:${FONT};font-size:14px;color:${C.fg}">${innerHtml}</td></tr></table>`;
}

/** Encadré d'alerte (fond doré clair) — dépassement de quota, avertissement. */
export function noticePanel(innerHtml: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px"><tr><td style="background:${C.accentBg};border-radius:8px;padding:14px 16px;font-family:${FONT};font-size:14px;color:${C.accentText}">${innerHtml}</td></tr></table>`;
}

/** Paragraphe standard. `innerHtml` est du HTML (échappé par l'appelant). */
export function p(innerHtml: string, opts?: { muted?: boolean }): string {
  const color = opts?.muted ? C.muted : C.fg;
  const size = opts?.muted ? "13px" : "15px";
  return `<p style="margin:0 0 14px;font-family:${FONT};font-size:${size};line-height:1.6;color:${color}">${innerHtml}</p>`;
}

/** Tableau clé/valeur (partage consommé). Les deux colonnes sont du HTML. */
export function dataRows(rows: Array<[string, string]>): string {
  const trs = rows
    .map(
      ([k, v]) =>
        `<tr><td style="padding:5px 16px 5px 0;font-family:${FONT};font-size:14px;color:${C.muted};white-space:nowrap">${k}</td><td style="padding:5px 0;font-family:${FONT};font-size:14px;color:${C.fg}">${v}</td></tr>`,
    )
    .join("");
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px">${trs}</table>`;
}

function button(label: string, url: string): string {
  return `
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 20px">
        <tr>
          <td align="center" bgcolor="${C.btnBg}" style="border-radius:8px;border:1px solid ${C.btnBorder}">
            <a href="${esc(url)}" style="display:inline-block;padding:12px 26px;font-family:${FONT};font-size:15px;font-weight:600;letter-spacing:0.02em;line-height:1;color:${C.btnFg};text-decoration:none;border-radius:8px">${esc(label)}</a>
          </td>
        </tr>
      </table>`;
}

/**
 * Assemble le HTML complet d'un email : fond, logo, carte, pied de page.
 * Retourne un document autonome (les clients mail ignorent `<head>` mais
 * `meta viewport` et `lang` restent utiles sur mobile et pour les lecteurs
 * d'écran).
 */
export function renderEmail(layout: EmailLayout, locale = "en"): string {
  const logoUrl = `${physalisBaseUrl()}/icon-128.png`;
  const cta = layout.cta ? button(layout.cta.label, layout.cta.url) : "";
  const footer = layout.footerHtml
    ? `<div style="margin:22px 0 0;padding:16px 0 0;border-top:1px solid ${C.border};font-family:${FONT};font-size:13px;line-height:1.6;color:${C.muted}">${layout.footerHtml}</div>`
    : "";

  return `<!doctype html>
<html lang="${esc(locale)}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${C.bg};-webkit-font-smoothing:antialiased">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.bg}">
    <tr>
      <td align="center" style="padding:28px 12px 36px">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px">
          <tr>
            <td align="center" style="padding:0 0 18px">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td valign="middle" style="padding:0 10px 0 0">
                    <img src="${esc(logoUrl)}" width="38" height="38" alt="" style="display:block;border:0;outline:none;text-decoration:none">
                  </td>
                  <td valign="middle" style="font-family:${FONT};font-size:20px;font-weight:600;letter-spacing:0.01em;color:${C.fg}">Physalis</td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="background:${C.surface};border:1px solid ${C.border};border-radius:14px;padding:34px 30px">
              <h1 style="margin:0 0 18px;font-family:${FONT};font-size:20px;line-height:1.35;font-weight:600;color:${C.fg}">${esc(layout.title)}</h1>
              ${layout.bodyHtml}
              ${cta}
              ${footer}
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:18px 8px 0;font-family:${FONT};font-size:12px;line-height:1.5;color:${C.muted}">
              Physalis — gestionnaire de secrets
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}
