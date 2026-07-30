// §4 — « Fermer le générateur », volet statique.
//
// Les règles d'accès aux projets sont centralisées dans lib/project-access.ts.
// Ce test interdit de les RE-DÉRIVER ailleurs : tout site qui lit la table
// `ProjectMember` ou qui écrit le prédicat de visibilité à la main doit figurer
// dans une allowlist AVEC SA RAISON.
//
// ── Pourquoi cibler la LECTURE DE LA TABLE, et pas le mot `hidden` ──
// Grepper `hidden` ne trouve que les sites qui y ont PENSÉ. Or la famille de
// bugs, c'est précisément les sites qui l'ont OUBLIÉ (§2.8, §2.16…). Le seul
// signal fiable est donc « ce code lit ProjectMember », indépendamment de ce
// qu'il en fait.
//
// ── Pourquoi un test et pas une règle de lint ──
// La moitié des sites fautifs vivent DANS `lib/`, qu'une règle du type
// « interdit hors lib/ » ne couvrirait pas. Le dépôt a déjà ce motif et il est
// accepté : tests/lib/next-public-audit.test.ts, secrets-no-leak-static.test.ts.

import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "../..");

function grepCode(pattern: string): string[] {
  try {
    const out = execSync(
      `grep -rEn ${JSON.stringify(pattern)} app/ lib/ components/ \
        --include='*.ts' --include='*.tsx'`,
      { cwd: REPO_ROOT, encoding: "utf8" },
    );
    return out
      .split("\n")
      .filter(Boolean)
      .map((l) => l.replace(REPO_ROOT + "/", "").replace(/^\.\//, ""));
  } catch {
    return []; // grep sort 1 quand il ne trouve rien
  }
}

const fileOf = (hit: string) => hit.split(":")[0]!;

/**
 * Sites autorisés à lire `ProjectMember` directement.
 *
 * TROIS catégories, à ne surtout pas confondre :
 *
 *   CRUD                  — gèrent la table elle-même. Légitime et définitif.
 *
 *   RESTRICTION DÉLIBÉRÉE — appliquent une règle PLUS STRICTE que les 6 règles,
 *                           volontairement, sur des surfaces à haut risque
 *                           (matériel déchiffré, émission de jetons). Les
 *                           « nettoyer » vers effectiveProjectRole ÉLARGIRAIT
 *                           l'accès : c'est une régression de sécurité.
 *                           NE PAS MIGRER.
 *
 *   À MIGRER              — re-dérivent réellement les 6 règles. Dette connue
 *                           et suivie (§4). Retirer l'entrée en migrant le
 *                           site ; ne JAMAIS en ajouter une neuve.
 *
 * La distinction n'est pas cosmétique : une première rédaction de cette
 * allowlist avait classé 6 sites « À MIGRER » sur la seule foi du grep, sans
 * lire leur intention. Les migrer aurait ouvert des accès.
 */
const ALLOWED_TABLE_READS: Record<string, string> = {
  // ── CRUD : ces routes GÈRENT la table. Légitime et définitif. ──
  // NB : lib/project-access.ts n'apparaît PAS ici — il ne lit jamais la table,
  // il ne fait que produire des clauses. Le test anti-entrée-morte l'a signalé.
  "app/api/projects/[slug]/members/route.ts":
    "CRUD — listing des membres d'un projet (la table EST la ressource)",
  "app/api/projects/[slug]/members/[userId]/route.ts":
    "CRUD — création / modification / suppression d'un membership",
  "app/api/orgs/[slug]/members/[userId]/route.ts":
    "CRUD — cascade au retrait d'un membre d'org (cf. §2.7)",
  "app/api/orgs/[slug]/members/[userId]/project-access/route.ts":
    "CRUD — pose EN BLOC les ProjectMember explicites non masqués d'un membre " +
    "(modale « Droits d'accès », #2). Réservé OWNER/ADMIN. Ne crée jamais de " +
    "barrière ni ne décide d'accès : il applique la sélection d'un admin, " +
    "bornée aux projets de l'org ; les rôles implicites passent toujours par " +
    "effectiveProjectRole ailleurs.",
  "lib/invitation-project-access.ts":
    "CRUD — crée les ProjectMember pré-attribués à une invitation, appliqués " +
    "à l'acceptation (#2). N'a pas d'accès à décider : le rôle vient de " +
    "l'invitation validée par un OWNER/ADMIN, et seuls les projets de l'org " +
    "sont retenus.",

  // ── RESTRICTION DÉLIBÉRÉE : NE PAS MIGRER. ──
  // Ces sites exigent une ligne ProjectMember EXPLICITE non masquée, SANS le
  // repli EDITOR implicite du DEV ni le OWNER de l'OrgADMIN. C'est plus strict
  // que les 6 règles, À DESSEIN : ce sont les surfaces qui rendent du matériel
  // DÉCHIFFRÉ ou qui émettent des jetons. Les passer à effectiveProjectRole
  // ÉLARGIRAIT l'accès — régression de sécurité, pas nettoyage.
  "app/api/me/export/route.ts":
    "RESTRICTION DÉLIBÉRÉE — export RGPD, seul endpoint qui déchiffre par " +
    "conception. Limité aux memberships explicites.",
  "app/api/plugin/match/route.ts":
    "RESTRICTION DÉLIBÉRÉE — l'extension autofille des credentials déchiffrés " +
    "sur simple match de domaine, sans action de l'utilisateur.",
  "app/api/orgs/[slug]/org-tokens/route.ts":
    "RESTRICTION DÉLIBÉRÉE — empêche un DEV d'émettre un token vers un projet " +
    "que l'UI lui ferme, puis d'en lire les secrets via integrations/credentials.",
  "app/api/orgs/[slug]/org-tokens/[id]/route.ts":
    "RESTRICTION DÉLIBÉRÉE — idem, portée projet d'un token DEV (cf. §2.19).",
  "app/api/integrations/credentials/route.ts":
    "RESTRICTION DÉLIBÉRÉE — un UserToken agit au nom du porteur et ne doit " +
    "pas ouvrir ce que l'UI lui ferme.",
  "app/api/integrations/tags/route.ts":
    "RESTRICTION DÉLIBÉRÉE — idem integrations/credentials.",
  "app/api/integrations/projects/route.ts":
    "RESTRICTION DÉLIBÉRÉE — un UserToken ne liste pas les projets masqués " +
    "pour son porteur.",

  // ── LECTURE LÉGITIME qui ALIMENTE la source unique ──
  // Ces sites lisent la table pour PASSER la ligne à effectiveProjectRole /
  // accessibleProjectsWhere — ils ne re-dérivent plus les 6 règles. C'est le
  // motif correct (requireProjectMember fait pareil). Migrés dans la passe de
  // clôture §4 (2026-07-20) : plus AUCUNE entrée « À MIGRER » — le générateur
  // est fermé.
  "app/api/vault/destinations/route.ts":
    "lit les lignes ProjectMember explicites pour les passer à " +
    "effectiveProjectRole (source unique) — ne re-dérive plus (§4 clos).",
  "lib/vault-access.ts":
    "lit les ProjectMember explicites non masqués (branche 3 du listing de " +
    "collections) ; la visibilité héritée passe par accessibleProjectsWhere (§4 clos).",
};

/**
 * Sites autorisés à écrire le prédicat de visibilité à la main
 * (`members: { some|none: { userId … } }`).
 */
const ALLOWED_VISIBILITY_PREDICATE: Record<string, string> = {
  "lib/project-access.ts": "la source unique",
  "app/api/orgs/[slug]/projects/route.ts":
    "DIVERGENCE VOULUE ET DOCUMENTÉE — restreint aux membres EXPLICITES pour " +
    "coller à validateDevTokenCreation (un DEV ne peut pas déléguer un projet " +
    "dont il n'est pas membre). L'élargir à accessibleProjectsWhere ferait " +
    "proposer par la liste ce que le POST rejette. NE PAS MIGRER.",
  "app/api/secret-requests/route.ts":
    "RESTRICTION DÉLIBÉRÉE — le GET est passé à accessibleProjectsWhere (§2.16b) ; " +
    "le prédicat restant est le POINT-CHECK du POST, qui restreint la création " +
    "d'une demande à un projet non masqué pour l'auteur. NE PAS élargir.",
  "app/api/vault/org/[orgSlug]/collections/route.ts":
    "PAS UN PRÉDICAT PROJET — `members` porte ici sur TeamVaultCollection.members " +
    "(appartenance COFFRE), pas ProjectMember. Faux positif du grep générique.",
};

describe("Static analysis — règles d'accès projet non re-dérivées (§4)", () => {
  it("aucune lecture de ProjectMember hors des sites autorisés", () => {
    const hits = grepCode("(prisma|tx)\\.projectMember\\.");
    const offenders = hits.filter((h) => !(fileOf(h) in ALLOWED_TABLE_READS));

    expect(
      offenders,
      "Nouveau site lisant ProjectMember. Utiliser lib/project-access.ts " +
        "(effectiveProjectRole / accessibleProjectsWhere / " +
        "filterAccessibleProjects) plutôt que de re-dériver les règles. " +
        "Si le site gère VRAIMENT la table (CRUD), l'ajouter à " +
        "ALLOWED_TABLE_READS avec sa raison.",
    ).toEqual([]);
  });

  it("aucun prédicat de visibilité écrit à la main hors des sites autorisés", () => {
    const hits = grepCode("members: \\{ *(some|none): \\{ *userId");
    const offenders = hits.filter(
      (h) => !(fileOf(h) in ALLOWED_VISIBILITY_PREDICATE),
    );

    expect(
      offenders,
      "Nouveau `members: { some|none: { userId … } }` écrit à la main. " +
        "Passer par accessibleProjectsWhere(). C'est exactement le motif qui a " +
        "produit 4 listings avec 4 filtres différents, aucun conforme.",
    ).toEqual([]);
  });

  // Une allowlist qui pourrit est pire que pas d'allowlist : elle donne
  // l'illusion d'un inventaire à jour. Ces deux tests la gardent vivante.
  it("l'allowlist ne contient pas d'entrée morte", () => {
    const filesWithReads = new Set(
      grepCode("(prisma|tx)\\.projectMember\\.").map(fileOf),
    );
    const dead = Object.keys(ALLOWED_TABLE_READS).filter(
      (f) => !filesWithReads.has(f),
    );
    expect(
      dead,
      "Entrées d'allowlist devenues inutiles (site migré ou supprimé) : " +
        "les retirer, c'est la trace du progrès de §4.",
    ).toEqual([]);
  });

  it("§4 est CLOS : plus aucune dette « À MIGRER » dans les allowlists", () => {
    // Le compteur devait DESCENDRE au fil de la migration ; il est à 0 depuis la
    // passe de clôture (2026-07-20). Le verrou est désormais à zéro : réintroduire
    // un site qui re-dérive les règles (classé « À MIGRER ») fait échouer ce test.
    const toMigrate = [
      ...Object.values(ALLOWED_TABLE_READS),
      ...Object.values(ALLOWED_VISIBILITY_PREDICATE),
    ].filter((r) => r.startsWith("À MIGRER"));
    expect(toMigrate).toEqual([]);
  });
});
