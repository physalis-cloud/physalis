// OVERLAY self-host — rotation À LA DEMANDE (mono-tenant).
//
// Version RÉDUITE de lib/rotation-agent.ts : on ne garde que l'application des
// résultats de rotation (persistance + versioning + redeploy), appelée par les
// rotators (lib/rotators/*) via le bouton « Forcer » et les routes
// accounts/services/vault. L'ORCHESTRATION fleet de la source (agent autonome,
// plan/report, injection compose, fenêtres cron) est retirée : elle dépend de
// tenant-prisma / backup / compose-merge / rotation-cron, tous exclus du
// self-host. `getTenantPrisma(slug)` → `prisma` (mono-tenant, base unique) ;
// `withTenantSchema` reste (shim mono-tenant, cf. overlay lib/tenant.ts).

import { prisma } from "./prisma";
import { encrypt } from "./crypto";
import { withTenantSchema } from "./tenant";
import { createSecretVersion, type TenantTx } from "./versioning";
import { triggerSync } from "./sync/dispatch";
import { logAction } from "./audit";
import { triggerProjectRedeploy, redeployAuditMetadata } from "./redeploy";

type SecretForRotation = {
  encryptedValue: string;
  iv: string;
  tag: string;
  rotationIntervalDays: number | null;
  rotationNeedsFullDeploy: boolean;
  environmentId: string;
  key: string;
  environment: {
    name: string;
    project: {
      id: string;
      organizationId: string;
      githubRepo: string | null;
      githubWorkflow: string | null;
    };
  };
};

async function loadSecretForRotation(
  tenantSlug: string,
  secretId: string,
): Promise<SecretForRotation | null> {
  return withTenantSchema(tenantSlug, (tx) =>
    tx.secret.findUnique({
      where: { id: secretId },
      select: {
        encryptedValue: true,
        iv: true,
        tag: true,
        rotationIntervalDays: true,
        rotationNeedsFullDeploy: true,
        environmentId: true,
        key: true,
        environment: {
          select: {
            name: true,
            project: {
              select: {
                id: true,
                organizationId: true,
                githubRepo: true,
                githubWorkflow: true,
              },
            },
          },
        },
      },
    }),
  ) as Promise<SecretForRotation | null>;
}

/**
 * Applique une rotation réussie : nouvelle version (rollback), MAJ du secret +
 * échéancier, sync sortante, puis redeploy canonique (multi-provider) pour que
 * les conteneurs reprennent la nouvelle valeur. Appelée par les rotators.
 */
export async function applyRotationSuccess(
  tenantSlug: string,
  secretId: string,
  newValue: string,
  source: "agent" | "n8n" | "webhook" | "direct" = "agent",
): Promise<void> {
  const secret = await loadSecretForRotation(tenantSlug, secretId);
  if (!secret) throw new Error(`Secret ${secretId} introuvable`);

  const { encryptedValue, iv, tag } = encrypt(newValue);
  const { project } = secret.environment;

  await prisma.$transaction(async (tx) => {
    await createSecretVersion({
      tx: tx as unknown as TenantTx,
      secretId,
      encryptedValue: secret.encryptedValue,
      iv: secret.iv,
      tag: secret.tag,
      createdById: null,
    });

    const now = new Date();
    const nextAt = secret.rotationIntervalDays
      ? new Date(now.getTime() + secret.rotationIntervalDays * 86400000)
      : null;

    await tx.secret.update({
      where: { id: secretId },
      data: {
        encryptedValue,
        iv,
        tag,
        rotationLastAt: now,
        rotationNextAt: nextAt,
        rotationLastStatus: "success",
        rotationErrorCount: 0,
        rotationForceRequestedAt: null,
      },
    });
  });

  void triggerSync(tenantSlug, secret.environmentId, "rotation_database_agent");

  const workflowOverride = secret.rotationNeedsFullDeploy
    ? (project.githubWorkflow ?? "deploy.yml")
    : undefined;
  const outcome = await triggerProjectRedeploy(
    prisma,
    tenantSlug,
    project.id,
    secret.environment.name,
    workflowOverride,
  );

  logAction({
    action: "REDEPLOY_TRIGGERED",
    actor: { kind: "anonymous" },
    organizationId: project.organizationId,
    projectId: project.id,
    targetType: "Project",
    targetId: project.id,
    metadata: redeployAuditMetadata(outcome, { trigger: "rotation", source }),
    tenantSlug,
  });

  logAction({
    action: "SECRET_ROTATED",
    actor: { kind: "anonymous" },
    organizationId: project.organizationId,
    projectId: project.id,
    targetType: "Secret",
    targetId: secretId,
    secretKey: secret.key,
    metadata: {
      strategy: "DATABASE",
      execMode: source === "agent" ? "AGENT" : "DIRECT",
      triggeredBy: source,
      status: "success",
    },
    tenantSlug,
  });
}

/**
 * Échec reporté : statut error + compteur, notification admin au 1ᵉʳ échec
 * uniquement (anti-spam). `rotationNextAt` PAS recalculée → reste dû.
 */
export async function applyRotationFailure(
  tenantSlug: string,
  secretId: string,
  errorMessage?: string,
): Promise<void> {
  const updated = await withTenantSchema(tenantSlug, (tx) =>
    tx.secret.update({
      where: { id: secretId },
      data: {
        rotationLastStatus: "error",
        rotationErrorCount: { increment: 1 },
        rotationForceRequestedAt: null,
      },
      select: { key: true, rotationErrorCount: true },
    }),
  );

  if (updated.rotationErrorCount === 1) {
    void notifyRotationFailure(tenantSlug, secretId, updated.key, errorMessage);
  }
}

async function notifyRotationFailure(
  tenantSlug: string,
  secretId: string,
  key: string,
  errorMessage?: string,
): Promise<void> {
  const secret = await withTenantSchema(tenantSlug, (tx) =>
    tx.secret.findUnique({
      where: { id: secretId },
      select: {
        environment: {
          select: {
            project: {
              select: {
                organization: {
                  select: {
                    members: {
                      where: { role: { in: ["ADMIN", "OWNER"] } },
                      orderBy: { createdAt: "asc" },
                      take: 1,
                      select: { user: { select: { email: true } } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    }),
  );
  const adminEmail =
    secret?.environment.project.organization.members[0]?.user.email;
  if (!adminEmail) return;

  const { sendEmail } = await import("./email");
  await sendEmail({
    to: adminEmail,
    subject: `[Physalis] Échec de rotation du secret ${key}`,
    text: `La rotation automatique du secret "${key}" a échoué.${errorMessage ? ` Erreur : ${errorMessage}` : ""} Vérifiez l'agent de rotation et la base de données du projet.`,
    html: `<p>La rotation automatique du secret <strong>${key}</strong> a échoué.</p>${errorMessage ? `<p>Erreur : ${errorMessage}</p>` : ""}<p>Vérifiez l'agent de rotation et la base de données du projet.</p>`,
  });
}
