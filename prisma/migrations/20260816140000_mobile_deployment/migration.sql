-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AccessAction" ADD VALUE 'MOBILE_DEPLOY_AUTHORIZED';
ALTER TYPE "AccessAction" ADD VALUE 'MOBILE_DEPLOY_DENIED';
ALTER TYPE "AccessAction" ADD VALUE 'MOBILE_APP_CREATE';
ALTER TYPE "AccessAction" ADD VALUE 'MOBILE_APP_UPDATE';
ALTER TYPE "AccessAction" ADD VALUE 'MOBILE_APP_DELETE';
ALTER TYPE "AccessAction" ADD VALUE 'MOBILE_CREDENTIAL_IMPORT';
ALTER TYPE "AccessAction" ADD VALUE 'MOBILE_CREDENTIAL_REPLACE';
ALTER TYPE "AccessAction" ADD VALUE 'MOBILE_CREDENTIAL_DELETE';
ALTER TYPE "AccessAction" ADD VALUE 'MOBILE_CREDENTIAL_VERIFY';
ALTER TYPE "AccessAction" ADD VALUE 'MOBILE_CREDENTIAL_GENERATE';
ALTER TYPE "AccessAction" ADD VALUE 'MOBILE_RELEASE_REPORTED';
ALTER TYPE "AccessAction" ADD VALUE 'MOBILE_CERTIFICATE_REVOKED';

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "mobileEnabled" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Policy" ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'server',
ADD COLUMN     "mobileAppId" TEXT,
ALTER COLUMN "environmentId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "policies" ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'server',
ADD COLUMN     "mobile_app_id" TEXT,
ALTER COLUMN "environment_id" DROP NOT NULL;

-- CreateTable
CREATE TABLE "MobileApp" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "bundleId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "vendorTeamId" TEXT,
    "group" TEXT,
    "versionName" TEXT,
    "buildNumber" INTEGER NOT NULL DEFAULT 0,
    "deployPaused" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MobileApp_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MobileCredential" (
    "id" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "filename" TEXT,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "encryptedValue" TEXT NOT NULL,
    "iv" TEXT NOT NULL,
    "tag" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "expiryAlertedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MobileCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MobileRelease" (
    "id" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "track" TEXT NOT NULL DEFAULT 'pending',
    "versionName" TEXT,
    "buildNumber" TEXT NOT NULL,
    "statusSource" TEXT NOT NULL DEFAULT 'reported',
    "status" TEXT NOT NULL DEFAULT 'requested',
    "statusDetail" TEXT,
    "credentialsSha" JSONB NOT NULL DEFAULT '{}',
    "ciProvider" TEXT,
    "ciRepo" TEXT,
    "ciRef" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reportedAt" TIMESTAMP(3),
    "storeSyncedAt" TIMESTAMP(3),

    CONSTRAINT "MobileRelease_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MobileCredentialVersion" (
    "id" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "encryptedValue" TEXT NOT NULL,
    "iv" TEXT NOT NULL,
    "tag" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MobileCredentialVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MobileApp_projectId_idx" ON "MobileApp"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "MobileApp_projectId_platform_bundleId_key" ON "MobileApp"("projectId", "platform", "bundleId");

-- CreateIndex
CREATE INDEX "MobileCredential_expiresAt_idx" ON "MobileCredential"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "MobileCredential_appId_kind_key" ON "MobileCredential"("appId", "kind");

-- CreateIndex
CREATE INDEX "MobileRelease_appId_requestedAt_idx" ON "MobileRelease"("appId", "requestedAt" DESC);

-- CreateIndex
CREATE INDEX "MobileRelease_status_idx" ON "MobileRelease"("status");

-- CreateIndex
CREATE UNIQUE INDEX "MobileRelease_appId_track_buildNumber_key" ON "MobileRelease"("appId", "track", "buildNumber");

-- CreateIndex
CREATE INDEX "MobileCredentialVersion_credentialId_version_idx" ON "MobileCredentialVersion"("credentialId", "version" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "MobileCredentialVersion_credentialId_version_key" ON "MobileCredentialVersion"("credentialId", "version");

-- CreateIndex
CREATE INDEX "Policy_mobileAppId_idx" ON "Policy"("mobileAppId");

-- CreateIndex
CREATE UNIQUE INDEX "Policy_provider_repo_wf_branch_proj_mobile_key" ON "Policy"("provider", "repo", "workflow", "branch", "projectId", "mobileAppId");

-- CreateIndex
CREATE UNIQUE INDEX "policies_provider_repo_wf_branch_tenant_proj_mobile_key" ON "policies"("provider", "repo", "workflow", "branch", "tenant_slug", "project_id", "mobile_app_id");

-- AddForeignKey
ALTER TABLE "Policy" ADD CONSTRAINT "Policy_mobileAppId_fkey" FOREIGN KEY ("mobileAppId") REFERENCES "MobileApp"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MobileApp" ADD CONSTRAINT "MobileApp_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MobileCredential" ADD CONSTRAINT "MobileCredential_appId_fkey" FOREIGN KEY ("appId") REFERENCES "MobileApp"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MobileRelease" ADD CONSTRAINT "MobileRelease_appId_fkey" FOREIGN KEY ("appId") REFERENCES "MobileApp"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MobileCredentialVersion" ADD CONSTRAINT "MobileCredentialVersion_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "MobileCredential"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MobileCredentialVersion" ADD CONSTRAINT "MobileCredentialVersion_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "Policy_provider_repo_workflow_branch_projectId_environmentI_key" RENAME TO "Policy_provider_repo_wf_branch_proj_env_key";

-- RenameIndex
ALTER INDEX "policies_provider_repo_workflow_branch_tenant_slug_project__key" RENAME TO "policies_provider_repo_wf_branch_tenant_proj_env_key";

