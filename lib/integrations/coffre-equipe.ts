// Lecture du COFFRE D'ÉQUIPE par une intégration (nœud N8N, script, Make).
//
// Pourquoi une source distincte des secrets de projet : un secret de projet est
// scopé `projet × environnement` — il sert à DÉPLOYER une application. Une URL
// de webhook Slack, une clé d'API de veille, un jeton de service partagé
// n'appartiennent à aucun projet ni à aucun environnement : ce sont des secrets
// d'ÉQUIPE. Les forcer dans un projet oblige à en choisir un arbitrairement, et
// cette dette se paie à chaque automatisation suivante.
//
// ⚠️ **Le token machine est refusé ici, et c'est structurel.** Un MachineToken
// est verrouillé sur un projet ET un environnement ; une collection d'équipe
// n'a ni l'un ni l'autre. Lui ouvrir cette porte reviendrait à lui donner un
// périmètre qu'il ne sait pas exprimer — donc à ne plus pouvoir dire ce qu'il
// peut lire.
//
// ⚠️ L'accès d'un UserToken passe par `getAccessibleCollectionIds`, jamais par
// une requête maison : ce helper porte les cinq règles d'accès, dont le piège
// de `ProjectMember.hidden` (une BARRIÈRE d'accès, pas un réglage d'affichage).
// Un token agit AU NOM du user — il ne doit pas ouvrir ce que l'interface lui
// ferme.

import type { Role } from "@prisma/client";
import { decrypt } from "../crypto";
import { decodePayload, normalizeEntryType } from "../vault-entry-types";
import { getAccessibleCollectionIds } from "../vault-access";
import { withTenantSchema } from "../tenant";
import { orgTokenAllowsProject } from "../integration-token";
import type { IntegrationContext } from "../integration-token";

export type ItemCoffre = {
  key: string;
  /** La valeur unique de l'entrée, déchiffrée. Même nom que pour un secret de
   *  projet, pour que `{{ $json.value }}` marche à l'identique des deux côtés.
   *
   *  ⚠️ **Une entrée à PLUSIEURS valeurs rend une chaîne vide** (C-0047) : une
   *  LIST de six champs n'a pas de valeur unique, et en fabriquer une — le
   *  premier item, les items concaténés — donnerait à un workflow une valeur
   *  plausible et fausse. Le vide se voit ; une valeur inventée, non.
   *
   *  ⚠️ En revanche une LIST à **UN SEUL item** a bien une valeur unique, et la
   *  taire serait le symétrique du même défaut : le workflow reçoit `""` là où
   *  la donnée existe, et échoue sur une URL vide. C'est arrivé le 2026-09-01,
   *  sur une URL de webhook rangée en liste d'un élément. La règle est celle
   *  que le produit applique DÉJÀ aux conversions d'entrée (`singleValueOf`,
   *  coffre personnel) : la valeur unique d'une LIST, c'est son item quand il
   *  est seul. Une NOTE suit la même logique — son texte EST sa valeur. */
  value: string;
  url: string | null;
  username: string | null;
  tags: string[];
  /**
   * La forme de l'entrée : `LOGIN` | `SECRET` | `LIST` | `NOTE` (C-0047).
   *
   * ⚠️ **Champ AJOUTÉ, jamais substitué.** Ce que rend cette fonction est lu par
   * le nœud `n8n-nodes-physalis` PUBLIÉ, sur des workflows qui tournent chez des
   * clients. Une version du nœud qui ignore ce champ doit continuer de
   * fonctionner à l'identique — d'où l'ajout plutôt que le remaniement.
   */
  type: string;
  /**
   * Les items d'une entrée `LIST`, libellés compris. Absent pour les trois
   * autres formes — et absent, pas vide : `items: []` sur une LOGIN laisserait
   * croire à une liste qu'on n'aurait pas su lire.
   */
  items?: { label: string; value: string }[];
  /** Le texte d'une entrée `NOTE`. Absent pour les trois autres formes. */
  text?: string;

  /**
   * L'ancienneté et l'échéance de rotation — ce qui rend réalisables les
   * objectifs 18 et 19 de [T-0257], les deux derniers gabarits ★.
   *
   * ⚠️ **Le manque n'était PAS dans le nœud npm**, contrairement à ce que la
   * feuille de route annonçait (« que le nœud Physalis rende la date
   * d'expiration »). Le nœud relaie les items TELS QUELS : c'est cette réponse
   * qui ne portait pas l'information, alors que `TeamVaultEntry` la stocke
   * depuis la phase B de la rotation. Rien à publier sur npm pour les servir.
   *
   * ⚠️ **Champs AJOUTÉS, jamais substitués** — même règle que `type` au-dessus :
   * une version du nœud qui les ignore doit continuer de fonctionner à
   * l'identique, sur des workflows qui tournent chez des clients.
   *
   * ⚠️ **`null` et non « absent » quand la rotation n'est pas réglée.** Absent,
   * une expression n8n `$json.rotationNextAt` rendrait `undefined` et toute
   * comparaison serait fausse **en silence** — le gabarit d'alerte n'alerterait
   * jamais, sans se plaindre. `null` se teste ; l'absence se traverse.
   *
   * ⚠️ Ce sont des DATES, pas des secrets : les exposer n'élargit pas ce que
   * cette réponse divulgue — elle rend déjà la valeur déchiffrée.
   */
  rotationEnabled: boolean;
  /** ISO 8601, ou `null` si aucune rotation n'a encore eu lieu. */
  rotationLastAt: string | null;
  /** ISO 8601, ou `null` si la rotation n'est pas réglée sur cette entrée. */
  rotationNextAt: string | null;
  /** ISO 8601. Toujours présent — c'est l'ancienneté de dernier recours quand
   *  aucune rotation n'a été enregistrée. */
  updatedAt: string;
};

