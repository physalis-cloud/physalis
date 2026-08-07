// Dispatcher de la sync sortante : pousse les secrets d'un environnement vers
// toutes ses EnvironmentSyncTarget. Conçu pour être appelé en FIRE-AND-FORGET
// depuis les handlers de mutation de secret (POST/PATCH/DELETE/rollback) et la
// rotation — la sauvegarde du secret ne doit jamais être bloquée par un appel
// réseau vers une plateforme lente/down.
//
// OVERLAY self-host : identique à la source, MOINS `reconcileSyncTargets` (cron
// cross-tenant qui itère `adminPrisma.client` — inexistant en mono-tenant ; son
// seul appelant, app/api/cron/sync-reconcile, est exclu). `withTenantSchema`
// dégénère en transaction prisma (shim). Garder aligné sur la source à la main.
//
// MOINS, aussi, la sortie anticipée `if (!tenantSlug) return`. Tous les
// appelants passent le `tenantSlug` de `requireUser`/`requireEnvironment`, qui
// vaut TOUJOURS `null` en mono-tenant (cf. lib/api.ts) : la garde était donc
// vraie à chaque appel et la sync sortante ne partait JAMAIS, en silence — le
// propre d'un fire-and-forget étant de ne rien remonter. Le paramètre est
// conservé (signature alignée sur la source) et transmis tel quel au shim, qui
// l'ignore.
//
// Garde-fous sécurité (cf. roadmap intégration-cicd) : token jamais relu en
// clair hors de ce module ; messages d'erreur sanitizés ; host de la plateforme
// codé en dur côté connecteur (pas de SSRF) ; audit SECRET_SYNC_PUSH systématique.

import { withTenantSchema } from "../tenant";
import { decrypt } from "../crypto";
import { logAction } from "../audit";
import { getConnector } from "./connectors";
import { SYNC_TOKEN_KIND, type SyncProvider, type SyncSecret } from "./types";

type ConnectionSecretRow = {
  kind: string;
  encryptedValue: string;
  iv: string;
  tag: string;
};

type RawSecretRow = {
  key: string;
  encryptedValue: string;
  iv: string;
  tag: string;
  tags: string[];
};

type TargetRow = {
  id: string;
  externalProjectId: string;
  externalEnvironmentId: string | null;
  externalServiceId: string | null;
  targets: string[];
  tagFilter: string[];
  environment: { projectId: string; project: { organizationId: string } };
  // issuer : réutilisé pour les providers de sync comme scope d'équipe
  // (Vercel teamId/slug). null = scope du token.
  ciConnection: { provider: string; issuer: string | null; secrets: ConnectionSecretRow[] };
};

type SyncActor = { userId: string; email?: string | null };

/** Tronque + aplatit un message d'erreur. Ne jamais y injecter de secret/token. */
function sanitizeError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/\s+/g, " ").trim().slice(0, 300);
}

/** Déchiffre le token de la connexion pour le provider donné. */
function resolveToken(provider: string, secrets: ConnectionSecretRow[]): string | null {
  const kind = SYNC_TOKEN_KIND[provider as SyncProvider];
  if (!kind) return null;
  const row = secrets.find((s) => s.kind === kind);
  return row
    ? decrypt({ encryptedValue: row.encryptedValue, iv: row.iv, tag: row.tag })
    : null;
}

/**
 * Pousse les secrets de `environmentId` vers toutes ses cibles de sync.
 * Fire-and-forget : à appeler sans await depuis un handler. Ne throw jamais.
 */
export async function triggerSync(
  tenantSlug: string | null | undefined,
  environmentId: string,
  reason: string,
  actor?: SyncActor,
): Promise<void> {
  // `undefined` (appelants qui ne passent rien) et `null` (mono-tenant) sont le
  // même cas ici : aucun schéma à cibler, le shim s'en charge.
  const slug = tenantSlug ?? null;
  try {
    const targets = (await withTenantSchema(slug, (tx) =>
      tx.environmentSyncTarget.findMany({
        where: { environmentId },
        select: {
          id: true,
          externalProjectId: true,
          externalEnvironmentId: true,
          externalServiceId: true,
          targets: true,
          tagFilter: true,
          environment: {
            select: {
              projectId: true,
              project: { select: { organizationId: true } },
            },
          },
          ciConnection: {
            select: {
              provider: true,
              issuer: true,
              secrets: {
                select: { kind: true, encryptedValue: true, iv: true, tag: true },
              },
            },
          },
        },
      }),
    )) as TargetRow[];
    if (targets.length === 0) return;

    // Secrets de l'env chargés une seule fois (chiffrés ; déchiffrés par cible
    // après filtrage par tag pour limiter le déchiffrement au strict besoin).
    const rawSecrets = (await withTenantSchema(slug, (tx) =>
      tx.secret.findMany({
        where: { environmentId },
        select: { key: true, encryptedValue: true, iv: true, tag: true, tags: true },
      }),
    )) as RawSecretRow[];

    for (const target of targets) {
      await pushOne(slug, environmentId, target, rawSecrets, reason, actor);
    }
  } catch (err) {
    console.error(
      `[sync] triggerSync env=${environmentId} reason=${reason}:`,
      sanitizeError(err),
    );
  }
}

