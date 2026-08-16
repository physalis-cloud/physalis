// Chantier "Déploiement mobile" — Phase 1 (socle credentials).
//
// Versioning de MobileCredential — calque exact de lib/versioning.ts
// (createSecretVersion). Voir ce fichier pour le détail du verrou
// consultatif (nécessaire depuis F5.1, cf. commentaire insertWithRetry) ;
// non dupliqué ici pour éviter que les deux dérivent en expliquant la même
// chose deux fois.

import { Prisma } from "@prisma/client";
import type { TenantTx } from "./versioning";

const MAX_VERSIONS = 50;
const MAX_RETRIES = 3;

export interface CreateMobileCredentialVersionOpts {
  /** Identifiant du MobileCredential parent. */
  credentialId: string;
  /** Ancienne valeur chiffrée (à snapshoter avant le remplacement). */
  encryptedValue: string;
  iv: string;
  tag: string;
  createdById: string | null;
  tx: TenantTx;
}

/**
 * Crée une version dans `MobileCredentialVersion` puis nettoie le surplus.
 * À appeler dans une transaction (withTenantSchema), AVANT le remplacement
 * du MobileCredential parent — jamais au CREATE initial (pas d'historique
 * sur la valeur d'origine).
 */
export async function createMobileCredentialVersion(
  opts: CreateMobileCredentialVersionOpts,
): Promise<{ version: number }> {
  const { tx, credentialId, ...data } = opts;
  const whereClause = { credentialId };

  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('mobileCredentialVersion'), hashtext(${credentialId}))`;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const aggregate = await tx.mobileCredentialVersion.aggregate({
      where: whereClause,
      _max: { version: true },
    });
    const nextVersion = (aggregate._max.version ?? 0) + 1;

    try {
      await tx.mobileCredentialVersion.create({
        data: { ...whereClause, ...data, version: nextVersion },
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002" &&
        attempt < MAX_RETRIES - 1
      ) {
        continue;
      }
      throw err;
    }

    const allVersions = await tx.mobileCredentialVersion.findMany({
      where: whereClause,
      orderBy: { version: "desc" },
      select: { id: true },
    });
    if (allVersions.length > MAX_VERSIONS) {
      const idsToDelete = allVersions.slice(MAX_VERSIONS).map((v) => v.id);
      await tx.mobileCredentialVersion.deleteMany({
        where: { id: { in: idsToDelete } },
      });
    }

    return { version: nextVersion };
  }

  throw new Error(
    `createMobileCredentialVersion: ${MAX_RETRIES} retries exceeded on mobileCredentialVersion(${credentialId})`,
  );
}
