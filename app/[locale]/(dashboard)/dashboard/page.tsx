import Link from "next/link";
import {
  accessibleProjectsWhereByOrgSlug,
  resolveOrgRole,
} from "@/lib/project-access";
import { getTranslations } from "next-intl/server";
import type { useTranslations } from "next-intl";
import {
  RiBuilding2Line,
  RiDashboardLine,
  RiDoorOpenLine,
  RiFolderOpenLine,
  RiIdCardLine,
  RiKey2Line,
  RiLeafLine,
  RiPuzzle2Line,
  RiRocketLine,
  RiSafe2Line,
  RiServerLine,
  RiShieldCheckLine,
  RiShieldKeyholeLine,
  RiSparkling2Line,
  RiStackLine,
  RiToolsLine,
  RiUserLine,
  type RemixiconComponentType,
} from "@remixicon/react";
import PageHero from "@/components/PageHero";
import { auth } from "@/lib/auth";

type DashT = ReturnType<typeof useTranslations<"dashboard">>;
import { prisma } from "@/lib/prisma";
import { getCurrentOrgSlug } from "@/lib/api";
import { isPlatformAdmin } from "@/lib/roles";
import type { AccessAction } from "@prisma/client";
// Self-host : pas de billing/trial Stripe (BillingCard et TrialBanner
// supprimés en self-host — uniquement SaaS).
import ExtensionInstallPrompt from "./extension-install-prompt";
import PendingInvitations from "./pending-invitations";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const ACTIVITY_PAGE_SIZE = 5;

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{
    activity_page?: string;
    activity_filter?: string;
  }>;
}) {
  const t = await getTranslations("dashboard");
  const sp = await searchParams;
  const activityFilter = isFilterId(sp.activity_filter)
    ? sp.activity_filter
    : "all";
  const requestedPage = Math.max(1, Number.parseInt(sp.activity_page ?? "1", 10) || 1);

  const session = await auth();
  if (!session?.user?.id) return null;

  const orgSlug = await getCurrentOrgSlug(session.user.id);
  const org = orgSlug
    ? await prisma.organization.findUnique({
        where: { slug: orgSlug },
        select: {
          id: true,
          name: true,
          slug: true,
          _count: { select: { projects: true, members: true } },
        },
      })
    : null;

  // Filtre les projets accessibles a l'user (memes regles que /projects) :
  //   - Global ADMIN ou OrgADMIN+ → tous les projets
  //   - DEV → tous les projets de l'org sauf ceux marqués hidden=true
  //   - MEMBER → uniquement les projets où ProjectMember existe (et non hidden)
  const isGlobalAdmin = isPlatformAdmin(session.user.role);
  const orgMembership = org
    ? await prisma.orgMember.findFirst({
        where: {
          userId: session.user.id,
          organization: { slug: org.slug },
        },
        select: { role: true },
      })
    : null;
  const orgRole = orgMembership?.role ?? null;
  const isOrgAdmin = orgRole === "OWNER" || orgRole === "ADMIN";

  const projectsScoped = org
    ? await prisma.project.findMany({
        // Règles centralisées dans lib/project-access.ts (§4). Ne PAS re-dériver.
        where: accessibleProjectsWhereByOrgSlug(
          org.slug,
          session.user.id,
          resolveOrgRole(orgRole, session.user.role),
        ),
        select: { id: true },
      })
    : [];

  const projectIds = projectsScoped.map((p) => p.id);
  const projectCount = projectIds.length;

  // Filtres pour le bloc activite recente. "all" = pas de filtre.
  const filterActions =
    activityFilter === "all" ? null : actionsForFilter(activityFilter);
  // §2.8 — Portée de VISIBILITÉ des lectures d'audit (porté depuis la source).
  // Le flux lisait l'AccessLog de toute l'org sans filtre projet → un membre
  // voyait l'activité de projets qu'il n'a pas le droit d'ouvrir. OrgADMIN/OWNER
  // (et admin plateforme) voient tout ; les autres sont bornés à leurs projets
  // VISIBLES + leurs PROPRES actions non rattachées à un projet.
  const auditVisibilityScope =
    isGlobalAdmin || isOrgAdmin
      ? {}
      : {
          OR: [
            { projectId: { in: projectIds } },
            { projectId: null, actorUserId: session.user.id },
          ],
        };

  const activityWhere = org
    ? {
        organizationId: org.id,
        ...(filterActions ? { action: { in: filterActions } } : {}),
        ...auditVisibilityScope,
      }
    : null;

  // Stats supplementaires en parallele.
  const [
    myOrgsCount,
    tenantOrgsCount,
    tenantUsersCount,
    secretCount,
    recentDeploys,
    lastDeploysByProject,
    activityTotal,
    activityRows,
  ] = await Promise.all([
    prisma.orgMember.count({ where: { userId: session.user.id } }),
    // Total orgs et users distincts dans le tenant — pour la card "Plan".
    prisma.organization.count(),
    prisma.user.count(),
    org && projectIds.length
      ? prisma.secret.count({
          where: { environment: { projectId: { in: projectIds } } },
        })
      : Promise.resolve(0),
    org && projectIds.length
      ? prisma.accessLog.findMany({
          where: {
            organizationId: org.id,
            action: "DEPLOY_AUTHORIZED",
            createdAt: { gte: new Date(Date.now() - THIRTY_DAYS_MS) },
            projectId: { in: projectIds },
          },
          distinct: ["projectId"],
          select: { projectId: true },
        })
      : Promise.resolve([] as { projectId: string | null }[]),
    // 3 derniers projets deployes : groupe distinct par projectId, ordonne
    // par createdAt desc, take 3.
    org && projectIds.length
      ? prisma.accessLog.findMany({
          where: {
            organizationId: org.id,
            action: "DEPLOY_AUTHORIZED",
            projectId: { in: projectIds },
          },
          orderBy: { createdAt: "desc" },
          distinct: ["projectId"],
          take: 3,
          select: {
            projectId: true,
            environmentId: true,
            createdAt: true,
            project: { select: { id: true, name: true, slug: true } },
          },
        })
      : Promise.resolve([] as LastDeployRow[]),
    activityWhere
      ? prisma.accessLog.count({ where: activityWhere })
      : Promise.resolve(0),
    activityWhere
      ? prisma.accessLog.findMany({
          where: activityWhere,
          orderBy: { createdAt: "desc" },
          skip: (requestedPage - 1) * ACTIVITY_PAGE_SIZE,
          take: ACTIVITY_PAGE_SIZE,
          select: {
            id: true,
            action: true,
            actorUserEmail: true,
            actorTokenName: true,
            secretKey: true,
            metadata: true,
            createdAt: true,
            project: { select: { name: true, slug: true } },
          },
        })
      : Promise.resolve([] as RecentActivityRow[]),
  ]);

  const activeProjectCount = recentDeploys.length;
  const activityTotalPages = Math.max(
    1,
    Math.ceil(activityTotal / ACTIVITY_PAGE_SIZE),
  );
  const activityPage = Math.min(requestedPage, activityTotalPages);

  // Pour les "Projets recents", on a juste besoin du nom de l'env du dernier deploy.
  const recentDeployEnvIds = lastDeploysByProject
    .map((d) => d.environmentId)
    .filter((id): id is string => Boolean(id));

  const recentProjectEnvs = recentDeployEnvIds.length
    ? await prisma.environment.findMany({
        where: { id: { in: recentDeployEnvIds } },
        select: { id: true, name: true },
      })
    : [];
  const envNameById = new Map(recentProjectEnvs.map((e) => [e.id, e.name]));

  const recentProjects: RecentProjectRow[] = lastDeploysByProject
    .filter((d) => d.project)
    .map((d) => ({
      id: d.project!.id,
      name: d.project!.name,
      slug: d.project!.slug,
      lastDeployAt: d.createdAt,
      lastEnvName: d.environmentId
        ? (envNameById.get(d.environmentId) ?? null)
        : null,
    }));

  return (
    <div className="page">
      <div className="page-content">
        <PendingInvitations />
        <PageHero
          icon={<RiDashboardLine size={28} aria-hidden />}
          title={t("page.title")}
          subtitle={
            <>
              {t("page.connectedAs")} <strong>{session.user.email}</strong> (
              {session.user.role})
              {org ? (
                <>
                  {" · "}
                  {t("page.organisation")}{" "}
                  <Link href={`/orgs/${org.slug}`} className="text-accent">
                    {org.name}
                  </Link>
                </>
              ) : null}
            </>
          }
        />

        {!org && (
          <>
            <div className="empty-state">
              <div className="empty-state-title">{t("page.noOrg")}</div>
              <div>{t("page.noOrgHelp")}</div>
            </div>
            <div className="flex gap-3 flex-wrap">
              <ExtensionInstallPrompt />
            </div>
          </>
        )}

        {org && (
          <>
            <div
              className="flex gap-3 flex-wrap"
              style={{ marginBottom: 24 }}
            >
              <Link href="/projects" className="btn btn-primary">
                {t("page.btnProjects")}
              </Link>
              <Link href={`/orgs/${org.slug}`} className="btn btn-ghost">
                {t("page.btnManageOrg")}
              </Link>
              <Link href="/vault" className="btn btn-ghost">
                <RiSafe2Line size={14} aria-hidden /> {t("page.btnVault")}
              </Link>
              <ExtensionInstallPrompt />
            </div>

            {recentProjects.length > 0 && (
              <RecentProjects items={recentProjects} t={t} />
            )}

            <div
              style={{
                display: "grid",
                gridTemplateColumns:
                  "repeat(auto-fit, minmax(min(100%, 220px), 1fr))",
                gap: 14,
                marginBottom: 24,
              }}
            >
              <CountCard
                primary={{
                  value: org._count.members,
                  label: t("countCard.members"),
                }}
                secondary={{
                  value: myOrgsCount,
                  label: t("countCard.organisations"),
                }}
              />
              <CountCard
                primary={{
                  value: `${activeProjectCount} / ${projectCount}`,
                  label: t("countCard.activeProjects"),
                }}
                secondary={{
                  value: secretCount,
                  label: t("countCard.secrets"),
                }}
              />
              {/* BillingCard supprimé en self-host (pas de plans payants). */}
            </div>

            {/* TrialBanner supprimé en self-host (pas de période d'essai). */}

            <RecentActivity
              items={activityRows}
              filter={activityFilter}
              page={activityPage}
              totalPages={activityTotalPages}
              total={activityTotal}
              t={t}
              filterDefs={getFilterDefs(t)}
              actionLabelsMap={getActionLabels(t)}
            />
          </>
        )}
      </div>
    </div>
  );
}

