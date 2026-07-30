// Règles PURES de la fenêtre de récupération « suppression de compte ».
//
// Volontairement sans dépendance (ni Prisma, ni Stripe) : ces règles doivent
// être testables seules et lisibles d'un coup d'œil, parce qu'une erreur ici
// se traduit soit par une suppression qui n'arrive jamais, soit par une
// destruction prématurée.
//
// Le flux complet vit dans :
//   - app/api/account/delete/route.ts      (demande → PENDING_DELETION + purgeAt)
//   - app/api/account/reactivate/route.ts  (annulation pendant la fenêtre)
//   - lib/account-purge.ts                 (hard-delete à l'échéance)

/** Fenêtre de récupération avant purge définitive (règle métier). */
export const RECOVERY_WINDOW_DAYS = 30;

/**
 * Ce que `customer.subscription.deleted` doit faire du statut du client.
 *
 * `suspend` est le comportement normal (fin d'abonnement subie → SUSPENDED,
 * réversible). Les deux autres valeurs sont des cas où le statut courant a
 * été posé DÉLIBÉRÉMENT par l'app et ne doit pas être écrasé par la
 * confirmation tardive de Stripe.
 */
export type SubscriptionDeletedOutcome =
  | "keep_deletion_pending"
  | "keep_free"
  | "suspend";

/**
 * Décide du sort du statut client à la réception de
 * `customer.subscription.deleted`.
 *
 * ⚠️ `keep_deletion_pending` corrige un défaut réel : `/api/account/delete`
 * annule l'abonnement Stripe AVANT d'écrire `PENDING_DELETION`. Le webhook
 * arrive quelques secondes plus tard et, sans ce garde, repassait le client en
 * `SUSPENDED`. Conséquences en chaîne, toutes silencieuses :
 *   - `runAccountPurge` filtre sur `status = PENDING_DELETION` → le compte
 *     n'était JAMAIS purgé (demande de suppression avalée, données conservées
 *     indéfiniment — problème RGPD, pas seulement un bug d'affichage) ;
 *   - la bannière du dashboard disparaissait ;
 *   - `/api/account/reactivate` répondait 409 « aucune suppression en cours ».
 * Le défaut ne se manifestait QUE pour un compte payant : un compte FREE n'a
 * pas d'abonnement, donc pas de webhook.
 *
 * Le garde s'appuie sur `deletionRequestedAt` plutôt que sur
 * `status === "PENDING_DELETION"` : c'est le marqueur d'intention, il survit à
 * un statut déjà écrasé par un événement antérieur, et il est remis à `null`
 * par la réactivation.
 */
export function subscriptionDeletedOutcome(client: {
  plan: string | null;
  deletionRequestedAt: Date | null;
}): SubscriptionDeletedOutcome {
  // Testé en premier : une suppression demandée prime sur tout le reste, et
  // rend la note d'audit exacte quand le client est FREE *et* en suppression.
  if (client.deletionRequestedAt !== null) return "keep_deletion_pending";

  // Downgrade volontaire déjà traité par /api/billing/downgrade-to-free
  // (status=ACTIVE + plan=FREE) : le cancel Stripe n'en est que la
  // confirmation tardive.
  if (client.plan === "FREE") return "keep_free";

  return "suspend";
}

// ─── Verrou d'espace pendant la fenêtre ──────────────────────────────────────

/**
 * Dans quel état se trouve l'espace de l'utilisateur courant.
 *
 * - `locked`    : SON compte est en cours de suppression. Il a demandé à
 *                 partir → tout l'espace est verrouillé derrière un écran non
 *                 fermable, seule la récupération de ses données reste possible.
 * - `read_only` : le TENANT est en cours de suppression, mais pas lui. Choix
 *                 délibéré de ne PAS verrouiller : un blocage dur arrêterait
 *                 l'entreprise pendant toute la fenêtre, et si l'owner se
 *                 ravise au jour 20 cette coupure n'aura servi à rien. Bandeau
 *                 permanent + export, verrouillage dur seulement à la purge.
 * - `none`      : rien en cours.
 *
 * Le cas de sa propre suppression prime : un membre qui a demandé à partir
 * reste verrouillé même si le tenant ferme aussi (la règle « la suppression
 * tenant absorbe les suppressions individuelles » s'applique à la PURGE, pas à
 * l'affichage — lui a bien demandé à partir, son espace reste verrouillé).
 */
export type AccountLockState = "locked" | "read_only" | "none";

export function accountLockState(input: {
  userDeletionRequestedAt: Date | null;
  tenantStatus: string | null;
}): AccountLockState {
  if (input.userDeletionRequestedAt !== null) return "locked";
  if (input.tenantStatus === "PENDING_DELETION") return "read_only";
  return "none";
}

