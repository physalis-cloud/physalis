-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AccessAction" ADD VALUE 'DEPLOY_REPORTED';
ALTER TYPE "AccessAction" ADD VALUE 'AUTOMATION_ENABLED';
ALTER TYPE "AccessAction" ADD VALUE 'AUTOMATION_DISABLED';
ALTER TYPE "AccessAction" ADD VALUE 'AUTOMATION_MODEL_KEY_SET';
ALTER TYPE "AccessAction" ADD VALUE 'N8N_CONNECTION_CREATE';
ALTER TYPE "AccessAction" ADD VALUE 'N8N_CONNECTION_DELETE';
ALTER TYPE "AccessAction" ADD VALUE 'N8N_CONNECTION_PROBE';
ALTER TYPE "AccessAction" ADD VALUE 'N8N_WORKFLOW_PUSH';
ALTER TYPE "AccessAction" ADD VALUE 'N8N_WORKFLOW_ACTIVATE';
ALTER TYPE "AccessAction" ADD VALUE 'N8N_WORKFLOW_DEACTIVATE';
ALTER TYPE "AccessAction" ADD VALUE 'N8N_WORKFLOW_DELETE';
ALTER TYPE "AccessAction" ADD VALUE 'N8N_WORKFLOW_ESSAI';
ALTER TYPE "AccessAction" ADD VALUE 'N8N_WORKFLOW_ADOPT';
ALTER TYPE "AccessAction" ADD VALUE 'N8N_WORKFLOW_EDIT';
ALTER TYPE "AccessAction" ADD VALUE 'N8N_CREDENTIAL_WRITE';
ALTER TYPE "AccessAction" ADD VALUE 'N8N_CREDENTIAL_TEST';
ALTER TYPE "AccessAction" ADD VALUE 'N8N_CREDENTIAL_UNLINK';
ALTER TYPE "AccessAction" ADD VALUE 'AUTOMATION_OAUTH_CREATE';
ALTER TYPE "AccessAction" ADD VALUE 'AUTOMATION_OAUTH_CONSENT_START';
ALTER TYPE "AccessAction" ADD VALUE 'AUTOMATION_OAUTH_CONSENT_OK';
ALTER TYPE "AccessAction" ADD VALUE 'AUTOMATION_OAUTH_POSE';
ALTER TYPE "AccessAction" ADD VALUE 'AUTOMATION_OAUTH_UPDATE';
ALTER TYPE "AccessAction" ADD VALUE 'AUTOMATION_OAUTH_DELETE';
ALTER TYPE "AccessAction" ADD VALUE 'MOBILE_RELEASE_SYNCED';
ALTER TYPE "AccessAction" ADD VALUE 'MOBILE_STORE_ACTION';
ALTER TYPE "AccessAction" ADD VALUE 'CLI_SESSION_APPROVED';
ALTER TYPE "AccessAction" ADD VALUE 'CLI_SESSION_DENIED';
ALTER TYPE "AccessAction" ADD VALUE 'CLI_SESSION_REVOKED';
ALTER TYPE "AccessAction" ADD VALUE 'SSH_KEY_SIGN';

-- AlterEnum
ALTER TYPE "TokenKind" ADD VALUE 'CLI';

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "announcementsSeenAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "rotationAncienneteDays" INTEGER,
ADD COLUMN     "rotationPreavisDays" INTEGER NOT NULL DEFAULT 7;

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "setupCompletedAt" TIMESTAMP(3),
ADD COLUMN     "setupGuide" TEXT,
ADD COLUMN     "setupLegacy" BOOLEAN NOT NULL DEFAULT false;