// Card empilant 2 stats : chacune a son eyebrow orange (majuscules,
// couleur accent) en label, puis la valeur. Le label fait office de
// titre — pas d'eyebrow séparé pour la card entière.
function CountCard({
  primary,
  secondary,
}: {
  primary: { value: string | number; label: string };
  secondary?: { value: string | number; label: string };
}) {
  return (
    <div
      className="card"
      style={{
        padding: 20,
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <div>
        <div className="section-eyebrow">{primary.label}</div>
        <div style={{ fontSize: 28, fontWeight: 600, lineHeight: 1.1 }}>
          {primary.value}
        </div>
      </div>
      {secondary && (
        <div>
          <div className="section-eyebrow">{secondary.label}</div>
          <div style={{ fontSize: 22, fontWeight: 600, lineHeight: 1.1 }}>
            {secondary.value}
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Projets récents (3 derniers projets déployés)
// ─────────────────────────────────────────────────────────────────────

type LastDeployRow = {
  projectId: string | null;
  environmentId: string | null;
  createdAt: Date;
  project: { id: string; name: string; slug: string } | null;
};

type RecentProjectRow = {
  id: string;
  name: string;
  slug: string;
  lastDeployAt: Date;
  lastEnvName: string | null;
};

function RecentProjects({ items, t }: { items: RecentProjectRow[]; t: DashT }) {
  return (
    <section className="section">
      <div className="section-header">
        <h2 className="section-title">{t("recentProjects")}</h2>
      </div>
      <div className="projects-grid" style={{ marginBottom: 24 }}>
        {items.map((p) => (
          <Link
            key={p.id}
            href={`/projects/${p.slug}`}
            className="card"
            style={{
              padding: 20,
              display: "block",
              textDecoration: "none",
              color: "inherit",
              position: "relative",
            }}
          >
            <span
              title={p.lastDeployAt.toISOString()}
              style={{
                position: "absolute",
                top: 12,
                right: 12,
                fontSize: 11,
                fontWeight: 500,
                padding: "3px 8px",
                borderRadius: 999,
                background: "#fde9c8",
                color: "#8a4b00",
                whiteSpace: "nowrap",
              }}
            >
              {relativeTime(p.lastDeployAt, t)}
            </span>
            <div
              style={{
                fontSize: 16,
                fontWeight: 600,
                marginBottom: 12,
                paddingRight: 80,
              }}
            >
              {p.name}
            </div>
            {p.lastEnvName && (
              <div className="help" style={{ fontSize: 13 }}>
                <strong>{p.lastEnvName}</strong>
              </div>
            )}
          </Link>
        ))}
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Activité récente
// ─────────────────────────────────────────────────────────────────────

type RecentActivityRow = {
  id: string;
  action: AccessAction;
  actorUserEmail: string | null;
  actorTokenName: string | null;
  secretKey: string | null;
  metadata: unknown;
  createdAt: Date;
  project: { name: string; slug: string } | null;
};

// ─── Filtres ─────────────────────────────────────────────────────────

type FilterId =
  | "all"
  | "secrets"
  | "deploy"
  | "project"
  | "env"
  | "member"
  | "token"
  | "org"
  | "service"
  | "account"
  | "server"
  | "policy"
  | "login"
  | "2fa"
  | "plugin";

const FILTER_DEFS: { id: FilterId; Icon: RemixiconComponentType }[] = [
  { id: "all", Icon: RiSparkling2Line },
  { id: "secrets", Icon: RiKey2Line },
  { id: "deploy", Icon: RiRocketLine },
  { id: "project", Icon: RiFolderOpenLine },
  { id: "env", Icon: RiLeafLine },
  { id: "member", Icon: RiUserLine },
  { id: "token", Icon: RiShieldKeyholeLine },
  { id: "org", Icon: RiBuilding2Line },
  { id: "service", Icon: RiToolsLine },
  { id: "account", Icon: RiIdCardLine },
  { id: "server", Icon: RiServerLine },
  { id: "policy", Icon: RiStackLine },
  { id: "login", Icon: RiDoorOpenLine },
  { id: "2fa", Icon: RiShieldCheckLine },
  { id: "plugin", Icon: RiPuzzle2Line },
];

function getFilterDefs(
  t: DashT,
): { id: FilterId; label: string; Icon: RemixiconComponentType }[] {
  return FILTER_DEFS.map((def) => ({
    ...def,
    label: t(`filters.${def.id}` as Parameters<DashT>[0]),
  }));
}

function isFilterId(v: unknown): v is FilterId {
  return (
    typeof v === "string" && FILTER_DEFS.some((f) => f.id === v)
  );
}

// Liste exhaustive des AccessAction. Garder en sync avec
// prisma/tenant-schema.prisma:enum AccessAction. Sert a deriver les sets
// d'actions pour chaque filtre cote DB (where: { action: { in: [...] } }).
const ALL_ACCESS_ACTIONS: AccessAction[] = [
  "SECRET_CREATE",
  "SECRET_UPDATE",
  "SECRET_DELETE",
  "SECRET_REVEAL",
  "SECRET_FETCH_BULK",
  "TOKEN_CREATE",
  "TOKEN_REVOKE",
  "TOKEN_USE_FAILED",
  "MEMBER_INVITE",
  "MEMBER_INVITE_ACCEPT",
  "MEMBER_INVITE_DECLINE",
  "MEMBER_ROLE_CHANGE",
  "MEMBER_REMOVE",
  "PROJECT_CREATE",
  "PROJECT_UPDATE",
  "PROJECT_DELETE",
  "PROJECT_MEMBER_VISIBILITY_CHANGE",
  "PROJECT_MEMBER_ROLE_CHANGE",
  "ENVIRONMENT_CREATE",
  "ENVIRONMENT_UPDATE",
  "ENVIRONMENT_DELETE",
  "ORG_CREATE",
  "ORG_UPDATE",
  "ORG_DELETE",
  "ORG_SECRET_CREATE",
  "ORG_SECRET_UPDATE",
  "ORG_SECRET_DELETE",
  "ORG_SECRET_REVEAL",
  "SERVICE_CREATE",
  "SERVICE_UPDATE",
  "SERVICE_DELETE",
  "SERVICE_REVEAL",
  "ACCOUNT_CREATE",
  "ACCOUNT_UPDATE",
  "ACCOUNT_DELETE",
  "ACCOUNT_REVEAL",
  "REDEPLOY_TRIGGERED",
  "COMPOSE_FETCHED",
  "LOGIN_SUCCESS",
  "LOGIN_FAILURE",
  "TWO_FACTOR_ENABLED",
  "TWO_FACTOR_DISABLED",
  "TWO_FACTOR_SUCCESS",
  "TWO_FACTOR_FAILURE",
  "BACKUP_CODE_USED",
  "SERVER_CREATE",
  "SERVER_UPDATE",
  "SERVER_DELETE",
  "POLICY_CREATE",
  "POLICY_UPDATE",
  "POLICY_DELETE",
  "DEPLOY_AUTHORIZED",
  "DEPLOY_DENIED",
  "PLUGIN_AUTH_SUCCESS",
  "PLUGIN_AUTH_FAILURE",
  "PLUGIN_CREDENTIALS_FETCH",
  "PLUGIN_TOKEN_REVOKED",
  "VAULT_ENTRY_CREATE",
  "VAULT_ENTRY_UPDATE",
  "VAULT_ENTRY_DELETE",
  "VAULT_ENTRY_REVEAL",
  "VAULT_ENTRY_MOVE",
  "VAULT_COLLECTION_CREATE",
  "VAULT_COLLECTION_DELETE",
  "VAULT_MEMBER_ADD",
  "VAULT_MEMBER_REMOVE",
  "VAULT_MEMBER_ROLE_CHANGE",
  "SHARE_CREATE",
  "SHARE_CONSUME",
  "SHARE_REVOKE",
  "SHARE_SEND_EMAIL",
  "SHARE_PASSWORD_FAILURE",
];

function filterMatchesAction(filterId: FilterId, action: AccessAction): boolean {
  switch (filterId) {
    case "all":
      return true;
    case "secrets":
      return action.startsWith("SECRET_") || action.startsWith("ORG_SECRET_");
    case "deploy":
      return (
        action.startsWith("DEPLOY_") ||
        action === "REDEPLOY_TRIGGERED" ||
        action === "COMPOSE_FETCHED"
      );
    case "project":
      return action.startsWith("PROJECT_");
    case "env":
      return action.startsWith("ENVIRONMENT_");
    case "member":
      return action.startsWith("MEMBER_");
    case "token":
      return action.startsWith("TOKEN_");
    case "org":
      return action.startsWith("ORG_") && !action.startsWith("ORG_SECRET_");
    case "service":
      return action.startsWith("SERVICE_");
    case "account":
      return action.startsWith("ACCOUNT_");
    case "server":
      return action.startsWith("SERVER_");
    case "policy":
      return action.startsWith("POLICY_");
    case "login":
      return action.startsWith("LOGIN_");
    case "2fa":
      return action.startsWith("TWO_FACTOR_") || action === "BACKUP_CODE_USED";
    case "plugin":
      return action.startsWith("PLUGIN_");
  }
}

function actionsForFilter(filterId: FilterId): AccessAction[] {
  return ALL_ACCESS_ACTIONS.filter((a) => filterMatchesAction(filterId, a));
}

function buildActivityHref(filter: FilterId, page: number): string {
  const params = new URLSearchParams();
  if (filter !== "all") params.set("activity_filter", filter);
  if (page > 1) params.set("activity_page", String(page));
  const qs = params.toString();
  // Ancrage #activity pour eviter de scroller en haut de page apres clic.
  return `/dashboard${qs ? `?${qs}` : ""}#activity`;
}

function RecentActivity({
  items,
  filter,
  page,
  totalPages,
  total,
  t,
  filterDefs,
  actionLabelsMap,
}: {
  items: RecentActivityRow[];
  filter: FilterId;
  page: number;
  totalPages: number;
  total: number;
  t: DashT;
  filterDefs: { id: FilterId; label: string; Icon: RemixiconComponentType }[];
  actionLabelsMap: Partial<Record<AccessAction, string>>;
}) {
  const startIdx = total === 0 ? 0 : (page - 1) * ACTIVITY_PAGE_SIZE + 1;
  const endIdx = Math.min(total, page * ACTIVITY_PAGE_SIZE);

  return (
    <section className="section" id="activity">
      <div className="section-header">
        <h2 className="section-title">{t("activity.title")}</h2>
        {total > 0 && (
          <span className="help" style={{ fontSize: 12 }}>
            {t("activity.pagination", { start: startIdx, end: endIdx, total })}
          </span>
        )}
      </div>

      <div
        className="flex flex-wrap gap-2"
        style={{ marginBottom: 12 }}
        role="tablist"
        aria-label={t("activity.ariaLabel")}
      >
        {filterDefs.map((def) => {
          const active = def.id === filter;
          const { Icon } = def;
          return (
            <Link
              key={def.id}
              href={buildActivityHref(def.id, 1)}
              className={`btn btn-sm ${active ? "btn-primary" : "btn-ghost"}`}
              role="tab"
              aria-selected={active}
              title={def.label}
              style={{ scrollMargin: 8 }}
            >
              <Icon size={14} aria-hidden />
              {def.label}
            </Link>
          );
        })}
      </div>

      {items.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-title">
            {filter === "all"
              ? t("activity.emptyAll")
              : t("activity.emptyFiltered")}
          </div>
        </div>
      ) : (
        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {items.map((item, idx) => (
              <li
                key={item.id}
                style={{
                  display: "grid",
                  gridTemplateColumns: "32px 1fr auto",
                  alignItems: "center",
                  gap: 12,
                  padding: "12px 16px",
                  borderTop: idx === 0 ? "none" : "1px solid var(--border)",
                }}
              >
                <span
                  aria-hidden
                  style={{ fontSize: 18, textAlign: "center" }}
                >
                  {actionIcon(item.action)}
                </span>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 500 }}>
                    {actionLabel(item.action, actionLabelsMap)}
                  </div>
                  <div
                    className="help"
                    style={{
                      fontSize: 12,
                      marginTop: 2,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {formatContext(item)}
                    {formatActor(item) && (
                      <>
                        {" · "}
                        {formatActor(item)}
                      </>
                    )}
                  </div>
                </div>
                <span
                  className="help"
                  style={{ fontSize: 12, whiteSpace: "nowrap" }}
                  title={item.createdAt.toISOString()}
                >
                  {relativeTime(item.createdAt, t)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {totalPages > 1 && (
        <div
          className="flex items-center gap-2"
          style={{ marginTop: 12, justifyContent: "flex-end" }}
        >
          {page > 1 ? (
            <Link
              href={buildActivityHref(filter, page - 1)}
              className="btn btn-ghost btn-sm"
            >
              {t("activity.prev")}
            </Link>
          ) : (
            <button
              type="button"
              disabled
              className="btn btn-ghost btn-sm"
              style={{ opacity: 0.4 }}
            >
              {t("activity.prev")}
            </button>
          )}
          <span className="help" style={{ fontSize: 12 }}>
            {t("activity.pageOf", { page, total: totalPages })}
          </span>
          {page < totalPages ? (
            <Link
              href={buildActivityHref(filter, page + 1)}
              className="btn btn-ghost btn-sm"
            >
              {t("activity.next")}
            </Link>
          ) : (
            <button
              type="button"
              disabled
              className="btn btn-ghost btn-sm"
              style={{ opacity: 0.4 }}
            >
              {t("activity.next")}
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function actionIcon(action: AccessAction): string {
  if (action.startsWith("SECRET_") || action.startsWith("ORG_SECRET_"))
    return "🔑";
  if (action.startsWith("DEPLOY_") || action === "REDEPLOY_TRIGGERED")
    return "🚀";
  if (action.endsWith("_CREATE")) return "➕";
  if (action.endsWith("_DELETE")) return "🗑";
  if (action.endsWith("_UPDATE")) return "✏️";
  if (action.startsWith("MEMBER_")) return "👤";
  if (action.startsWith("TOKEN_")) return "🔐";
  if (action.startsWith("PROJECT_")) return "📁";
  if (action.startsWith("ENVIRONMENT_")) return "🌿";
  if (action.startsWith("ORG_")) return "🏢";
  if (action.startsWith("SERVICE_")) return "🧰";
  if (action.startsWith("ACCOUNT_")) return "🪪";
  if (action.startsWith("SERVER_")) return "🖥";
  if (action.startsWith("POLICY_")) return "📜";
  if (action.startsWith("LOGIN_")) return "🚪";
  if (action.startsWith("TWO_FACTOR_") || action === "BACKUP_CODE_USED")
    return "🛡";
  if (action.startsWith("PLUGIN_")) return "🧩";
  if (action === "COMPOSE_FETCHED") return "📄";
  return "•";
}

function getActionLabels(t: DashT): Partial<Record<AccessAction, string>> {
  return {
    SECRET_CREATE: t("actions.SECRET_CREATE"),
    SECRET_UPDATE: t("actions.SECRET_UPDATE"),
    SECRET_DELETE: t("actions.SECRET_DELETE"),
    SECRET_REVEAL: t("actions.SECRET_REVEAL"),
    SECRET_FETCH_BULK: t("actions.SECRET_FETCH_BULK"),
    TOKEN_CREATE: t("actions.TOKEN_CREATE"),
    TOKEN_REVOKE: t("actions.TOKEN_REVOKE"),
    TOKEN_USE_FAILED: t("actions.TOKEN_USE_FAILED"),
    MEMBER_INVITE: t("actions.MEMBER_INVITE"),
    MEMBER_INVITE_ACCEPT: t("actions.MEMBER_INVITE_ACCEPT"),
    MEMBER_INVITE_DECLINE: t("actions.MEMBER_INVITE_DECLINE"),
    MEMBER_ROLE_CHANGE: t("actions.MEMBER_ROLE_CHANGE"),
    MEMBER_REMOVE: t("actions.MEMBER_REMOVE"),
    PROJECT_CREATE: t("actions.PROJECT_CREATE"),
    PROJECT_UPDATE: t("actions.PROJECT_UPDATE"),
    PROJECT_DELETE: t("actions.PROJECT_DELETE"),
    PROJECT_MEMBER_VISIBILITY_CHANGE: t("actions.PROJECT_MEMBER_VISIBILITY_CHANGE"),
    PROJECT_MEMBER_ROLE_CHANGE: t("actions.PROJECT_MEMBER_ROLE_CHANGE"),
    ENVIRONMENT_CREATE: t("actions.ENVIRONMENT_CREATE"),
    ENVIRONMENT_UPDATE: t("actions.ENVIRONMENT_UPDATE"),
    ENVIRONMENT_DELETE: t("actions.ENVIRONMENT_DELETE"),
    ORG_CREATE: t("actions.ORG_CREATE"),
    ORG_UPDATE: t("actions.ORG_UPDATE"),
    ORG_DELETE: t("actions.ORG_DELETE"),
    ORG_SECRET_CREATE: t("actions.ORG_SECRET_CREATE"),
    ORG_SECRET_UPDATE: t("actions.ORG_SECRET_UPDATE"),
    ORG_SECRET_DELETE: t("actions.ORG_SECRET_DELETE"),
    ORG_SECRET_REVEAL: t("actions.ORG_SECRET_REVEAL"),
    SERVICE_CREATE: t("actions.SERVICE_CREATE"),
    SERVICE_UPDATE: t("actions.SERVICE_UPDATE"),
    SERVICE_DELETE: t("actions.SERVICE_DELETE"),
    SERVICE_REVEAL: t("actions.SERVICE_REVEAL"),
    ACCOUNT_CREATE: t("actions.ACCOUNT_CREATE"),
    ACCOUNT_UPDATE: t("actions.ACCOUNT_UPDATE"),
    ACCOUNT_DELETE: t("actions.ACCOUNT_DELETE"),
    ACCOUNT_REVEAL: t("actions.ACCOUNT_REVEAL"),
    REDEPLOY_TRIGGERED: t("actions.REDEPLOY_TRIGGERED"),
    COMPOSE_FETCHED: t("actions.COMPOSE_FETCHED"),
    LOGIN_SUCCESS: t("actions.LOGIN_SUCCESS"),
    LOGIN_FAILURE: t("actions.LOGIN_FAILURE"),
    TWO_FACTOR_ENABLED: t("actions.TWO_FACTOR_ENABLED"),
    TWO_FACTOR_DISABLED: t("actions.TWO_FACTOR_DISABLED"),
    TWO_FACTOR_SUCCESS: t("actions.TWO_FACTOR_SUCCESS"),
    TWO_FACTOR_FAILURE: t("actions.TWO_FACTOR_FAILURE"),
    BACKUP_CODE_USED: t("actions.BACKUP_CODE_USED"),
    SERVER_CREATE: t("actions.SERVER_CREATE"),
    SERVER_UPDATE: t("actions.SERVER_UPDATE"),
    SERVER_DELETE: t("actions.SERVER_DELETE"),
    POLICY_CREATE: t("actions.POLICY_CREATE"),
    POLICY_UPDATE: t("actions.POLICY_UPDATE"),
    POLICY_DELETE: t("actions.POLICY_DELETE"),
    DEPLOY_AUTHORIZED: t("actions.DEPLOY_AUTHORIZED"),
    DEPLOY_DENIED: t("actions.DEPLOY_DENIED"),
    PLUGIN_AUTH_SUCCESS: t("actions.PLUGIN_AUTH_SUCCESS"),
    PLUGIN_AUTH_FAILURE: t("actions.PLUGIN_AUTH_FAILURE"),
  };
}

function actionLabel(
  action: AccessAction,
  labels: Partial<Record<AccessAction, string>>,
): string {
  return labels[action] ?? action.replace(/_/g, " ").toLowerCase();
}

function formatContext(item: RecentActivityRow): string {
  const parts: string[] = [];
  if (item.project) parts.push(item.project.name);
  if (item.secretKey) parts.push(item.secretKey);
  else if (
    item.metadata &&
    typeof item.metadata === "object" &&
    !Array.isArray(item.metadata)
  ) {
    const meta = item.metadata as Record<string, unknown>;
    const env = typeof meta.environment === "string" ? meta.environment : null;
    const key = typeof meta.key === "string" ? meta.key : null;
    if (env) parts.push(env);
    if (key) parts.push(key);
  }
  return parts.length > 0 ? parts.join(" / ") : "—";
}

function formatActor(item: RecentActivityRow): string | null {
  if (item.actorUserEmail) return truncateEmail(item.actorUserEmail);
  if (item.actorTokenName) return `token: ${item.actorTokenName}`;
  return null;
}

function truncateEmail(email: string, max = 22): string {
  if (email.length <= max) return email;
  const at = email.indexOf("@");
  if (at < 0) return email.slice(0, max - 1) + "…";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  // Garde le local intact si possible, tronque le domain.
  const remaining = max - local.length - 1;
  if (remaining < 4) {
    // local trop long → tronque le local aussi
    return local.slice(0, Math.max(1, max - 5)) + "…@" + domain.slice(0, 3) + "…";
  }
  return local + "@" + domain.slice(0, remaining - 1) + "…";
}

function relativeTime(date: Date, t: DashT): string {
  const diffMs = Date.now() - date.getTime();
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return t("time.justNow");
  const min = Math.floor(sec / 60);
  if (min < 60) return t("time.minutesAgo", { n: min });
  const hr = Math.floor(min / 60);
  if (hr < 24) return t("time.hoursAgo", { n: hr });
  const day = Math.floor(hr / 24);
  if (day < 30) return t("time.daysAgo", { n: day });
  const month = Math.floor(day / 30);
  if (month < 12) return t("time.monthsAgo", { n: month });
  return t("time.yearsAgo", { n: Math.floor(day / 365) });
}