/**
 * Jours entiers restants avant la purge, borné à 0 (jamais négatif : une purge
 * en retard doit afficher « aujourd'hui », pas « il y a -3 jours »).
 * `null` si aucune échéance connue.
 *
 * Arrondi au SUPÉRIEUR : tant qu'il reste la moindre fraction de journée, on
 * annonce un jour. Annoncer « 0 jour » à quelqu'un qui a encore 6 heures pour
 * récupérer ses secrets serait le pire des arrondis.
 */
export function daysUntilPurge(
  purgeAt: Date | null,
  now: Date = new Date(),
): number | null {
  if (!purgeAt) return null;
  const ms = purgeAt.getTime() - now.getTime();
  if (ms <= 0) return 0;
  return Math.ceil(ms / (24 * 60 * 60 * 1000));
}

/**
 * Un export ne « compte » (compteur owner, règle du plancher) que s'il est
 * POSTÉRIEUR à la demande de suppression : un export d'il y a six mois ne dit
 * rien de la volonté de la personne de récupérer ses données maintenant.
 */
// ─── Plancher avant purge immédiate du tenant (owner) ────────────────────────

/**
 * Délai minimal, en jours, avant que l'owner puisse purger le tenant sans
 * attendre la fenêtre complète. Il ne protège pas l'owner (qui a décidé) mais
 * les AUTRES membres, dont la purge détruit aussi les données.
 */
export const IMMEDIATE_PURGE_FLOOR_DAYS = 7;

export type TenantPurgeEligibility = {
  allowed: boolean;
  /** Membres ayant récupéré leurs données depuis la demande. */
  exported: number;
  total: number;
  /** Jours restants avant que le plancher ne s'ouvre de lui-même. */
  floorDaysRemaining: number;
};

/**
 * L'owner peut-il purger MAINTENANT ?
 *
 * Règle tranchée : **dès que tous les membres ont exporté leurs données OU que
 * le plancher est écoulé** — le premier des deux. Elle découple le droit de
 * l'owner à résilier vite du droit des membres à récupérer leurs données :
 * une équipe réactive laisse partir l'owner dès le lendemain, un salarié
 * inactif ne prend pas le client en otage au-delà du plancher, et personne
 * n'est détruit sans avoir eu au moins une occasion de se connecter.
 *
 * L'owner lui-même compte dans le total : il est un membre comme un autre du
 * point de vue de la récupération de données, et son propre export n'a pas à
 * être supposé.
 */
export function tenantPurgeEligibility(input: {
  deletionRequestedAt: Date | null;
  members: { dataExportedAt: Date | null }[];
  now?: Date;
}): TenantPurgeEligibility {
  const now = input.now ?? new Date();
  const requestedAt = input.deletionRequestedAt;
  const total = input.members.length;
  const exported = requestedAt
    ? input.members.filter((m) =>
        hasExportedSinceRequest({
          dataExportedAt: m.dataExportedAt,
          deletionRequestedAt: requestedAt,
        }),
      ).length
    : 0;

  if (!requestedAt) {
    return { allowed: false, exported, total, floorDaysRemaining: 0 };
  }

  const floorAt = new Date(
    requestedAt.getTime() + IMMEDIATE_PURGE_FLOOR_DAYS * 24 * 60 * 60 * 1000,
  );
  const floorDaysRemaining = daysUntilPurge(floorAt, now) ?? 0;
  const everyoneExported = total > 0 && exported === total;

  return {
    allowed: everyoneExported || floorDaysRemaining === 0,
    exported,
    total,
    floorDaysRemaining,
  };
}

// ─── Blocage « dernier OWNER » ───────────────────────────────────────────────

/**
 * Organisations que le départ de cet utilisateur laisserait SANS propriétaire.
 *
 * Même sémantique que la garde déjà en place sur le changement de rôle
 * (`app/api/orgs/[slug]/members/[userId]/route.ts` : `ownerCount <= 1` → 409) :
 * une org doit toujours conserver au moins un OWNER. Ici la règle porte sur
 * TOUTES les orgs dont l'utilisateur est OWNER, pas seulement la principale —
 * partir en orphelinant une org secondaire est le même défaut.
 *
 * Retourne la liste (vide = rien ne bloque) pour que l'UI puisse NOMMER les
 * organisations concernées dans la modale de confirmation, au lieu d'échouer
 * sur un message d'erreur générique après coup.
 */
export function orgsLeftWithoutOwner(
  ownedOrgs: { id: string; name: string; ownerCount: number }[],
): { id: string; name: string }[] {
  return ownedOrgs
    .filter((o) => o.ownerCount <= 1)
    .map(({ id, name }) => ({ id, name }));
}

export function hasExportedSinceRequest(user: {
  dataExportedAt: Date | null;
  deletionRequestedAt: Date | null;
}): boolean {
  if (!user.dataExportedAt) return false;
  if (!user.deletionRequestedAt) return true;
  return user.dataExportedAt.getTime() >= user.deletionRequestedAt.getTime();
}