export type ResultatCoffre =
  | { kind: "ok"; items: ItemCoffre[]; organizationId: string | null; projectId: string | null }
  | { kind: "not_found" }
  | { kind: "forbidden"; raison: string };

/**
 * Lit les entrées d'une collection d'équipe, filtrées par tag et par nom.
 *
 * `collectionSlug` est le slug, unique par organisation OU par projet — la
 * résolution accepte les deux, puisqu'une collection peut être portée par l'un
 * ou par l'autre.
 */
export async function lireCoffreEquipe(
  ctx: IntegrationContext,
  params: { collection: string; tag?: string | null; key?: string | null },
): Promise<ResultatCoffre> {
  if (ctx.kind === "machine") {
    return {
      kind: "forbidden",
      raison:
        "Un token machine est verrouillé sur un projet et un environnement : il "
        + "ne peut pas désigner une collection d'équipe. Utilisez un token "
        + "utilisateur ou un token d'organisation.",
    };
  }

  // ⚠️ Les collections accessibles se calculent AVANT d'ouvrir le contexte
  // ci-dessous : `getAccessibleCollectionIds` ouvre le sien, et imbriquer deux
  // `withTenantSchema` ferait dépendre le `search_path` de l'ordre de sortie
  // des transactions. Trois contextes successifs coûtent trois allers-retours ;
  // un contexte imbriqué coûte un jour de débogage.
  let accessibles: string[] | null = null;
  if (ctx.kind === "user") {
    // Le rôle GLOBAL est lu en base et non supposé : `getAccessibleCollectionIds`
    // donne TOUTES les collections à un admin plateforme. Passer un rôle deviné
    // ouvrirait ou fermerait l'accès à côté de la vérité.
    const role = await withTenantSchema(ctx.tenantSlug, (tx) =>
      tx.user.findUnique({ where: { id: ctx.userId }, select: { role: true } }),
    );
    if (!role) return { kind: "forbidden", raison: "Compte introuvable." };
    accessibles = await getAccessibleCollectionIds(
      ctx.userId, role.role as Role, ctx.tenantSlug,
    );
  }

  return withTenantSchema(ctx.tenantSlug, async (tx) => {
    const collection = await tx.teamVaultCollection.findFirst({
      where: { slug: params.collection },
      select: { id: true, organizationId: true, projectId: true },
    });
    if (!collection) return { kind: "not_found" as const };

    if (ctx.kind === "user") {
      if (!accessibles!.includes(collection.id)) {
        return { kind: "forbidden" as const, raison: "Collection inaccessible à ce compte." };
      }
    } else {
      // Token d'organisation : la collection doit relever de SON organisation,
      // directement ou par le projet qui la porte — et ce projet doit être dans
      // la liste autorisée du token.
      if (collection.organizationId && collection.organizationId !== ctx.organizationId) {
        return { kind: "forbidden" as const, raison: "Collection hors de l'organisation du token." };
      }
      if (collection.projectId) {
        const projet = await tx.project.findUnique({
          where: { id: collection.projectId },
          select: { id: true, organizationId: true },
        });
        if (!projet || projet.organizationId !== ctx.organizationId) {
          return { kind: "forbidden" as const, raison: "Collection hors de l'organisation du token." };
        }
        if (!orgTokenAllowsProject(ctx, projet.id)) {
          return { kind: "forbidden" as const, raison: "Projet non autorisé pour ce token." };
        }
      }
    }

    const entrees = await tx.teamVaultEntry.findMany({
      where: {
        collectionId: collection.id,
        ...(params.tag ? { tags: { has: params.tag } } : {}),
        ...(params.key ? { name: params.key } : {}),
      },
      select: {
        name: true, url: true, username: true, tags: true,
        encryptedPassword: true, passwordIv: true, passwordTag: true,
        type: true, encryptedData: true, dataIv: true, dataTag: true,
        // L'ancienneté et l'échéance (cf. `ItemCoffre`) — déjà stockées depuis
        // la phase B de la rotation, jamais rendues jusqu'ici.
        rotationEnabled: true, rotationLastAt: true, rotationNextAt: true,
        updatedAt: true,
      },
    });

    const items: ItemCoffre[] = entrees.map((e) => {
      const type = normalizeEntryType(e.type);
      // ⚠️ Une entrée sans mot de passe rend une chaîne vide, PAS une erreur :
      // le coffre d'équipe porte aussi des notes et des identifiants sans
      // secret. Faire échouer tout l'appel pour l'une d'elles rendrait la
      // lecture d'une collection dépendante de son entrée la plus incomplète.
      const base: ItemCoffre = {
        key: e.name,
        rotationEnabled: e.rotationEnabled,
        // ⚠️ Sérialisées ICI et pas laissées au `JSON.stringify` de la réponse :
        // le contrat doit dire ce que le workflow reçoit, pas dépendre de qui
        // sérialise. Une `Date` traversant un autre chemin donnerait autre chose.
        rotationLastAt: e.rotationLastAt ? e.rotationLastAt.toISOString() : null,
        rotationNextAt: e.rotationNextAt ? e.rotationNextAt.toISOString() : null,
        updatedAt: e.updatedAt.toISOString(),
        value:
          e.encryptedPassword && e.passwordIv && e.passwordTag
            ? decrypt({ encryptedValue: e.encryptedPassword, iv: e.passwordIv, tag: e.passwordTag })
            : "",
        url: e.url,
        username: e.username,
        tags: e.tags,
        type,
      };

      // LOGIN et SECRET n'ont pas de charge utile : on sort AVANT de déchiffrer
      // quoi que ce soit d'autre, pour que leur chemin reste exactement celui
      // d'avant C-0047.
      if (type !== "LIST" && type !== "NOTE") return base;
      if (!e.encryptedData || !e.dataIv || !e.dataTag) return base;

      // ⚠️ `decodePayload` est TOLÉRANT par conception : un blob corrompu rend
      // une charge vide au lieu de faire échouer la lecture de toute la
      // collection. Même raison qu'au-dessus — une entrée abîmée ne doit pas
      // priver un workflow des dix autres.
      const charge = decodePayload(
        decrypt({ encryptedValue: e.encryptedData, iv: e.dataIv, tag: e.dataTag }),
      );
      if (type === "LIST") {
        const items = charge.items ?? [];
        // ⚠️ UN item = une valeur unique, sans ambiguïté possible. Deux ou plus :
        // aucune valeur ne se distingue, et en choisir une serait arbitraire.
        return { ...base, items, value: items.length === 1 ? items[0].value : base.value };
      }
      return { ...base, text: charge.text ?? "", value: charge.text ?? base.value };
    });

    return {
      kind: "ok" as const,
      items,
      organizationId: collection.organizationId,
      projectId: collection.projectId,
    };
  });
}
