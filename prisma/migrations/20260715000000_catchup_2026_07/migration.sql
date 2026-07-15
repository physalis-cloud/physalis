-- CreateEnum
CREATE TYPE "RestoreStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCESS', 'FAILED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AccessAction" ADD VALUE 'LOGOUT';
ALTER TYPE "AccessAction" ADD VALUE 'PROJECT_GROUP_CREATE';
ALTER TYPE "AccessAction" ADD VALUE 'PROJECT_GROUP_UPDATE';
ALTER TYPE "AccessAction" ADD VALUE 'PROJECT_GROUP_DELETE';
ALTER TYPE "AccessAction" ADD VALUE 'BACKUP_RESTORE_REQUESTED';
ALTER TYPE "AccessAction" ADD VALUE 'BACKUP_RESTORE_SUCCESS';
ALTER TYPE "AccessAction" ADD VALUE 'BACKUP_RESTORE_FAILED';
ALTER TYPE "AccessAction" ADD VALUE 'SECRET_SYNC_PUSH';
ALTER TYPE "AccessAction" ADD VALUE 'SYNC_TARGET_CREATE';
ALTER TYPE "AccessAction" ADD VALUE 'SYNC_TARGET_UPDATE';
ALTER TYPE "AccessAction" ADD VALUE 'SYNC_TARGET_DELETE';
ALTER TYPE "AccessAction" ADD VALUE 'SSO_CONFIG_CREATED';
ALTER TYPE "AccessAction" ADD VALUE 'SSO_CONFIG_UPDATED';
ALTER TYPE "AccessAction" ADD VALUE 'SSO_CONFIG_DELETED';
ALTER TYPE "AccessAction" ADD VALUE 'SSO_LOGIN_SUCCESS';
ALTER TYPE "AccessAction" ADD VALUE 'SSO_LOGIN_FAILURE';
ALTER TYPE "AccessAction" ADD VALUE 'MEMBER_SSO_PROVISIONED';

-- DropIndex
DROP INDEX "Policy_repo_workflow_branch_idx";

-- DropIndex
DROP INDEX "Policy_repo_workflow_branch_projectId_environmentId_key";

-- AlterTable
ALTER TABLE "AppAccount" ADD COLUMN     "environmentId" TEXT,
ADD COLUMN     "rotationDbTarget" TEXT,
ADD COLUMN     "rotationEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "rotationExecMode" TEXT,
ADD COLUMN     "rotationHistory" JSONB,
ADD COLUMN     "rotationHookToken" TEXT,
ADD COLUMN     "rotationIntervalDays" INTEGER,
ADD COLUMN     "rotationLastAt" TIMESTAMP(3),
ADD COLUMN     "rotationLastStatus" TEXT,
ADD COLUMN     "rotationNextAt" TIMESTAMP(3),
ADD COLUMN     "rotationStrategy" TEXT,
ADD COLUMN     "rotationWebhookUrl" TEXT,
ADD COLUMN     "serviceId" TEXT;

-- AlterTable
ALTER TABLE "Policy" ADD COLUMN     "issuer" TEXT,
ADD COLUMN     "provider" TEXT NOT NULL DEFAULT 'github';

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "ciConnectionId" TEXT,
ADD COLUMN     "ciRepo" TEXT,
ADD COLUMN     "groupId" TEXT,
ADD COLUMN     "position" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "ProjectBackupConfig" ADD COLUMN     "backupKeyScheme" TEXT,
ADD COLUMN     "kmsKeyName" TEXT;

-- AlterTable
ALTER TABLE "Secret" ADD COLUMN     "rotationExecMode" TEXT NOT NULL DEFAULT 'AGENT',
ADD COLUMN     "rotationForceRequestedAt" TIMESTAMP(3),
ADD COLUMN     "rotationHookLabel" TEXT,
ADD COLUMN     "rotationHookToken" TEXT;

