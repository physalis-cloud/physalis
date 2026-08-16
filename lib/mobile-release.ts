// Chantier "Déploiement mobile" — Phase 3 : le registre de livraisons.
// Cf. documentation/plans/deploiement-mobile.md §4.2 / §5.3.
//
// « Quelle version est en revue, laquelle est live, qui l'a publiée, avec quel
// certificat » — la réponse vit aujourd'hui dans trois consoles et un canal
// Slack. Ce module la rassemble.
//
// ⚠️ Physalis ne détient PAS l'artefact (§3.2) : une `MobileRelease` est un
// SIGNALEMENT, pas un binaire. Elle ne prouve pas qu'un build existe, elle
// enregistre ce que Physalis a servi et ce que le pipeline a rapporté.
//
// Deux moments d'écriture, et c'est le point de conception :
//   1. `openRelease` — QUAND LE BUNDLE EST SERVI. Écrit par Physalis à partir
//      de ce qu'il a réellement remis (empreintes du matériel, numéro de build
//      consommé, identité OIDC du pipeline). Cette moitié-là ne peut pas mentir.
//   2. `recordReport` — quand le CI rapporte l'issue de son téléversement.
//      Déclarative par nature : le pipeline dit la piste et le statut.
// Mélanger les deux ferait passer du déclaratif pour du constaté.
//
// Partagé par la route SaaS et son jumeau self-host, comme lib/mobile-bundle.ts.

import type { Prisma } from "@prisma/client";

/** Sous-ensemble de Prisma nécessaire. Typage structurel volontairement lâche —
 *  même motif que `Db` dans lib/ci-connection.ts : la route SaaS passe un client
 *  tenant issu de `getTenantPrisma`, le jumeau self-host le client unique.
 *
 *  ⚠️ Notation MÉTHODE (`findFirst(args)`) et non propriété
 *  (`findFirst: (args) => …`) : sous `strictFunctionTypes`, une propriété de
 *  type fonction est comparée de façon CONTRAVARIANTE, et les signatures
 *  génériques de Prisma ne sont alors assignables à rien de plus large. Les
 *  méthodes, elles, restent bivariantes. C'est la seule raison de cette forme. */
type ReleaseDb = {
  mobileRelease: {
    findFirst(args: unknown): Promise<unknown>;
    create(args: unknown): Promise<unknown>;
    update(args: unknown): Promise<unknown>;
  };
};

/** Piste de publication. `pending` = le bundle est servi, le CI n'a pas encore
 *  dit où il téléverse — cf. le commentaire du champ dans le schéma. */
export const MOBILE_TRACKS = [
  "pending",
  // Google Play
  "internal",
  "alpha",
  "beta",
  "production",
  // Apple
  "testflight",
  "appstore",
] as const;

/**
 * États d'une livraison. `requested` est le seul que Physalis pose lui-même :
 * il signifie « matériel servi, on ne sait pas encore ce qu'il en est advenu ».
 * Un run de CI qui échoue APRÈS avoir pris le bundle laisse donc une ligne en
 * `requested` — ce n'est pas un bug, c'est l'information : quelqu'un a récupéré
 * du matériel de signature et n'a rien publié.
 */
export const MOBILE_RELEASE_STATUSES = [
  "requested",
  "uploaded",
  "processing",
  "in_review",
  "live",
  "halted",
  "rejected",
  "failed",
] as const;

export type MobileTrack = (typeof MOBILE_TRACKS)[number];
export type MobileReleaseStatus = (typeof MOBILE_RELEASE_STATUSES)[number];

export function isValidTrack(v: string): v is MobileTrack {
  return (MOBILE_TRACKS as readonly string[]).includes(v);
}

export function isValidReleaseStatus(v: string): v is MobileReleaseStatus {
  return (MOBILE_RELEASE_STATUSES as readonly string[]).includes(v);
}

/** Identité du pipeline, telle que `lib/oidc.ts` l'a DÉJÀ vérifiée. */
export type ReleaseCiIdentity = {
  provider: string | null;
  repo: string | null;
  ref: string | null;
};

/**
 * Ouvre une livraison au moment où le bundle part vers le CI.
 *
 * ⚠️ **Best-effort assumé** : ne lève jamais. Le registre est de l'observabilité,
 * le bundle est le chemin critique. Un pipeline ne doit pas échouer parce que
 * Physalis n'a pas su écrire une ligne d'historique — c'est le même arbitrage
 * que le miroir `admin.policies` et que le numéro de build (§4.5).
 *
 * @returns l'id de la ligne, ou null si l'écriture a échoué.
 */
