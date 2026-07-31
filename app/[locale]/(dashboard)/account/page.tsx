// /account — page de gestion du compte (self-host, mono-tenant).
//
// Server component : infos du compte + sécurité personnelle (2FA, jetons,
// sessions plugin) + export RGPD. Pas de billing / abonnement / quotas
// (édition SaaS uniquement), pas de SSO / social login (différé en self-host).

import { Link } from "@/i18n/navigation";
import { RiAccountCircleLine } from "@remixicon/react";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import PageHero from "@/components/PageHero";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isPlatformAdmin } from "@/lib/roles";
import ExportButton from "./export-button";
import SecurityPanel from "./security-panel";
import UserTokensPanel from "./user-tokens-panel";
import PluginSessionsPanel from "./plugin-sessions-panel";
import DeleteMyAccountPanel from "./delete-my-account-panel";
import pkg from "@/package.json";

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
  // (rôle + scope export) + état 2FA. Aucune donnée billing.
  const [primary, myMemberships, me] = await Promise.all([
    // `isPrimary` marque l'org créée au signup / au bootstrap. Repli sur la
    // plus ancienne org : les installs antérieures à la migration de backfill
    // n'ont aucune ligne marquée.
    prisma.organization.findFirst({
      where: { isPrimary: true },
      select: { name: true, slug: true },
    }),
    prisma.orgMember.findMany({
      where: { userId: session.user.id },
      select: { role: true },
    }),
    prisma.user.findUnique({
      where: { id: session.user.id },
      select: { twoFactorEnabled: true, backupCodes: true },
    }),
  ]);

  const fallbackOrg = primary
    ? null
    : await prisma.organization.findFirst({
        orderBy: { createdAt: "asc" },
        select: { name: true, slug: true },
      });
  const org = primary ?? fallbackOrg;

  const accountName = org?.name ?? "—";
  const accountSlug = org?.slug ?? "—";

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
        <PageHero
          icon={<RiAccountCircleLine size={28} aria-hidden />}
          title={t("pageTitle")}
          subtitle={
            <>
              {accountName} ·{" "}
              <span style={{ fontFamily: "var(--font-mono, monospace)" }}>
                {accountSlug}
              </span>
            </>
          }
          actions={
            <span
              className="code-mono"
              style={{
                padding: "4px 10px",
                borderRadius: 6,
                background: "#fff",
                color: "var(--muted)",
                border: "1px solid var(--border)",
                fontSize: 12,
                whiteSpace: "nowrap",
              }}
            >
              {t("versionInfo", { version: pkg.version })}
            </span>
          }
        />

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

        {/* ─── Sécurité & accès personnels (2FA, jetons, sessions) ─── */}
        {/* Jumeau de la section source, moins SsoPanel/SocialLoginPanel
            (cluster SSO/social denylisté du build self-host). Les panneaux
            eux-mêmes coulent verbatim : ils tapent /api/me/2fa,
            /api/user-tokens et /api/plugin/tokens, tous présents ici. */}
        <section className="section">
          <div className="section-header">
            <h2 className="section-title">{t("securitySection")}</h2>
          </div>
          <div className="flex flex-col gap-4">
            {me && (
              <SecurityPanel
                initialEnabled={me.twoFactorEnabled}
                initialBackupCount={me.backupCodes.length}
              />
            )}
            <UserTokensPanel />
            <PluginSessionsPanel />
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