-- AlterTable
ALTER TABLE "Service" ADD COLUMN     "dbHost" TEXT,
ADD COLUMN     "dbName" TEXT,
ADD COLUMN     "dbPort" INTEGER,
ADD COLUMN     "dbPwEncrypted" TEXT,
ADD COLUMN     "dbPwIv" TEXT,
ADD COLUMN     "dbPwTag" TEXT,
ADD COLUMN     "dbType" TEXT,
ADD COLUMN     "dbUser" TEXT,
ADD COLUMN     "rotationEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "rotationExecMode" TEXT,
ADD COLUMN     "rotationHistory" JSONB,
ADD COLUMN     "rotationHookToken" TEXT,
ADD COLUMN     "rotationIntervalDays" INTEGER,
ADD COLUMN     "rotationLastAt" TIMESTAMP(3),
ADD COLUMN     "rotationLastStatus" TEXT,
ADD COLUMN     "rotationNextAt" TIMESTAMP(3),
ADD COLUMN     "rotationWebhookUrl" TEXT;

-- AlterTable
ALTER TABLE "TeamVaultEntry" ADD COLUMN     "rotationEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "rotationHistory" JSONB,
ADD COLUMN     "rotationIntervalDays" INTEGER,
ADD COLUMN     "rotationLastAt" TIMESTAMP(3),
ADD COLUMN     "rotationLastStatus" TEXT,
ADD COLUMN     "rotationNextAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "ssoProvider" TEXT,
ALTER COLUMN "password" DROP NOT NULL;

-- CreateTable
CREATE TABLE "UserSocialIdentity" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "sub" TEXT NOT NULL,
    "email" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserSocialIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectBackupRestore" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "configId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "destLocation" TEXT NOT NULL,
    "dbType" "BackupDbType" NOT NULL,
    "dbName" TEXT NOT NULL,
    "environmentName" TEXT NOT NULL,
    "targetDbName" TEXT NOT NULL,
    "replaceExisting" BOOLEAN NOT NULL DEFAULT false,
    "status" "RestoreStatus" NOT NULL DEFAULT 'PENDING',
    "errorMessage" TEXT,
    "requestedById" TEXT,
    "claimedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectBackupRestore_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectGroup" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CiConnection" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'github',
    "issuer" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CiConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CiConnectionSecret" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "encryptedValue" TEXT NOT NULL,
    "iv" TEXT NOT NULL,
    "tag" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CiConnectionSecret_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EnvironmentSyncTarget" (
    "id" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "ciConnectionId" TEXT NOT NULL,
    "externalProjectId" TEXT NOT NULL,
    "externalProjectName" TEXT,
    "externalEnvironmentId" TEXT,
    "externalServiceId" TEXT,
    "targets" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "tagFilter" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "lastSyncAt" TIMESTAMP(3),
    "lastSyncStatus" TEXT,
    "lastSyncError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EnvironmentSyncTarget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "policies" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "provider" TEXT NOT NULL DEFAULT 'github',
    "issuer" TEXT,
    "repo" TEXT NOT NULL,
    "workflow" TEXT NOT NULL,
    "branch" TEXT NOT NULL,
    "tenant_slug" VARCHAR(100) NOT NULL,
    "project_id" TEXT NOT NULL,
    "environment_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "policies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UserSocialIdentity_userId_idx" ON "UserSocialIdentity"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "UserSocialIdentity_provider_sub_key" ON "UserSocialIdentity"("provider", "sub");

-- CreateIndex
CREATE UNIQUE INDEX "UserSocialIdentity_userId_provider_key" ON "UserSocialIdentity"("userId", "provider");

-- CreateIndex
CREATE INDEX "ProjectBackupRestore_configId_status_idx" ON "ProjectBackupRestore"("configId", "status");

