#!/usr/bin/env node
// Génère `lib/automation/credential-catalogue.ts` depuis le relevé des types de
// credentials d'une instance N8N (C-0046, T-0252).
//
// Usage :
//   node scripts/generate-n8n-credential-catalogue.mjs docs/credentials-n8n.json
//
// ⚠️ **Pourquoi un fichier GÉNÉRÉ et pas une lecture du JSON à l'exécution.**
// Deux raisons, et la seconde a déjà coûté une panne en production :
//   · l'API publique de N8N **n'énumère pas** les types de credentials
//     (`/credentials/schema/{type}` exige de connaître le nom ; le catalogue de
//     l'éditeur `/types/credentials.json` répond 401 avec une clé API). Le relevé
//     est donc un geste manuel, et son résultat doit être figé quelque part ;
//   · `docs/` est **exclu par `.dockerignore`**. Un module qui lirait ce JSON au
//     runtime marcherait en développement et rendrait 500 en production, sans
//     rien dans les logs qui pointe vers `.dockerignore`. Le fichier généré est
//     du TypeScript ordinaire, donc compilé dans l'image.
//
// ⚠️ Ce catalogue VIEILLIT — c'est un relevé daté d'une instance précise. Il ne
// sert qu'à PROPOSER des types et à dire lesquels sont hors régime B ; la forme
// des champs, elle, vient toujours de `GET /credentials/schema/{type}` sur
// l'instance visée. Notre liste peut se tromper d'une version, le formulaire non.

import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

const source = process.argv[2];
if (!source) {
  console.error("usage: node scripts/generate-n8n-credential-catalogue.mjs <relevé.json>");
  process.exit(1);
}

const types = JSON.parse(readFileSync(source, "utf8"));
if (!Array.isArray(types)) {
  console.error("Le relevé doit être un tableau de types de credentials.");
  process.exit(1);
}

const parNom = new Map(types.map((c) => [c.name, c]));

/**
 * ⚠️ `extends` est TRANSITIF, et c'est tout l'enjeu de cette fonction.
 * `gmailOAuth2` étend `googleOAuth2Api`, qui étend `oAuth2Api` — un contrôle à
 * un seul niveau n'en voit rien. Mesuré sur le relevé du 2026-08-31 : 75 types
 * étendent `oAuth1Api`/`oAuth2Api` directement, 183 en transitif.
 */
function fermeture(nom, vus = new Set()) {
  for (const parent of parNom.get(nom)?.extends ?? []) {
    if (vus.has(parent)) continue;
    vus.add(parent);
    fermeture(parent, vus);
  }
  return vus;
}

/**
 * Un type OAuth ne se déduit PAS de son nom.
 *
 * ⚠️ Mesuré sur le relevé du 2026-08-31, le filtre par nom se trompe dans les
 * DEUX sens :
 *   · `hubspotDeveloperApi` ne contient pas « oauth » et étend pourtant
 *     `oAuth2Api`. Physalis l'aurait écrit depuis le coffre — donc produit une
 *     credential non autorisée, et pire, écrasé à chaque rotation le jeton que
 *     N8N venait de rafraîchir ;
 *   · `crowdStrikeOAuth2Api` porte « OAuth2 » dans son nom et n'étend rien : ses
 *     champs sont `clientId`/`clientSecret`, des secrets statiques parfaitement
 *     écrivables. Le filtre par nom l'aurait exclu pour rien.
 */
function estOAuth(nom) {
  const f = fermeture(nom);
  return f.has("oAuth1Api") || f.has("oAuth2Api");
}

/**
 * Les types PROPOSÉS en premier — ceux qu'on range plausiblement dans un coffre.
 *
 * ⚠️ Ce n'est pas une liste blanche : les 300+ autres restent accessibles en
 * saisissant leur nom. C'est un choix d'ERGONOMIE — dérouler 332 entrées est
 * exactement ce qu'on cherchait à éviter — et il n'a aucun effet de sécurité.
 * La seule liste qui protège est celle des OAuth, calculée ci-dessus.
 */
