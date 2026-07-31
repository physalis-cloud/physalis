import { notFound } from "next/navigation";
import { Link } from "@/i18n/navigation";
import { RiSettings3Line } from "@remixicon/react";
import PageHero from "@/components/PageHero";
import { getTranslations } from "next-intl/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isPlatformAdmin, hasDevPrivileges } from "@/lib/roles";
import OrgPanels from "./org-panels";

export default async function OrgPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const t = await getTranslations("orgs");
  const session = await auth();
  if (!session?.user?.id) return null;

  const { slug } = await params;
  const isAdmin = isPlatformAdmin(session.user.role);

  const org = await prisma.organization.findUnique({
    where: { slug },
    select: {
      id: true,
      name: true,
      slug: true,
      isPrimary: true,
      rotationFeatureEnabled: true,
      members: { where: { userId: session.user.id }, select: { role: true } },
      _count: { select: { projects: true, members: true } },
    },
  });
  if (!org) notFound();

  const role = org.members[0]?.role ?? (isAdmin ? "OWNER" : null);
  if (!role) notFound();

  // Audit log accessible à DEV+. ADMIN/OWNER voient tout l'org, DEV ne voit
  // que ses propres actions sur les projets accessibles (filtré côté API).
  const canSeeAudit =
    role === "OWNER" || role === "ADMIN" || hasDevPrivileges(role);

  return (
    <div className="page">
      <div className="page-content">
        <div className="breadcrumb">
          <Link href="/dashboard">← Tableau de bord</Link>
        </div>
        <PageHero
          icon={<RiSettings3Line size={28} aria-hidden />}
          title={org.name}
          subtitle={
            <>
              <span
                className={`role role-${role.toLowerCase()}`}
                style={{ marginRight: 8 }}
              >
                {role}
              </span>
              {t("pageStats", {
                projects: org._count.projects,
                members: org._count.members,
              })}
            </>
          }
          actions={
            canSeeAudit ? (
              <Link
                href={`/orgs/${org.slug}/audit`}
                className="btn btn-ghost btn-sm"
              >
                Audit
              </Link>
            ) : undefined
          }
        />

        <OrgPanels
          slug={org.slug}
          orgName={org.name}
          role={role}
          isPrimary={org.isPrimary}
          // Rotation = feature exclue du build self-host (org-rotation-panel +
          // rotation-cron denylistés) → toujours désactivée, quel que soit le
          // flag en base.
          rotationFeatureEnabled={false}
          rotationPaidPlan={false}
        />
      </div>
    </div>
  );
}
