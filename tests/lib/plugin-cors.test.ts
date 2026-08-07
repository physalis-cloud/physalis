// Tests de `checkPluginOrigin` — la whitelist d'origines des endpoints
// `/api/plugin/*` consommes par l'extension navigateur.
//
// Enjeu principal : l'origin d'une extension Firefox est
// `moz-extension://<uuid>` avec un uuid regenere a chaque installation, donc
// non epinglable. Firefox envoie bien cet en-tete (bug Mozilla 1405971,
// toujours ouvert), et un Origin PRESENT mais non whiteliste est rejete —
// il ne « retombe » pas dans la branche « Origin absent ». Sans le token
// `moz-extension://*`, tout client Firefox prend donc un 403.
//
// Les tests d'integration (tests/integ/cors-strict.test.ts) couvrent le meme
// helper de bout en bout contre un serveur reel ; ici on teste le helper seul
// pour ne pas dependre de la config d'env du serveur de test.

import { describe, it, expect, afterEach } from "vitest";
import { checkPluginOrigin } from "@/lib/plugin-cors";

const ORIGINAL = process.env.PLUGIN_ALLOWED_ORIGIN;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.PLUGIN_ALLOWED_ORIGIN;
  else process.env.PLUGIN_ALLOWED_ORIGIN = ORIGINAL;
});

const CHROME = "chrome-extension://nkbdijmefoleebhonbfadecclaieolea";
const FIREFOX = "moz-extension://a1cd9ab7-ab15-462c-9315-8eece8e16982";

/** Forge une requete plugin. `origin: null` = en-tete omis. */
function req(origin: string | null): Request {
  const headers = new Headers();
  if (origin !== null) headers.set("origin", origin);
  return new Request("https://vault.physalis.cloud/api/plugin/match", {
    method: "GET",
    headers,
  });
}

function setAllowed(value: string | undefined): void {
  if (value === undefined) delete process.env.PLUGIN_ALLOWED_ORIGIN;
  else process.env.PLUGIN_ALLOWED_ORIGIN = value;
}

describe("checkPluginOrigin", () => {
  describe("kill switch", () => {
    it("PLUGIN_ALLOWED_ORIGIN absente → refus", () => {
      setAllowed(undefined);
      expect(checkPluginOrigin(req(CHROME))).toEqual({
        ok: false,
        reason: "no_origin_configured",
      });
    });

    it("PLUGIN_ALLOWED_ORIGIN vide → refus", () => {
      setAllowed("  ,  ");
      expect(checkPluginOrigin(req(null))).toEqual({
        ok: false,
        reason: "no_origin_configured",
      });
    });
  });

  describe("Chrome (ID fige par le `key` du manifest)", () => {
    it("origin whitelistee → acceptee et renvoyee en ACAO", () => {
      setAllowed(CHROME);
      expect(checkPluginOrigin(req(CHROME))).toEqual({
        ok: true,
        allowOrigin: CHROME,
      });
    });

    it("origin absente → acceptee, on fait confiance au Bearer", () => {
      setAllowed(CHROME);
      expect(checkPluginOrigin(req(null))).toEqual({
        ok: true,
        allowOrigin: null,
      });
    });

    it("un ID d'extension non liste → 403", () => {
      setAllowed(CHROME);
      expect(checkPluginOrigin(req("chrome-extension://aaaaaaaaaaaa"))).toEqual({
        ok: false,
        reason: "origin_not_allowed",
      });
    });
  });

  describe("Firefox (uuid imprevisible)", () => {
    it("sans le token wildcard → 403 (regression du bug de prod)", () => {
      // Etat d'avant le correctif : la whitelist ne contient que des IDs
      // Chrome, donc tout client Firefox est rejete.
      setAllowed(CHROME);
      expect(checkPluginOrigin(req(FIREFOX))).toEqual({
        ok: false,
        reason: "origin_not_allowed",
      });
    });

    it("avec `moz-extension://*` → acceptee et renvoyee en ACAO", () => {
      setAllowed(`${CHROME},moz-extension://*`);
      expect(checkPluginOrigin(req(FIREFOX))).toEqual({
        ok: true,
        allowOrigin: FIREFOX,
      });
    });

    it("le wildcard n'ouvre QUE le schema moz-extension", () => {
      setAllowed(`${CHROME},moz-extension://*`);
      for (const bad of [
        "https://attacker.example",
        "null",
        "chrome-extension://aaaaaaaaaaaa",
      ]) {
        expect(checkPluginOrigin(req(bad))).toEqual({
          ok: false,
          reason: "origin_not_allowed",
        });
      }
    });

    it("le wildcard exige un uuid v4 bien forme", () => {
      setAllowed("moz-extension://*");
      for (const bad of [
        "moz-extension://attacker.example",
        "moz-extension://",
        "moz-extension://a1cd9ab7ab15462c93158eece8e16982", // sans tirets
        "moz-extension://A1CD9AB7-AB15-462C-9315-8EECE8E16982", // majuscules
        "moz-extension://a1cd9ab7-ab15-462c-9315-8eece8e16982/x", // chemin
      ]) {
        expect(checkPluginOrigin(req(bad))).toEqual({
          ok: false,
          reason: "origin_not_allowed",
        });
      }
    });

    it("le token litteral `moz-extension://*` n'est pas une origin valide", () => {
      // Sinon on renverrait `Access-Control-Allow-Origin: moz-extension://*`,
      // qui n'est pas une origin — le token doit sortir de la liste exacte.
      setAllowed("moz-extension://*");
      expect(checkPluginOrigin(req("moz-extension://*"))).toEqual({
        ok: false,
        reason: "origin_not_allowed",
      });
    });

    it("le wildcard seul ne desactive pas le kill switch pour les autres", () => {
      setAllowed("moz-extension://*");
      expect(checkPluginOrigin(req(CHROME))).toEqual({
        ok: false,
        reason: "origin_not_allowed",
      });
    });
  });

  describe("anti-CSRF (le vrai role du helper)", () => {
    it("une page web tierce est rejetee, wildcard Firefox ou non", () => {
      setAllowed(`${CHROME},moz-extension://*`);
      for (const bad of [
        "https://attacker.example",
        "https://argoweb.physalis.cloud", // meme l'app elle-meme
        "http://localhost:3000",
      ]) {
        expect(checkPluginOrigin(req(bad))).toEqual({
          ok: false,
          reason: "origin_not_allowed",
        });
      }
    });
  });
});