async function pushOne(
  // `string | null` (et non `string` comme dans la source) : sans la sortie
  // anticipée sur `!tenantSlug`, le null du mono-tenant arrive jusqu'ici. Il
  // n'est que transmis au shim `withTenantSchema` et à `logAction`, qui
  // l'acceptent tous les deux.
  tenantSlug: string | null,
  environmentId: string,
  target: TargetRow,
  rawSecrets: RawSecretRow[],
  reason: string,
  actor?: SyncActor,
): Promise<void> {
  const provider = target.ciConnection.provider;

  // Filtrage par tag : tagFilter vide = tous les secrets de l'env.
  const filtered =
    target.tagFilter.length === 0
      ? rawSecrets
      : rawSecrets.filter((s) => s.tags.some((t) => target.tagFilter.includes(t)));

  let status: "success" | "error" = "success";
  let error: string | null = null;
  try {
    const connector = getConnector(provider);
    if (!connector) {
      throw new Error(`No sync connector registered for provider "${provider}"`);
    }
    const token = resolveToken(provider, target.ciConnection.secrets);
    if (!token) throw new Error(`Missing token for provider "${provider}"`);

    const secrets: SyncSecret[] = filtered.map((s) => ({
      key: s.key,
      value: decrypt({ encryptedValue: s.encryptedValue, iv: s.iv, tag: s.tag }),
    }));

    await connector.push({
      token,
      teamId: target.ciConnection.issuer,
      externalProjectId: target.externalProjectId,
      externalEnvironmentId: target.externalEnvironmentId,
      externalServiceId: target.externalServiceId,
      targets: target.targets,
      secrets,
    });
  } catch (err) {
    status = "error";
    error = sanitizeError(err);
    console.error(`[sync] push failed target=${target.id} provider=${provider}:`, error);
  }

  await withTenantSchema(tenantSlug, (tx) =>
    tx.environmentSyncTarget.update({
      where: { id: target.id },
      data: { lastSyncAt: new Date(), lastSyncStatus: status, lastSyncError: error },
    }),
  ).catch((e) =>
    console.error(`[sync] status update failed target=${target.id}:`, sanitizeError(e)),
  );

  logAction({
    action: "SECRET_SYNC_PUSH",
    actor: actor
      ? { kind: "user", userId: actor.userId, email: actor.email }
      : { kind: "anonymous" },
    organizationId: target.environment.project.organizationId,
    projectId: target.environment.projectId,
    environmentId,
    targetType: "EnvironmentSyncTarget",
    targetId: target.id,
    metadata: {
      provider,
      reason,
      status,
      secretCount: filtered.length,
      ...(error ? { error } : {}),
    },
    tenantSlug,
  });
}

/**
 * Offboarding (garde-fou #7) : supprime les variables gérées par Physalis sur la
 * plateforme distante pour une cible donnée (push d'un état vide → le connecteur
 * retire les vars marquées Physalis, laisse intactes celles saisies à la main).
 * À appeler AVANT de supprimer la ligne EnvironmentSyncTarget si l'utilisateur
 * choisit le nettoyage distant. Throw en cas d'échec (le caller décide).
 */
export async function offboardSyncTarget(
  tenantSlug: string,
  targetId: string,
): Promise<void> {
  const target = (await withTenantSchema(tenantSlug, (tx) =>
    tx.environmentSyncTarget.findUnique({
      where: { id: targetId },
      select: {
        externalProjectId: true,
        externalEnvironmentId: true,
        externalServiceId: true,
        targets: true,
        ciConnection: {
          select: {
            provider: true,
            issuer: true,
            secrets: {
              select: { kind: true, encryptedValue: true, iv: true, tag: true },
            },
          },
        },
      },
    }),
  )) as {
    externalProjectId: string;
    externalEnvironmentId: string | null;
    externalServiceId: string | null;
    targets: string[];
    ciConnection: { provider: string; issuer: string | null; secrets: ConnectionSecretRow[] };
  } | null;
  if (!target) return;

  const connector = getConnector(target.ciConnection.provider);
  if (!connector) throw new Error(`No connector for "${target.ciConnection.provider}"`);
  const token = resolveToken(target.ciConnection.provider, target.ciConnection.secrets);
  if (!token) throw new Error("Missing token");

  await connector.push({
    token,
    teamId: target.ciConnection.issuer,
    externalProjectId: target.externalProjectId,
    externalEnvironmentId: target.externalEnvironmentId,
    externalServiceId: target.externalServiceId,
    targets: target.targets,
    secrets: [], // état vide → supprime toutes les vars gérées par Physalis
  });
}