const RECOMMANDES = [
  // Messagerie — le déclencheur qui manquait (T-0252) et son symétrique.
  "imap", "smtp",
  // Bases de données.
  "postgres", "mySql", "microsoftSql", "mongoDb", "redis",
  // Transfert et machines.
  "ftp", "sftp", "sshPassword", "sshPrivateKey", "s3",
  // Authentifications génériques : ce qui sert à joindre une API maison.
  "httpBasicAuth", "httpHeaderAuth", "httpQueryAuth", "httpCustomAuth", "httpDigestAuth",
  // Les services à jeton statique les plus courants.
  "slackApi", "telegramApi", "discordBotApi", "discordWebhookApi",
  "notionApi", "airtableTokenApi", "githubApi", "gitlabApi",
  "stripeApi", "sendGridApi", "mailgunApi", "twilioApi",
  "openAiApi", "anthropicApi", "cloudflareApi", "supabaseApi",
  // Le nôtre — le seul en régime A par construction.
  "physalisApi",
];

const connus = RECOMMANDES.filter((n) => parNom.has(n));
const manquants = RECOMMANDES.filter((n) => !parNom.has(n));

const lignes = types
  .map((c) => ({ nom: c.name, libelle: c.displayName ?? c.name, oauth: estOAuth(c.name) }))
  .sort((a, b) => a.libelle.localeCompare(b.libelle, "fr"));

const nbOAuth = lignes.filter((l) => l.oauth).length;

const out = `// GÉNÉRÉ — ne pas éditer à la main.
//
// Source   : ${basename(source)} (relevé de /types/credentials.json d'une instance N8N)
// Script   : scripts/generate-n8n-credential-catalogue.mjs
// Types    : ${lignes.length} dont ${nbOAuth} OAuth (donc hors régime B)
//
// ⚠️ Ce catalogue est un RELEVÉ DATÉ, pas un contrat. Il sert à proposer des
// types et à dire lesquels ne peuvent pas être écrits depuis le coffre. La forme
// des champs vient de \`GET /credentials/schema/{type}\` sur l'instance visée —
// notre liste peut se tromper d'une version de N8N, le formulaire non.

export type TypeCredentialN8n = {
  /** Le \`credentialTypeName\` attendu par l'API. */
  nom: string;
  /** Le libellé que montre l'éditeur de N8N — le seul que l'utilisateur connaît. */
  libelle: string;
  /**
   * ⚠️ OAuth1 ou OAuth2, calculé par la fermeture TRANSITIVE de \`extends\`, et
   * jamais d'après le nom. Un type OAuth ne s'écrit pas depuis le coffre :
   * le contenu utile est un jeton obtenu par un consentement, et N8N le
   * rafraîchit lui-même — le repousser écraserait le jeton rafraîchi.
   */
  oauth: boolean;
};

export const CATALOGUE_CREDENTIALS: readonly TypeCredentialN8n[] = [
${lignes.map((l) => `  { nom: ${JSON.stringify(l.nom)}, libelle: ${JSON.stringify(l.libelle)}, oauth: ${l.oauth} },`).join("\n")}
];

/** Index par nom, pour répondre « ce type est-il connu / OAuth ? ». */
export const CATALOGUE_PAR_NOM: ReadonlyMap<string, TypeCredentialN8n> = new Map(
  CATALOGUE_CREDENTIALS.map((t) => [t.nom, t]),
);

/**
 * Les types proposés en premier dans l'écran. Choix d'ERGONOMIE, pas de
 * sécurité : les autres restent accessibles en saisissant leur nom, et c'est
 * \`oauth\` qui protège, pas cette liste.
 */
export const TYPES_RECOMMANDES: readonly string[] = [
${connus.map((n) => `  ${JSON.stringify(n)},`).join("\n")}
];
`;

writeFileSync("lib/automation/credential-catalogue.ts", out);
console.log(`[catalogue] ${lignes.length} types écrits, dont ${nbOAuth} OAuth.`);
console.log(`[catalogue] ${connus.length} recommandés retenus.`);
if (manquants.length > 0) {
  console.log(`[catalogue] ⚠️ recommandés ABSENTS du relevé (à corriger) : ${manquants.join(", ")}`);
}
