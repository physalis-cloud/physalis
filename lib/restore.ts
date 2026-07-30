// Restauration orchestrée agent-driven (système ①, Phase 4 — cf.
// backup-clients-kms-plan.md §4). Le control plane crée un job PENDING ; l'agent
// le poll (restore-plan), tire l'archive `.penv` depuis la destination, déchiffre
// via OpenBao (identité restore = `decrypt`, token court fourni dans le plan) et
// restaure EN LOCAL sur le VPS. Physalis ne voit JAMAIS le plaintext. Module serveur.

import { prisma } from "./prisma";
import { withTenantSchema } from "./tenant";
import { getRestoreToken, isKmsConfigured } from "./kms";

export type RestoreRequestInput = { entryId: string; targetDbName?: string; replaceExisting?: boolean };

/**
 * Crée une demande de restauration (contexte session) depuis une archive existante.
 * Restaure par défaut dans la DB source ; `targetDbName` permet une cible distincte
 * (restauration non destructive). RBAC appliqué côté route (EDITOR+).
 */
export async function requestProjectRestore(
  projectId: string,
  requestedById: string,
  input: RestoreRequestInput,
): Promise<{ id: string } | { error: string }> {
  const entry = await prisma.projectBackupEntry.findFirst({
    where: { id: input.entryId, projectId },
    select: {
      id: true, filename: true, destLocation: true, dbType: true,
      dbName: true, environmentName: true, status: true, restorable: true, configId: true,
    },
  });
  if (!entry) return { error: "Archive introuvable" };
  if (entry.status !== "SUCCESS" || !entry.restorable) return { error: "Archive non restaurable" };
  // La restauration orchestrée (déchiffrement KMS) ne concerne que les enveloppes.
  if (!entry.filename.endsWith(".penv")) {
    return { error: "Restauration orchestrée réservée aux archives enveloppe (.penv)" };
  }

  const replaceExisting = input.replaceExisting === true;
  // En place : la cible EST la base d'origine. Sinon : cible distincte requise.
  const targetDbName = replaceExisting
    ? entry.dbName
    : (input.targetDbName ?? "").trim() || entry.dbName;
  const restore = await prisma.projectBackupRestore.create({
    data: {
      projectId,
      configId: entry.configId,
      filename: entry.filename,
      destLocation: entry.destLocation,
      dbType: entry.dbType,
      dbName: entry.dbName,
      environmentName: entry.environmentName,
      targetDbName,
      replaceExisting,
      requestedById,
      status: "PENDING",
    },
    select: { id: true },
  });
  await prisma.projectBackupEntry.update({
    where: { id: entry.id },
    data: { restoreJobId: restore.id },
  });
  return { id: restore.id };
}

export type RestorePlan = {
  id: string;
  filename: string;
  destLocation: string;
  dbType: string;
  dbName: string;
  targetDbName: string;
  replaceExisting: boolean;
  kmsKey: string;
  kmsToken: string;
};

/**
 * Renvoie le prochain job de restauration à exécuter pour cette config, avec un
 * **token de déchiffrement court** (identité restore). Réclame le job (PENDING→
 * RUNNING) de façon atomique. Le mint du token (I/O réseau OpenBao) se fait HORS
 * de `withTenantSchema` ($transaction). Null si rien à faire / KMS indisponible.
 */
export async function resolveRestorePlan(
  tenantSlug: string,
  configId: string,
  cidr?: string,
): Promise<RestorePlan | null> {
  const pending = await withTenantSchema(tenantSlug, (tx) =>
    tx.projectBackupRestore.findFirst({
      where: { configId, status: "PENDING" },
      orderBy: { createdAt: "asc" },
      select: {
        id: true, filename: true, destLocation: true,
        dbType: true, dbName: true, targetDbName: true, replaceExisting: true,
      },
    }),
  );
  if (!pending) return null;
  if (!isKmsConfigured()) return null;

  let kms: { token: string; kmsKeyName: string };
  try {
    kms = await getRestoreToken(tenantSlug, cidr);
  } catch (e) {
    console.error(`[restore] mint token KO (${tenantSlug}): ${(e as Error).message}`);
    return null;
  }

  // Réclame le job : seul le premier poll qui passe PENDING→RUNNING l'obtient.
  const claimed = await withTenantSchema(tenantSlug, (tx) =>
    tx.projectBackupRestore.updateMany({
      where: { id: pending.id, status: "PENDING" },
      data: { status: "RUNNING", claimedAt: new Date() },
    }),
  );
  if (claimed.count === 0) return null; // raflé par un poll concurrent

  return {
    id: pending.id,
    filename: pending.filename,
    destLocation: pending.destLocation,
    dbType: pending.dbType,
    dbName: pending.dbName,
    targetDbName: pending.targetDbName,
    replaceExisting: pending.replaceExisting,
    kmsKey: kms.kmsKeyName,
    kmsToken: kms.token,
  };
}

/** Enregistre le résultat d'une restauration remontée par l'agent. */
export async function recordRestoreReport(
  tenantSlug: string,
  configId: string,
  restoreId: string,
  ok: boolean,
  error?: string | null,
): Promise<void> {
  await withTenantSchema(tenantSlug, (tx) =>
    tx.projectBackupRestore.updateMany({
      where: { id: restoreId, configId },
      data: {
        status: ok ? "SUCCESS" : "FAILED",
        errorMessage: ok ? null : (error ?? "échec").slice(0, 1000),
        finishedAt: new Date(),
      },
    }),
  );
}