-- Backfill (repris de la migration source 20261003120000_project_setup_guide,
-- qu'un `migrate diff` ne peut pas produire) : les projets qui existent avant
-- l'onglet « Installation » sont marqués hérités, pour ne pas leur imposer un
-- guide de mise en route. `setupCompletedAt` vient d'être créée ci-dessus,
-- donc NULL partout : tous les projets existants sont marqués, c'est voulu.
-- Une instance neuve a une table vide : rien n'est marqué.
UPDATE "Project" SET "setupLegacy" = true WHERE "setupCompletedAt" IS NULL;

-- AlterTable
ALTER TABLE "Environment" ADD COLUMN     "position" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "MobileApp" ADD COLUMN     "lastVerifiedAt" TIMESTAMP(3),
ADD COLUMN     "lastVerifyReport" JSONB;

-- AlterTable
ALTER TABLE "VaultEntry" ADD COLUMN     "sshFingerprint" TEXT,
ADD COLUMN     "sshPublicKey" TEXT;

-- AlterTable
ALTER TABLE "TeamVaultEntry" ADD COLUMN     "dataIv" TEXT,
ADD COLUMN     "dataTag" TEXT,
ADD COLUMN     "encryptedData" TEXT,
ADD COLUMN     "itemCount" INTEGER,
ADD COLUMN     "type" TEXT NOT NULL DEFAULT 'LOGIN';

-- CreateTable
CREATE TABLE "CliSession" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'HUMAN',
    "scope" JSONB,
    "deviceName" TEXT,
    "userAgent" TEXT,
    "ip" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "CliSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CliDeviceAuthorization" (
    "id" TEXT NOT NULL,
    "deviceCodeHash" TEXT NOT NULL,
    "userCode" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'HUMAN',
    "scope" JSONB,
    "deviceName" TEXT,
    "userAgent" TEXT,
    "ip" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "userId" TEXT,
    "interval" INTEGER NOT NULL DEFAULT 5,
    "lastPolledAt" TIMESTAMP(3),
    "decidedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CliDeviceAuthorization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClientAutomationConfig" (
    "id" TEXT NOT NULL,
    "tenantSlug" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "modelKeyEntryId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClientAutomationConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "N8nConnection" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "environmentId" TEXT,
    "name" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'direct',
    "n8nVersion" TEXT,
    "capabilities" JSONB,
    "credentialCollectionId" TEXT,
    "defaultModelProvider" TEXT,
    "defaultModelId" TEXT,
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "N8nConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "N8nCredentialLink" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "entryName" TEXT NOT NULL,
    "credentialType" TEXT NOT NULL,
    "n8nCredentialId" TEXT NOT NULL,
    "lastPushedAt" TIMESTAMP(3) NOT NULL,
    "lastTestAt" TIMESTAMP(3),
    "lastTestOk" BOOLEAN,
    "lastTestError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "N8nCredentialLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GeneratedWorkflow" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "n8nWorkflowId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "gabarit" TEXT,
    "gabaritParams" JSONB,
    "adopted" BOOLEAN NOT NULL DEFAULT false,
    "pushedJson" JSONB NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'draft',
    "conversationId" TEXT,
    "lastExecutionAt" TIMESTAMP(3),
    "lastErrorSummary" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GeneratedWorkflow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "N8nConnectionSecret" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "encryptedValue" TEXT NOT NULL,
    "iv" TEXT NOT NULL,
    "tag" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "N8nConnectionSecret_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationOAuthCredential" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT,
    "name" TEXT NOT NULL,
    "credentialType" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "consentedById" TEXT,
    "consentedSubject" TEXT,
    "consentedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutomationOAuthCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationOAuthPose" (
    "id" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "n8nCredentialId" TEXT NOT NULL,
    "posedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutomationOAuthPose_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationOAuthSecret" (
    "id" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "encryptedValue" TEXT NOT NULL,
    "iv" TEXT NOT NULL,
    "tag" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutomationOAuthSecret_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Deployment" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "policyId" TEXT,
    "provider" TEXT NOT NULL,
    "repo" TEXT NOT NULL,
    "workflow" TEXT NOT NULL,
    "branch" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "runAttempt" TEXT NOT NULL DEFAULT '1',
    "sha" TEXT,
    "status" TEXT NOT NULL DEFAULT 'requested',
    "statusSource" TEXT,
    "bundleServedCount" INTEGER NOT NULL DEFAULT 0,
    "authorizedAt" TIMESTAMP(3),
    "reportedAt" TIMESTAMP(3),
    "detail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Deployment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT,
    "collectionId" TEXT,
    "type" TEXT NOT NULL,
    "subjectKind" TEXT,
    "subjectId" TEXT,
    "subjectName" TEXT NOT NULL,
    "messageKey" TEXT NOT NULL,
    "vars" JSONB NOT NULL DEFAULT '{}',
    "dedupKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationRead" (
    "notificationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "readAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationRead_pkey" PRIMARY KEY ("notificationId","userId")
);

-- CreateTable
CREATE TABLE "NotificationDelivery" (
    "id" TEXT NOT NULL,
    "notificationId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationDestination" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT,
    "scopeKey" TEXT NOT NULL,
    "includeOwners" BOOLEAN NOT NULL DEFAULT true,
    "emails" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "webhookEntryId" TEXT,
    "webhookItemLabel" TEXT,
    "webhookFormat" TEXT,
    "webhookLastOkAt" TIMESTAMP(3),
    "webhookLastErrorAt" TIMESTAMP(3),
    "webhookLastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationDestination_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CliSession_tokenHash_key" ON "CliSession"("tokenHash");

-- CreateIndex
CREATE INDEX "CliSession_userId_idx" ON "CliSession"("userId");

-- CreateIndex
CREATE INDEX "CliSession_expiresAt_idx" ON "CliSession"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "CliDeviceAuthorization_deviceCodeHash_key" ON "CliDeviceAuthorization"("deviceCodeHash");

-- CreateIndex
CREATE UNIQUE INDEX "CliDeviceAuthorization_userCode_key" ON "CliDeviceAuthorization"("userCode");

-- CreateIndex
CREATE INDEX "CliDeviceAuthorization_expiresAt_idx" ON "CliDeviceAuthorization"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "ClientAutomationConfig_tenantSlug_key" ON "ClientAutomationConfig"("tenantSlug");

-- CreateIndex
CREATE INDEX "N8nConnection_organizationId_idx" ON "N8nConnection"("organizationId");

-- CreateIndex
CREATE INDEX "N8nConnection_environmentId_idx" ON "N8nConnection"("environmentId");

-- CreateIndex
CREATE UNIQUE INDEX "N8nConnection_organizationId_environmentId_name_key" ON "N8nConnection"("organizationId", "environmentId", "name");

-- CreateIndex
CREATE INDEX "N8nCredentialLink_connectionId_idx" ON "N8nCredentialLink"("connectionId");

-- CreateIndex
CREATE UNIQUE INDEX "N8nCredentialLink_connectionId_entryId_key" ON "N8nCredentialLink"("connectionId", "entryId");

-- CreateIndex
CREATE INDEX "GeneratedWorkflow_connectionId_idx" ON "GeneratedWorkflow"("connectionId");

-- CreateIndex
CREATE UNIQUE INDEX "GeneratedWorkflow_connectionId_n8nWorkflowId_key" ON "GeneratedWorkflow"("connectionId", "n8nWorkflowId");

-- CreateIndex
CREATE UNIQUE INDEX "N8nConnectionSecret_connectionId_kind_key" ON "N8nConnectionSecret"("connectionId", "kind");

-- CreateIndex
CREATE INDEX "AutomationOAuthCredential_organizationId_idx" ON "AutomationOAuthCredential"("organizationId");

-- CreateIndex
CREATE INDEX "AutomationOAuthCredential_projectId_idx" ON "AutomationOAuthCredential"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "AutomationOAuthCredential_organizationId_name_key" ON "AutomationOAuthCredential"("organizationId", "name");

-- CreateIndex
CREATE INDEX "AutomationOAuthPose_connectionId_idx" ON "AutomationOAuthPose"("connectionId");

-- CreateIndex
CREATE UNIQUE INDEX "AutomationOAuthPose_credentialId_connectionId_key" ON "AutomationOAuthPose"("credentialId", "connectionId");

-- CreateIndex
CREATE UNIQUE INDEX "AutomationOAuthSecret_credentialId_kind_key" ON "AutomationOAuthSecret"("credentialId", "kind");

-- CreateIndex
CREATE INDEX "Deployment_projectId_createdAt_idx" ON "Deployment"("projectId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Deployment_environmentId_createdAt_idx" ON "Deployment"("environmentId", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "Deployment_environmentId_provider_runId_runAttempt_key" ON "Deployment"("environmentId", "provider", "runId", "runAttempt");

-- CreateIndex
CREATE INDEX "Notification_organizationId_createdAt_idx" ON "Notification"("organizationId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Notification_projectId_idx" ON "Notification"("projectId");

-- CreateIndex
CREATE INDEX "Notification_collectionId_idx" ON "Notification"("collectionId");

-- CreateIndex
CREATE INDEX "Notification_organizationId_type_subjectKind_subjectId_crea_idx" ON "Notification"("organizationId", "type", "subjectKind", "subjectId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Notification_organizationId_dedupKey_key" ON "Notification"("organizationId", "dedupKey");

-- CreateIndex
CREATE INDEX "NotificationRead_userId_idx" ON "NotificationRead"("userId");

-- CreateIndex
CREATE INDEX "NotificationDelivery_notificationId_idx" ON "NotificationDelivery"("notificationId");

-- CreateIndex
CREATE INDEX "NotificationDestination_projectId_idx" ON "NotificationDestination"("projectId");

-- CreateIndex
CREATE INDEX "NotificationDestination_webhookEntryId_idx" ON "NotificationDestination"("webhookEntryId");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationDestination_organizationId_scopeKey_key" ON "NotificationDestination"("organizationId", "scopeKey");

-- AddForeignKey
ALTER TABLE "CliSession" ADD CONSTRAINT "CliSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CliDeviceAuthorization" ADD CONSTRAINT "CliDeviceAuthorization_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "N8nConnection" ADD CONSTRAINT "N8nConnection_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "N8nConnection" ADD CONSTRAINT "N8nConnection_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "N8nCredentialLink" ADD CONSTRAINT "N8nCredentialLink_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "N8nConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GeneratedWorkflow" ADD CONSTRAINT "GeneratedWorkflow_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "N8nConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "N8nConnectionSecret" ADD CONSTRAINT "N8nConnectionSecret_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "N8nConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationOAuthCredential" ADD CONSTRAINT "AutomationOAuthCredential_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationOAuthCredential" ADD CONSTRAINT "AutomationOAuthCredential_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationOAuthCredential" ADD CONSTRAINT "AutomationOAuthCredential_consentedById_fkey" FOREIGN KEY ("consentedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationOAuthPose" ADD CONSTRAINT "AutomationOAuthPose_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "AutomationOAuthCredential"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationOAuthPose" ADD CONSTRAINT "AutomationOAuthPose_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "N8nConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationOAuthSecret" ADD CONSTRAINT "AutomationOAuthSecret_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "AutomationOAuthCredential"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "TeamVaultCollection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationRead" ADD CONSTRAINT "NotificationRead_notificationId_fkey" FOREIGN KEY ("notificationId") REFERENCES "Notification"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationRead" ADD CONSTRAINT "NotificationRead_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationDelivery" ADD CONSTRAINT "NotificationDelivery_notificationId_fkey" FOREIGN KEY ("notificationId") REFERENCES "Notification"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationDestination" ADD CONSTRAINT "NotificationDestination_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationDestination" ADD CONSTRAINT "NotificationDestination_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationDestination" ADD CONSTRAINT "NotificationDestination_webhookEntryId_fkey" FOREIGN KEY ("webhookEntryId") REFERENCES "TeamVaultEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

