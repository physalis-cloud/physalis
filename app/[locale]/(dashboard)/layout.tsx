import type { ReactNode } from "react";
import Link from "next/link";
import Image from "next/image";
import { signOut } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { getCurrentOrgSlug } from "@/lib/api";
import { isSuperadmin } from "@/lib/roles";
import { getTranslations } from "next-intl/server";
import { RiAccountCircleLine } from "@remixicon/react";
import OrgSwitcher from "./org-switcher";
import HeaderNav from "./header-nav";
import LocaleSwitcher from "@/components/LocaleSwitcher";
import OfflineBanner from "@/components/OfflineBanner";
import { ConfirmProvider } from "@/components/ConfirmDialog";
import LogoutButton from "@/components/LogoutButton";
import AccountLockScreen from "./account-lock-screen";
import { accountLockState, daysUntilPurge } from "@/lib/deletion-window";
import { reauthMethodFor } from "@/lib/reauth";

// Self-host : single-tenant. Pas de bandeau billing/quota Stripe (réservé
// au SaaS). Le layout original est dans le repo SaaS.

export default async function DashboardLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const session = await auth();
  if (!session?.user?.id) {
    redirect(`/${locale}/login`);
  }
  const userId = session.user.id;
  const email = session.user.email ?? "";
  const t = await getTranslations("dashboard.layout");

  // Suppression de compte MEMBRE — l'utilisateur a demandé son effacement :
  // son espace est verrouillé jusqu'à l'échéance, seule la récupération de ses
  // données reste possible.
  //
  // Une seule branche ici, contrairement au SaaS : `read_only` y couvre le cas
  // « le compte CLIENT est en cours de suppression », qui n'existe pas en
  // mono-tenant — il n'y a pas de tenant à résilier, donc `tenantStatus` est
  // toujours null.
  const me = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      deletionRequestedAt: true,
      purgeAt: true,
      email: true,
      password: true,
      twoFactorEnabled: true,
    },
  });

  if (
    accountLockState({
      userDeletionRequestedAt: me?.deletionRequestedAt ?? null,
      tenantStatus: null,
    }) === "locked"
  ) {
    return (
      <div className="min-h-screen flex flex-col bg-bg">
        <header className="app-header">
          <div className="flex items-center gap-6">
            <span className="brand">
              <Image
                src="/icon-32.png"
                alt=""
                width={26}
                height={26}
                priority
                style={{ flexShrink: 0 }}
              />
              Physalis
            </span>
          </div>
          <div className="flex items-center gap-3">
            <LocaleSwitcher />
            {/* Verrouiller quelqu'un sans porte de sortie serait un piège :
                la déconnexion reste offerte. */}
            <LogoutButton
              label={t("logout")}
              action={async () => {
                "use server";
                await signOut({ redirectTo: `/${locale}/login` });
              }}
            />
          </div>
        </header>
        <AccountLockScreen
          purgeAtIso={me?.purgeAt?.toISOString() ?? null}
          daysRemaining={daysUntilPurge(me?.purgeAt ?? null)}
          email={me?.email ?? email}
          reauthFields={{
            password:
              reauthMethodFor({
                hasPassword: me?.password != null,
                twoFactorEnabled: Boolean(me?.twoFactorEnabled),
              }) === "password",
            code: Boolean(me?.twoFactorEnabled),
          }}
        />
      </div>
    );
  }

  const memberships = await prisma.orgMember.findMany({
    where: { userId },
    select: {
      role: true,
      organization: { select: { id: true, name: true, slug: true } },
    },
    orderBy: { createdAt: "asc" },
  });
  const currentSlug = await getCurrentOrgSlug(userId);

  return (
    <ConfirmProvider>
    <div className="min-h-screen flex flex-col bg-bg">
      <OfflineBanner />
      <header className="app-header">
        <div className="flex items-center gap-6">
          <Link href={`/${locale}/dashboard`} className="brand">
            <Image
              src="/icon-32.png"
              alt=""
              width={26}
              height={26}
              priority
              style={{ flexShrink: 0 }}
            />
            Physalis
          </Link>
          <OrgSwitcher
            organizations={memberships.map((m) => ({
              ...m.organization,
              role: m.role,
            }))}
            currentSlug={currentSlug}
          />
          <HeaderNav currentSlug={currentSlug} />
        </div>
        <div className="flex items-center gap-3">
          {isSuperadmin(session.user.role) && (
            <Link href={`/${locale}/admin`} className="btn btn-ghost btn-sm">
              Admin
            </Link>
          )}
          <LocaleSwitcher />
          <LogoutButton
            label={t("logout")}
            action={async () => {
              "use server";
              await signOut({ redirectTo: `/${locale}/login` });
            }}
          />
          <Link
            href={`/${locale}/account`}
            className="user-link"
            style={{ display: "inline-flex", alignItems: "center" }}
            title={`${t("myAccount")} : ${email}`}
            aria-label={`${t("myAccount")} : ${email}`}
          >
            <RiAccountCircleLine size={24} aria-hidden />
          </Link>
        </div>
      </header>
      <main className="flex-1">{children}</main>
    </div>
    </ConfirmProvider>
  );
}
