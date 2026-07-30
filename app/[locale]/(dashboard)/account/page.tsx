// /account — page de gestion du compte (self-host, mono-tenant).
//
// Server component : infos du compte + export RGPD. Pas de billing /
// abonnement / quotas (édition SaaS uniquement).

import { Link } from "@/i18n/navigation";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isPlatformAdmin } from "@/lib/roles";
import ExportButton from "./export-button";
import DeleteMyAccountPanel from "./delete-my-account-panel";

export default async function AccountPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const t = await getTranslations("account");
  const session = await auth();
  if (!session?.user?.id) redirect(`/${locale}/login`);

  const platformAdmin = isPlatformAdmin(session.user.role);

  // Mono-tenant : org principale (affichage) + memberships de l'user
  // (rôle + scope export). Aucune donnée billing.
  const [primary, myMemberships] = await Promise.all([
    prisma.organization.findFirst({
      where: { isPrimary: true },
      select: { name: true, slug: true },
    }),
    prisma.orgMember.findMany({
      where: { userId: session.user.id },
      select: { role: true },
    }),
  ]);

  const accountName = primary?.name ?? session.user.tenantSlug ?? "—";
  const accountSlug = primary?.slug ?? session.user.tenantSlug ?? "—";

  const isOwner =
    platformAdmin || myMemberships.some((m) => m.role === "OWNER");

  // Export : owner/admin de n'importe quelle org → export complet ; les
  // autres membres → coffre personnel uniquement.
  const isPrivilegedAnyOrg =
    platformAdmin ||
    myMemberships.some((m) => m.role === "OWNER" || m.role === "ADMIN");

  return (
    <div className="page">
      <div className="page-content">
        <div className="page-header">
          <div>
            <h1 className="page-title">{t("pageTitle")}</h1>
            <div className="page-subtitle">
              {accountName} ·{" "}
              <span style={{ fontFamily: "var(--font-mono, monospace)" }}>
                {accountSlug}
              </span>
            </div>
          </div>
        </div>

        {/* ─── Infos du compte (1ère carte, bord coloré) ──────────── */}
        <section className="section">
          <div className="section-header">
            <h2 className="section-title">{t("accountInfoSection")}</h2>
          </div>
          <div
            className="card"
            style={{ padding: 20, border: "1px solid var(--accent-soft)", display: "grid", gap: 10 }}
          >
            <div style={{ display: "flex", gap: 12, fontSize: 14, flexWrap: "wrap" }}>
              <span className="help" style={{ minWidth: 120 }}>{t("emailLabel")}</span>
              <span>{session.user.email ?? "—"}</span>
            </div>
            <div style={{ display: "flex", gap: 12, fontSize: 14, flexWrap: "wrap" }}>
              <span className="help" style={{ minWidth: 120 }}>{t("clientLabel")}</span>
              <span>
                {accountName}{" "}
                <span style={{ fontFamily: "var(--font-mono, monospace)", color: "var(--muted)" }}>
                  ({accountSlug})
                </span>
              </span>
            </div>
            <div style={{ display: "flex", gap: 12, fontSize: 14, flexWrap: "wrap" }}>
              <span className="help" style={{ minWidth: 120 }}>{t("roleLabel")}</span>
              <span>{isOwner ? t("roleOwner") : t("roleMember")}</span>
            </div>
          </div>
        </section>

        {/* ─── Section Mes données (RGPD) ─────────────────────────── */}
        {/* Visible par tous : owner/admin (de n'importe quelle org) exportent
            leurs données complètes (les leurs + co-détenues) ; les autres
            membres uniquement leur coffre personnel. */}
        <section className="section">
          <div className="section-header">
            <h2 className="section-title">{t("myDataSection")}</h2>
          </div>

          <div className="card" style={{ padding: 24 }}>
            <ExportButton personal={!isPrivilegedAnyOrg} />
          </div>
        </section>

        {/* ─── Zone dangereuse : suppression de SON PROPRE compte ─── */}
        {/* Jumeau de la route app/api/me/delete (portée §A.7). Le panneau lui-même
            coule verbatim de la source : il n'a aucune dépendance SaaS. */}
        <DeleteMyAccountPanel />

        <div style={{ marginTop: 24 }}>
          <Link href="/dashboard" className="btn btn-ghost">
            {t("backBtn")}
          </Link>
        </div>
      </div>
    </div>
  );
}