-- CreateIndex
CREATE INDEX "ProjectBackupRestore_projectId_createdAt_idx" ON "ProjectBackupRestore"("projectId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "ProjectGroup_organizationId_idx" ON "ProjectGroup"("organizationId");

-- CreateIndex
CREATE INDEX "CiConnection_organizationId_idx" ON "CiConnection"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "CiConnection_organizationId_name_key" ON "CiConnection"("organizationId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "CiConnectionSecret_connectionId_kind_key" ON "CiConnectionSecret"("connectionId", "kind");

-- CreateIndex
CREATE INDEX "EnvironmentSyncTarget_ciConnectionId_idx" ON "EnvironmentSyncTarget"("ciConnectionId");

-- CreateIndex
CREATE INDEX "EnvironmentSyncTarget_lastSyncStatus_idx" ON "EnvironmentSyncTarget"("lastSyncStatus");

-- CreateIndex
CREATE UNIQUE INDEX "EnvironmentSyncTarget_environmentId_ciConnectionId_key" ON "EnvironmentSyncTarget"("environmentId", "ciConnectionId");

-- CreateIndex
CREATE INDEX "policies_provider_repo_workflow_branch_idx" ON "policies"("provider", "repo", "workflow", "branch");

-- CreateIndex
CREATE INDEX "policies_tenant_slug_project_id_idx" ON "policies"("tenant_slug", "project_id");

-- CreateIndex
CREATE INDEX "policies_issuer_idx" ON "policies"("issuer");

-- CreateIndex
CREATE UNIQUE INDEX "policies_provider_repo_workflow_branch_tenant_slug_project__key" ON "policies"("provider", "repo", "workflow", "branch", "tenant_slug", "project_id", "environment_id");

-- CreateIndex
CREATE INDEX "AppAccount_rotationNextAt_idx" ON "AppAccount"("rotationNextAt");

-- CreateIndex
CREATE INDEX "AppAccount_environmentId_idx" ON "AppAccount"("environmentId");

-- CreateIndex
CREATE INDEX "AppAccount_serviceId_idx" ON "AppAccount"("serviceId");

-- CreateIndex
CREATE INDEX "Policy_provider_repo_workflow_branch_idx" ON "Policy"("provider", "repo", "workflow", "branch");

-- CreateIndex
CREATE UNIQUE INDEX "Policy_provider_repo_workflow_branch_projectId_environmentI_key" ON "Policy"("provider", "repo", "workflow", "branch", "projectId", "environmentId");

-- CreateIndex
CREATE INDEX "Project_ciConnectionId_idx" ON "Project"("ciConnectionId");

-- CreateIndex
CREATE INDEX "Project_groupId_idx" ON "Project"("groupId");

-- CreateIndex
CREATE INDEX "Service_rotationNextAt_idx" ON "Service"("rotationNextAt");

-- CreateIndex
CREATE INDEX "TeamVaultEntry_rotationNextAt_idx" ON "TeamVaultEntry"("rotationNextAt");

-- AddForeignKey
ALTER TABLE "UserSocialIdentity" ADD CONSTRAINT "UserSocialIdentity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectBackupRestore" ADD CONSTRAINT "ProjectBackupRestore_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectBackupRestore" ADD CONSTRAINT "ProjectBackupRestore_configId_fkey" FOREIGN KEY ("configId") REFERENCES "ProjectBackupConfig"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "ProjectGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_ciConnectionId_fkey" FOREIGN KEY ("ciConnectionId") REFERENCES "CiConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectGroup" ADD CONSTRAINT "ProjectGroup_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CiConnection" ADD CONSTRAINT "CiConnection_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CiConnectionSecret" ADD CONSTRAINT "CiConnectionSecret_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "CiConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EnvironmentSyncTarget" ADD CONSTRAINT "EnvironmentSyncTarget_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EnvironmentSyncTarget" ADD CONSTRAINT "EnvironmentSyncTarget_ciConnectionId_fkey" FOREIGN KEY ("ciConnectionId") REFERENCES "CiConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppAccount" ADD CONSTRAINT "AppAccount_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppAccount" ADD CONSTRAINT "AppAccount_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE SET NULL ON UPDATE CASCADE;

