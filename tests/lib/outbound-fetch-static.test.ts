// Test statique — garde-fou de la classe SSRF
// (documentation/rapports/failles.md §6 / §2.25d, documentation/rapports/rapport-security.md F9.1).
//
// Contexte : `lib/safe-fetch.ts` est une garde SSRF de bonne facture (https
// imposé, refus des identifiants inline et des hôtes sans point, DNS résolu
// avec rejet si UNE SEULE adresse est privée, redirections re-validées). Le
// problème n'a jamais été son absence — c'est qu'un site l'oublie. F9.1 était
// exactement ça : `/api/account/sso/test` construisait son URL depuis le corps
// de la requête et la passait à un `fetch` nu, transformant la route en
// scanner de ports du réseau interne.
//
// Règle tenue ici : AUCUNE route de `app/api` n'appelle `fetch` directement.
// Une sortie réseau part soit par `safeFetchHook`, soit par un helper nommé de
// `lib/` qui porte lui-même sa politique — et dont la liste est figée ci-dessous.
//
// Ce test est un TRIPWIRE : il casse quand une nouvelle sortie réseau apparaît
// sans passer par la garde, au moment où son auteur peut encore choisir.

import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "../..");

/** Ce fichier vit aussi dans le build self-host, où l'arborescence diffère
 *  (routes SaaS retirées, jumeaux d'overlay). Les assertions portant sur un
 *  chemin précis sont donc conditionnées à son existence. */
function present(rel: string): boolean {
  return existsSync(resolve(REPO_ROOT, rel));
}

/** Vrai dans le dépôt source, faux dans un build self-host (overlay déjà
 *  appliqué, `scripts/public-overlay/` consommé). Les règles de SÉCURITÉ
 *  valent dans les deux ; les règles d'HYGIÈNE de l'allowlist n'ont de sens
 *  que côté source, où l'arborescence de référence est complète. */
const IS_SOURCE_REPO = present("scripts/public-overlay");

/**
 * Routes autorisées à appeler `fetch` en direct. Même règle que LIB_ALLOWED :
 * l'URL ne doit pas pouvoir être influencée par l'appelant.
 */
const API_ALLOWED: Record<string, string> = {
  // Jumeau d'overlay self-host, en retard sur le SaaS (qui a déplacé l'appel
  // dans lib/redeploy.ts) : hôte constant api.github.com, workflow encodé.
  "app/api/projects/[slug]/redeploy/route.ts": "hôte constant api.github.com",
};

/**
 * Modules de `lib/` autorisés à appeler `fetch` en direct, avec la raison.
 * Ajouter une entrée est un ACTE D'AUDIT : il faut avoir établi que l'URL
 * n'est PAS dérivée d'une saisie utilisateur, ou qu'elle est gardée autrement.
 */
const LIB_ALLOWED: Record<string, string> = {
  "lib/safe-fetch.ts": "la garde elle-même",
  // ⚠️ Cette raison ne parle QUE de l'appel `fetch` littéral. `lib/sso.ts`
  // portait aussi une sortie réseau DÉLÉGUÉE — un `issuer` fourni par l'admin
  // du tenant, remis à NextAuth qui le fetch lui-même — invisible pour une
  // règle qui cherche un appel. Fermée le 2026-08-09 (`customFetch` →
  // `safeFetchHook`) et surveillée par `tests/lib/sso-outbound-fetch.test.ts`,
  // qui mesure l'objet provider construit et non le texte du fichier.
  "lib/sso.ts": "URL constante api.github.com (récupération de l'email)",
  "lib/email.ts": "relais email interne, URL de configuration serveur",
  "lib/physalis-email.ts": "service interne, URL de configuration serveur",
  "lib/support.ts": "microservice support, URL de configuration serveur",
  "lib/redeploy.ts": "API du provider CI (GitHub/GitLab/Bitbucket), hôtes constants",
  "lib/project-docs.ts": "API du provider CI, hôtes constants + chemin de dépôt",
  // Sondes d'accréditation Google Play / App Store Connect (Phase 2 du
  // déploiement mobile). Les quatre endpoints sont des CONSTANTES du module.
  // ⚠️ Le piège est ailleurs et vaut d'être écrit : un JSON de compte de
  // service Google porte un champ `token_uri` qu'il serait naturel d'honorer.
  // Le faire donnerait à quiconque peut importer un credential le pouvoir de
  // faire fetcher une URL arbitraire par le serveur central. Le champ est donc
  // délibérément IGNORÉ au profit de l'endpoint écrit en dur.
  "lib/mobile-store-api.ts": "API Google Play / App Store Connect, hôtes constants (token_uri du credential ignoré exprès)",
  "lib/sync/vercel.ts": "API Vercel, hôte constant",
  "lib/sync/render.ts": "API Render, hôte constant",
  "lib/sync/railway.ts": "API Railway, hôte constant",
  // Seule entrée qui ne soit PAS une sortie serveur : ce module est marqué
  // client (importé par components/LogoutButton.tsx) et son `fetch` vise une
  // URL relative same-origin depuis le navigateur. Il ne traverse jamais le
  // réseau interne — aucune surface SSRF à garder.
  "lib/extension-bridge.ts": "appel navigateur same-origin (URL relative constante)",
};

