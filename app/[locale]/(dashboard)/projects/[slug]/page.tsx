import { notFound } from "next/navigation";
import { Link } from "@/i18n/navigation";
import { RiFolderOpenLine } from "@remixicon/react";
import PageHero from "@/components/PageHero";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isPlatformAdmin, hasDevPrivileges } from "@/lib/roles";
import { getTranslations } from "next-intl/server";
import ProjectView from "./project-view";

export default async function ProjectPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const t = await getTranslations("projects");
  const session = await auth();
  if (!session?.user?.id) return null;

  const { slug } = await params;
  const isAdmin = isPlatformAdmin(session.user.role);

  const project = await prisma.project.findUnique({
    where: { slug },
    select: {
      id: true,
      name: true,
      slug: true,
      githubRepo: true,
      githubWorkflow: true,
      ciConnectionId: true,
      ciRepo: true,
      organizationId: true,
      members: { where: { userId: session.user.id } },
      organization: {
        select: {
          id: true,
          slug: true,
          rotationFeatureEnabled: true,
          members: { where: { userId: session.user.id } },
        },
      },
      environments: {
        orderBy: { name: "asc" },
        select: {
          id: true,
          name: true,
          url: true,
          serverId: true,
          deployPath: true,
          _count: { select: { secrets: true } },
        },
      },
    },
  });

  if (!project) notFound();

  const orgRole = project.organization.members[0]?.role;
  const projectMember = project.members[0];
  const orgSlug = project.organization.slug;

  // RBAC effectif (doit rester en sync avec lib/api.ts requireProjectMember) :
  //   1. Global ADMIN ou OrgADMIN/OWNER → OWNER implicite (priorité max).
  //   2. ProjectMember row avec hidden=true → 404.
  //   3. ProjectMember row avec hidden=false → role explicite.
  //   4. Pas de row + OrgRole=DEV → EDITOR implicite.
  //   5. Pas de row + OrgRole=MEMBER → 404 (MEMBER doit être ajouté explicitement).
  //   6. Pas OrgMember → 404.
  let role: "OWNER" | "EDITOR" | "VIEWER" | null = null;
  if (isAdmin || orgRole === "OWNER" || orgRole === "ADMIN") {
    role = "OWNER";
  } else if (projectMember) {
    if (projectMember.hidden) notFound();
    role = projectMember.role;
  } else if (hasDevPrivileges(orgRole)) {
    role = "EDITOR";
  }
  // MEMBER sans ProjectMember explicite → role reste null → notFound.
  if (!role) notFound();

  const canSeeAudit = role === "OWNER" || role === "EDITOR" || isAdmin;

  return (
    <div className="page">
      <div className="page-content">
        <div className="breadcrumb">
          <Link href="/projects">← Projets</Link>
        </div>
        <PageHero
          icon={<RiFolderOpenLine size={28} aria-hidden />}
          title={project.name}
          subtitle={
            <>
              <span
                className={`role role-${role.toLowerCase()}`}
                style={{ marginRight: 8 }}
              >
                {role}
              </span>
              <span className="code-mono">/{project.slug}</span>
            </>
          }
          actions={
            canSeeAudit ? (
              <Link
                href={`/projects/${project.slug}/audit`}
                className="btn btn-ghost btn-sm"
              >
                {t("auditLink")}
              </Link>
            ) : undefined
          }
        />

        <ProjectView
          projectName={project.name}
          slug={project.slug}
          orgSlug={orgSlug}
          githubRepo={project.githubRepo}
          githubWorkflow={project.githubWorkflow}
          ciConnectionId={project.ciConnectionId}
          ciRepo={project.ciRepo}
          environments={project.environments.map((e) => ({
            id: e.id,
            name: e.name,
            url: e.url,
            serverId: e.serverId,
            deployPath: e.deployPath,
            secretCount: e._count.secrets,
          }))}
          role={role}
          orgRole={orgRole}
        />
      </div>
    </div>
  );
}
