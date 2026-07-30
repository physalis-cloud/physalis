// Régression : tout email émis depuis une route API partait en anglais, quelle
// que soit la langue de l'utilisateur.
//
// Cause : `localeFromRequest` ne lisait que `x-next-intl-locale` (posé par le
// middleware, dont le `matcher` EXCLUT `/api`) et le préfixe de locale du
// chemin (absent des chemins d'API). Les deux sources sont structurellement
// indisponibles là où les emails sont envoyés — invitation, renvoi, demande de
// secret, secret reçu, partage consommé.
//
// Le repli cookie/Accept-Language reflète `detectLocale` (middleware.ts) : un
// email doit arriver dans la même langue que l'UI.

import { describe, it, expect } from "vitest";
import { localeFromRequest } from "@/lib/email-i18n";

function req(
  url: string,
  headers: Record<string, string> = {},
): Request {
  return new Request(url, { headers });
}

describe("localeFromRequest", () => {
  describe("sources disponibles hors /api", () => {
    it("lit x-next-intl-locale en priorité", () => {
      expect(
        localeFromRequest(
          req("http://x.test/fr/page", {
            "x-next-intl-locale": "es",
            cookie: "NEXT_LOCALE=fr",
          }),
        ),
      ).toBe("es");
    });

    it("lit le préfixe de locale du chemin ensuite", () => {
      expect(
        localeFromRequest(
          req("http://x.test/fr/page", { "accept-language": "es-ES" }),
        ),
      ).toBe("fr");
    });
  });

  describe("routes API — ni en-tête middleware, ni préfixe de chemin", () => {
    it("retombe sur le cookie NEXT_LOCALE (le cas du bug)", () => {
      expect(
        localeFromRequest(
          req("http://x.test/api/orgs/acme/members", {
            cookie: "NEXT_LOCALE=fr",
          }),
        ),
      ).toBe("fr");
    });

    it("trouve le cookie parmi d'autres", () => {
      expect(
        localeFromRequest(
          req("http://x.test/api/orgs/acme/members", {
            cookie: "authjs.session-token=abc; NEXT_LOCALE=es; theme=dark",
          }),
        ),
      ).toBe("es");
    });

    it("retombe sur Accept-Language sans cookie", () => {
      expect(
        localeFromRequest(
          req("http://x.test/api/orgs/acme/members", {
            "accept-language": "fr-FR,fr;q=0.9,en;q=0.8",
          }),
        ),
      ).toBe("fr");
    });

    it("le cookie prime sur Accept-Language (choix explicite de l'utilisateur)", () => {
      expect(
        localeFromRequest(
          req("http://x.test/api/orgs/acme/members", {
            cookie: "NEXT_LOCALE=es",
            "accept-language": "fr-FR,fr;q=0.9",
          }),
        ),
      ).toBe("es");
    });
  });

  describe("replis", () => {
    it("anglais si aucun signal", () => {
      expect(localeFromRequest(req("http://x.test/api/orgs/acme/members"))).toBe(
        "en",
      );
    });

    it("ignore une locale non supportée et poursuit la chaîne", () => {
      expect(
        localeFromRequest(
          req("http://x.test/api/x", {
            cookie: "NEXT_LOCALE=de",
            "accept-language": "de-DE,de;q=0.9,fr;q=0.8",
          }),
        ),
      ).toBe("fr");
    });
  });
});