/** Fichiers appelant `fetch(` en dehors de `safeFetchHook`. */
function bareFetchFiles(dir: string): string[] {
  let out = "";
  try {
    out = execSync(
      `grep -rEn "[^a-zA-Z.]fetch\\(" ${JSON.stringify(dir)} --include='*.ts'`,
      { cwd: REPO_ROOT, encoding: "utf8" },
    );
  } catch {
    return [];
  }
  return [
    ...new Set(
      out
        .split("\n")
        .filter(Boolean)
        // Commentaires et mentions de safeFetchHook ne sont pas des appels.
        // Motif ancré sur le préfixe `fichier:ligne:` — sans ancrage, le
        // `://` d'une URL passerait pour un début de commentaire.
        .filter((l) => !/^[^:]+:\d+:\s*(\/\/|\*)/.test(l))
        .filter((l) => !/safeFetchHook/.test(l))
        .map((l) => l.split(":")[0]),
    ),
  ].sort();
}

describe("sorties réseau — la garde SSRF n'est pas contournée", () => {
  it("aucune route de app/api n'appelle fetch en direct", () => {
    expect(
      bareFetchFiles("app/api").filter((f) => !(f in API_ALLOWED)),
      "Sortie réseau depuis une route : si l'URL vient de l'appelant (corps, " +
        "query, config qu'il contrôle), passe-la par `safeFetchHook` — sinon " +
        "la route devient un oracle sur le réseau interne (cf. F9.1). Si " +
        "l'hôte est constant, déplace l'appel dans un helper de lib/.",
    ).toEqual([]);
  });

  it("les fetch directs de lib/ restent dans la liste auditée", () => {
    const unknown = bareFetchFiles("lib").filter((f) => !(f in LIB_ALLOWED));
    expect(
      unknown,
      "Nouveau `fetch` nu dans lib/. Si l'URL peut être influencée par un " +
        "utilisateur, route-la par `safeFetchHook`. Sinon, documente pourquoi " +
        "elle ne peut pas l'être et ajoute le fichier à LIB_ALLOWED.",
    ).toEqual([]);
  });

  it("l'allowlist ne garde pas d'entrée morte", () => {
    // Hygiène du dépôt source uniquement : dans un build self-host, l'overlay
    // réécrit certains modules sans leur `fetch` (lib/email.ts passe en SMTP)
    // — une entrée sans correspondance n'y est pas une entrée morte.
    if (!IS_SOURCE_REPO) return;
    const actual = new Set(bareFetchFiles("lib"));
    const stale = Object.keys(LIB_ALLOWED).filter((f) => !actual.has(f));
    expect(stale, "Entrées LIB_ALLOWED sans fetch correspondant").toEqual([]);
  });

  it("la route SSO test passe bien par la garde", () => {
    const route = "app/api/account/sso/test/route.ts";
    // SSO Enterprise est SaaS-only (denylisté du build public).
    if (!present(route)) return;
    const src = execSync(`cat ${JSON.stringify(route)}`, {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    expect(src).toContain("safeFetchHook");
  });
});
