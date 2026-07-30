/**
 * Minimal i18n helper for email templates.
 *
 * Deliberately does NOT use next-intl's getTranslations() because emails
 * are sent from API routes, webhooks (Stripe) and cron jobs — contexts
 * that may not have a Next.js request. This reads the same messages/*.json
 * files to stay in sync but works in any Node.js environment.
 */

// Importing the JSON files directly gives us type-checked, build-time
// bundled translations. next.config.ts already sets resolveJsonModule = true.
import enMessages from "../messages/en.json";
import frMessages from "../messages/fr.json";
import esMessages from "../messages/es.json";

export type EmailLocale = "en" | "fr" | "es";

const MESSAGES: Record<EmailLocale, typeof enMessages> = {
  en: enMessages,
  fr: frMessages,
  es: esMessages,
};

function getPath(obj: unknown, path: string): string {
  const parts = path.split(".");
  let cur: unknown = obj;
  for (const p of parts) {
    if (typeof cur !== "object" || cur === null) return path;
    cur = (cur as Record<string, unknown>)[p];
  }
  return typeof cur === "string" ? cur : path;
}

/**
 * Returns a t() function scoped to the `emails.*` namespace for the given locale.
 * Falls back to "en" for unknown locales.
 *
 * Usage:
 *   const t = emailTranslator(locale);
 *   t("invitation.subject", { org: "Acme" })  // → translated subject
 */
export function emailTranslator(locale?: string | null) {
  const loc: EmailLocale =
    locale && locale in MESSAGES ? (locale as EmailLocale) : "en";
  const msgs = MESSAGES[loc].emails as Record<string, unknown>;

  return function t(key: string, vars?: Record<string, string>): string {
    let str = getPath(msgs, key);
    if (vars) {
      for (const [k, v] of Object.entries(vars)) {
        str = str.replaceAll(`{${k}}`, v);
      }
    }
    return str;
  };
}

/**
 * Résout la locale de l'utilisateur qui déclenche l'envoi d'un email.
 *
 *   const locale = localeFromRequest(req);
 *
 * ⚠️ Les deux premières sources ne sont JAMAIS disponibles sur une route API :
 * le `matcher` du middleware exclut `/api` (donc pas de `x-next-intl-locale`)
 * et les chemins d'API ne portent pas de préfixe de locale. Sans les deux replis
 * ci-dessous, tout email émis depuis une route API partait en anglais quelle
 * que soit la langue de l'utilisateur — invitation, renvoi d'invitation,
 * demande de secret, secret reçu, partage consommé.
 *
 * La précédence reflète volontairement `detectLocale` (middleware.ts) : cookie
 * `NEXT_LOCALE` (posé par LocaleSwitcher, `path=/` donc envoyé aux routes API)
 * puis `Accept-Language`. Un email doit arriver dans la langue de l'UI.
 */
export function localeFromRequest(req: Request): EmailLocale {
  const header = req.headers.get("x-next-intl-locale");
  if (header && header in MESSAGES) return header as EmailLocale;

  const match = new URL(req.url).pathname.match(/^\/([a-z]{2})(\/|$)/);
  if (match && match[1] in MESSAGES) return match[1] as EmailLocale;

  const cookie = req.headers
    .get("cookie")
    ?.match(/(?:^|;\s*)NEXT_LOCALE=([a-z]{2})/i)?.[1]
    ?.toLowerCase();
  if (cookie && cookie in MESSAGES) return cookie as EmailLocale;

  for (const part of (req.headers.get("accept-language") ?? "").split(",")) {
    const lang = part.trim().split(";")[0]?.slice(0, 2).toLowerCase();
    if (lang && lang in MESSAGES) return lang as EmailLocale;
  }

  return "en";
}

/**
 * Formats a date for display in email templates using the locale's conventions.
 */
export function formatEmailDate(date: Date, locale: EmailLocale): string {
  const localeMap: Record<EmailLocale, string> = {
    en: "en-GB",
    fr: "fr-FR",
    es: "es-ES",
  };
  return date.toLocaleString(localeMap[locale], {
    timeZone: "Europe/Paris",
    dateStyle: "long",
    timeStyle: "short",
  });
}
