import { RiFolderOpenLine } from "@remixicon/react";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getCurrentOrgSlug } from "@/lib/api";
import { isPlatformAdmin, hasDevPrivileges } from "@/lib/roles";
import { isSyncProvider } from "@/lib/sync/types";
import PageHero from "@/components/PageHero";
import CreateProjectForm from "./create-project";
import CreateGroupForm from "./create-group";
import ProjectsBoard, { type ProjectVM } from "./projects-board";
import { getTranslations } from "next-intl/server";

export default async function ProjectsPage() {
  const session = await auth();
  if (!session?.user?.id) return null;
  const t = await getTranslations("projects");

  const orgSlug = await getCurrentOrgSlug(session.user.id);
  if (!orgSlug) {
    return (
      <div className="page">
        <div className="page-content">
          <PageHero
            icon={<RiFolderOpenLine size={28} aria-hidden />}
            title={t("pageTitle")}
          />
          <div
            className="card"
            style={{
              borderStyle: "dashed",
              borderColor: "var(--accent-soft)",
              background: "var(--accent-bg)",
              marginTop: 16,
            }}
          >
            {t("noOrg")}
          </div>
        </div>
      </div>
    );
  }

  // Filtrage : un projet apparait dans la liste si l'user y a acces
  //   - Global ADMIN ou OrgADMIN/OWNER → tous les projets de l'org
  //   - DEV → tous les projets de l'org SAUF ceux marqués hidden=true
  //   - MEMBER → uniquement les projets où il est ProjectMember explicite
  const isGlobalAdmin = isPlatformAdmin(session.user.role);
  const orgMembership = await prisma.orgMember.findFirst({
    where: {
      userId: session.user.id,
      organization: { slug: orgSlug },
    },
    select: { role: true },
  });
  const orgRole = orgMembership?.role ?? null;
  const isOrgAdmin = orgRole === "OWNER" || orgRole === "ADMIN";

  const projects = await prisma.project.findMany({
    where:
      isGlobalAdmin || isOrgAdmin
        ? { organization: { slug: orgSlug } }
        : hasDevPrivileges(orgRole)
          ? {
              organization: { slug: orgSlug },
              members: {
                none: { userId: session.user.id, hidden: true },
              },
            }
          : {
              organization: { slug: orgSlug },
              members: {
                some: { userId: session.user.id, hidden: false },
              },
            },
    select: {
      id: true,
      name: true,
      slug: true,
      groupId: true,
      position: true,
      createdAt: true,
      environments: {
        select: {
          _count: { select: { secrets: true } },
          syncTargets: {
            select: { ciConnection: { select: { provider: true } } },
          },
        },
      },
      ciConnection: { select: { provider: true } },
      emailConfig: { select: { verified: true } },
      backupConfig: { select: { enabled: true } },
      _count: {
        select: {
          tokens: { where: { revokedAt: null } },
          environments: true,
          services: true,
          appAccounts: true,
          apis: true,
        },
      },
    },
    orderBy: [{ position: "asc" }, { createdAt: "desc" }],
  });

  const [org, groups] = await Promise.all([
    prisma.organization.findUnique({
      where: { slug: orgSlug },
      select: { name: true },
    }),
    prisma.projectGroup.findMany({
      where: { organization: { slug: orgSlug } },
      select: { id: true, name: true, position: true },
      orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    }),
  ]);

  // Dernier déploiement par projet.
  const projectIds = projects.map((p) => p.id);
  const lastDeployLogs = projectIds.length
    ? await prisma.accessLog.findMany({
        where: { action: "DEPLOY_AUTHORIZED", projectId: { in: projectIds } },
        orderBy: { createdAt: "desc" },
        distinct: ["projectId"],
        select: { projectId: true, environmentId: true, createdAt: true },
      })
    : [];

  const envIds = lastDeployLogs
    .map((d) => d.environmentId)
    .filter((id): id is string => Boolean(id));
  const envs = envIds.length
    ? await prisma.environment.findMany({
        where: { id: { in: envIds } },
        select: { id: true, name: true },
      })
    : [];
  const envNameById = new Map(envs.map((e) => [e.id, e.name]));
  const lastDeployByProject = new Map(
    lastDeployLogs.map((d) => [
      d.projectId,
      {
        at: d.createdAt,
        envName: d.environmentId ? (envNameById.get(d.environmentId) ?? null) : null,
      },
    ]),
  );

  // View-models passés au board client (drag-and-drop). Dates sérialisées ISO.
  const projectVMs: ProjectVM[] = projects.map((p) => {
    const lastDeploy = lastDeployByProject.get(p.id);
    return {
      id: p.id,
      name: p.name,
      slug: p.slug,
      groupId: p.groupId,
      position: p.position,
      services: p._count.services,
      accounts: p._count.appAccounts,
      environments: p._count.environments,
      secrets: p.environments.reduce((n, e) => n + e._count.secrets, 0),
      status: {
        ciProvider: p.ciConnection?.provider ?? null,
        syncProviders: Array.from(
          new Set(
            p.environments
              .flatMap((e) => e.syncTargets.map((s) => s.ciConnection.provider))
              .filter(isSyncProvider),
          ),
        ),
        emailConfigured: p.emailConfig != null,
        emailVerified: p.emailConfig?.verified ?? false,
        backupEnabled: p.backupConfig?.enabled ?? false,
        apiCount: p._count.apis,
      },
      lastDeploy: lastDeploy
        ? { at: lastDeploy.at.toISOString(), envName: lastDeploy.envName }
        : null,
    };
  });

  // Édition (création de groupe via DnD) réservée aux DEV+ / admins org.
  const canEdit = isGlobalAdmin || isOrgAdmin || hasDevPrivileges(orgRole);

  return (
    <div className="page">
      <div className="page-content">
        <PageHero
          icon={<RiFolderOpenLine size={28} aria-hidden />}
          title={t("pageTitle")}
          subtitle={
            <>
              Organisation : <strong>{org?.name}</strong>
            </>
          }
        />

        <div className="create-row">
          <div className="create-col-main">
            <CreateProjectForm />
          </div>
          <div className="create-col-aside">
            <CreateGroupForm groups={groups} canEdit={canEdit} />
          </div>
        </div>

        {projects.length === 0 && groups.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-title">{t("empty")}</div>
            <div>{t("emptyHint")}</div>
          </div>
        ) : (
          <ProjectsBoard
            canEdit={canEdit}
            groups={groups}
            projects={projectVMs}
          />
        )}
      </div>
    </div>
  );
}