export async function openRelease(
  db: ReleaseDb,
  input: {
    appId: string;
    buildNumber: number | string;
    versionName: string | null;
    /** { kind: sha256 } du matériel réellement servi. */
    credentialsSha: Record<string, string>;
    ci: ReleaseCiIdentity;
  },
): Promise<string | null> {
  try {
    const row = (await db.mobileRelease.create({
      data: {
        appId: input.appId,
        track: "pending",
        buildNumber: String(input.buildNumber),
        versionName: input.versionName,
        status: "requested",
        statusSource: "reported",
        credentialsSha: input.credentialsSha as Prisma.InputJsonValue,
        ciProvider: input.ci.provider,
        ciRepo: input.ci.repo,
        ciRef: input.ci.ref,
      },
      select: { id: true },
    })) as { id: string };
    return row.id;
  } catch (err) {
    console.error("[mobile-release] openRelease a échoué (non bloquant):", err);
    return null;
  }
}

export type ReportOutcome = {
  releaseId: string;
  /** true si le rapport a rejoint la ligne ouverte au moment du bundle — donc
   *  si la corrélation matériel↔version est établie. false = ligne créée de
   *  toutes pièces par le rapport (téléversement hors Physalis, ou bundle
   *  d'une autre exécution). L'UI le distingue : une livraison sans matériel
   *  corrélé ne dit pas ce qui l'a signée. */
  correlated: boolean;
};

/**
 * Enregistre ce que le pipeline rapporte après son téléversement.
 *
 * Rejoint en priorité la ligne `pending` ouverte pour ce numéro de build : c'est
 * elle qui porte les empreintes du matériel servi. À défaut, met à jour une
 * ligne déjà rapportée sur la même piste (un CI peut rapporter plusieurs fois :
 * `uploaded` puis `live`). En dernier recours, crée la ligne.
 *
 * Contrairement à `openRelease`, celle-ci LÈVE : l'appelant est une route de
 * rapport, dont c'est le seul travail — un échec silencieux y serait un mensonge.
 */
export async function recordReport(
  db: ReleaseDb,
  input: {
    appId: string;
    buildNumber: string;
    track: MobileTrack;
    status: MobileReleaseStatus;
    versionName?: string | null;
    statusDetail?: string | null;
    ci: ReleaseCiIdentity;
  },
): Promise<ReportOutcome> {
  const now = new Date();

  // 1. la ligne ouverte au moment du bundle (celle qui porte les empreintes).
  const pending = (await db.mobileRelease.findFirst({
    where: { appId: input.appId, buildNumber: input.buildNumber, track: "pending" },
    orderBy: { requestedAt: "desc" },
    select: { id: true },
  })) as { id: string } | null;

  if (pending) {
    await db.mobileRelease.update({
      where: { id: pending.id },
      data: {
        track: input.track,
        status: input.status,
        statusDetail: input.statusDetail ?? null,
        reportedAt: now,
        ...(input.versionName ? { versionName: input.versionName } : {}),
      },
    });
    return { releaseId: pending.id, correlated: true };
  }

  // 2. une ligne déjà rapportée sur cette piste — le CI affine son statut.
  const existing = (await db.mobileRelease.findFirst({
    where: {
      appId: input.appId,
      buildNumber: input.buildNumber,
      track: input.track,
    },
    select: { id: true, credentialsSha: true },
  })) as { id: string; credentialsSha: unknown } | null;

  if (existing) {
    await db.mobileRelease.update({
      where: { id: existing.id },
      data: {
        status: input.status,
        statusDetail: input.statusDetail ?? null,
        reportedAt: now,
        ...(input.versionName ? { versionName: input.versionName } : {}),
      },
    });
    return {
      releaseId: existing.id,
      correlated: hasCredentials(existing.credentialsSha),
    };
  }

  // 3. rien à rejoindre : téléversement dont Physalis n'a pas servi le matériel.
  //    On l'enregistre quand même — un historique qui tait ce qu'il n'a pas
  //    orchestré serait trompeur — mais sans empreintes, donc non corrélé.
  const created = (await db.mobileRelease.create({
    data: {
      appId: input.appId,
      track: input.track,
      buildNumber: input.buildNumber,
      versionName: input.versionName ?? null,
      status: input.status,
      statusSource: "reported",
      statusDetail: input.statusDetail ?? null,
      credentialsSha: {} as Prisma.InputJsonValue,
      ciProvider: input.ci.provider,
      ciRepo: input.ci.repo,
      ciRef: input.ci.ref,
      reportedAt: now,
    },
    select: { id: true },
  })) as { id: string };

  return { releaseId: created.id, correlated: false };
}

function hasCredentials(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.keys(value as Record<string, unknown>).length > 0
  );
}
