// Phase 10 — Versioning des secrets (Secret + OrgSecret).
//
// Spec : documentation/plans/done/versionning-secrets.md
//
// Helpers `createSecretVersion` et `createOrgSecretVersion` à appeler
// dans une transaction Prisma juste avant un UPDATE de la valeur du
// secret parent. Le helper :
//   1. Calcule le prochain numéro de version (MAX + 1)
//   2. INSERT la row avec retry sur conflit unique (race conditions)
//   3. Cleanup les versions au-delà de la rétention (50 max)
//
// Pas appelé pour les CREATE (pas d'historique sur la valeur initiale).

import { Prisma } from "@prisma/client";

const MAX_VERSIONS = 50;
const MAX_RETRIES = 3;

/**
 * Type du `tx` passé par `withTenantSchema(slug, async (tx) => ...)`
 * (`lib/tenant.ts`), c.-à-d. une transaction ouverte sur le PrismaClient
 * du tenant. Ce type était auparavant inféré depuis
 * `prisma.$transaction` du client étendu — lequel n'ouvrait aucune
 * transaction réelle (F5.1) et n'existe plus dans son type.
 */
export type TenantTx = Prisma.TransactionClient;

export interface CreateSecretVersionOpts {
  /** Identifiant du Secret parent. */
  secretId: string;
  /** Ancienne valeur chiffrée (à snapshoter avant l'UPDATE). */
  encryptedValue: string;
  iv: string;
  tag: string;
  /** User à l'origine du changement (null = system / pas connu). */
  createdById: string | null;
  /** Transaction Prisma — le caller wrap dans `prisma.$transaction(...)`. */
  tx: TenantTx;
}

/**
 * Crée une version dans `SecretVersion` puis nettoie le surplus.
 * À appeler dans une transaction, AVANT l'UPDATE du Secret parent.
 *
 * @returns Le numéro de version créé.
 * @throws Si `MAX_RETRIES` (3) tentatives échouent toutes sur le
 *         conflit unique `(secretId, version)` — typiquement uniquement
 *         sous très forte concurrence sur le même secret.
 */
export async function createSecretVersion(
  opts: CreateSecretVersionOpts,
): Promise<{ version: number }> {
  return insertWithRetry(
    opts.tx,
    "secretVersion",
    "secretId",
    opts.secretId,
    {
      encryptedValue: opts.encryptedValue,
      iv: opts.iv,
      tag: opts.tag,
      createdById: opts.createdById,
    },
  );
}

export interface CreateOrgSecretVersionOpts {
  orgSecretId: string;
  encryptedValue: string;
  iv: string;
  tag: string;
  createdById: string | null;
  tx: TenantTx;
}

export async function createOrgSecretVersion(
  opts: CreateOrgSecretVersionOpts,
): Promise<{ version: number }> {
  return insertWithRetry(
    opts.tx,
    "orgSecretVersion",
    "orgSecretId",
    opts.orgSecretId,
    {
      encryptedValue: opts.encryptedValue,
      iv: opts.iv,
      tag: opts.tag,
      createdById: opts.createdById,
    },
  );
}

// ─── Implémentation interne ──────────────────────────────────────────

type ModelName = "secretVersion" | "orgSecretVersion";
type ParentField = "secretId" | "orgSecretId";

interface VersionData {
  encryptedValue: string;
  iv: string;
  tag: string;
  createdById: string | null;
}

/**
 * Logique commune Secret/OrgSecret. Le `tx` est typé `any` localement
 * car les modèles `secretVersion`/`orgSecretVersion` sont distincts
 * mais ont la même shape — Prisma ne permet pas de paramétrer le
 * nom du modèle de façon générique. On profite du fait que les deux
 * partagent exactement la même API.
 */
async function insertWithRetry(
  tx: TenantTx,
  modelName: ModelName,
  parentField: ParentField,
  parentId: string,
  data: VersionData,
): Promise<{ version: number }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const model = (tx as any)[modelName];
  const whereClause = { [parentField]: parentId };

  // ⚠️ Sérialise les créations de version concurrentes sur le MÊME parent.
  //
  // Nécessaire depuis F5.1 : tant que `prisma.$transaction` était inerte, le
  // `catch (P2002) → continue` ci-dessous rattrapait la course sur MAX+1. Dans
  // une VRAIE transaction, il ne le peut plus — en PostgreSQL, la moindre
  // erreur avorte la transaction, et la tentative suivante échouerait en 25P02
  // (« current transaction is aborted ») au lieu de réessayer. Le retry n'est
  // donc plus le garde-fou : ce verrou l'est. Il est pris AVANT la lecture du
  // MAX, et relâché au commit/rollback (`_xact_`) — pas de fuite possible.
  //
  // Deux clés int4 plutôt qu'une bigint : signature exacte, aucune conversion
  // implicite, et le nom de modèle évite qu'un `Secret` et un `OrgSecret` de
  // même id se bloquent l'un l'autre. L'espace de verrous consultatifs est
  // global à la base : le nom de modèle est ce qui le partitionne ici.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${modelName}), hashtext(${parentId}))`;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    // 1. Récupère le numéro de version actuel max (ou 0 si aucun).
    const aggregate = await model.aggregate({
      where: whereClause,
      _max: { version: true },
    });
    const nextVersion = (aggregate._max.version ?? 0) + 1;

    // 2. INSERT — peut échouer sur conflit unique en cas de course.
    try {
      await model.create({
        data: { ...whereClause, ...data, version: nextVersion },
      });
    } catch (err) {
      // P2002 = unique constraint violation (deux UPDATE concurrents
      // ont calculé le même nextVersion). Le verrou consultatif ci-dessus
      // rend ce cas inatteignable pour les écritures qui passent par ici ;
      // le retry ne subsiste que comme filet pour un écrivain qui ne le
      // prendrait pas. Dans une transaction déjà avortée il ne réussira
      // pas — mais il échouera bruyamment, sans écriture partielle.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002" &&
        attempt < MAX_RETRIES - 1
      ) {
        continue;
      }
      throw err;
    }

    // 3. Cleanup : garder uniquement les MAX_VERSIONS plus récentes.
    //    DELETE en utilisant un sous-select pour cibler les plus anciennes.
    const allVersions = await model.findMany({
      where: whereClause,
      orderBy: { version: "desc" },
      select: { id: true },
    });
    if (allVersions.length > MAX_VERSIONS) {
      const idsToDelete = allVersions
        .slice(MAX_VERSIONS)
        .map((v: { id: string }) => v.id);
      await model.deleteMany({ where: { id: { in: idsToDelete } } });
    }

    return { version: nextVersion };
  }

  throw new Error(
    `createVersion: ${MAX_RETRIES} retries exceeded on ${modelName}(${parentId})`,
  );
}
