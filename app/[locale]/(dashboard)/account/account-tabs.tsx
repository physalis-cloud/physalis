"use client";

import { useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";

type TabKey = "account" | "notifications" | "services" | "sso" | "subscription" | "support";

const TAB_KEYS: readonly TabKey[] = ["account", "notifications", "services", "sso", "subscription", "support"];

// Onglets de la page /account : « Mon compte » (profil, sécurité, données),
// « Services » (email, backup, orgs ajoutées), « SSO » (config SSO Enterprise,
// gestionnaires uniquement) et « Abonnement » (plan, quotas, facturation). Les
// slots sont rendus côté serveur et passés en props ; on bascule l'affichage
// côté client (display none) pour conserver l'état des panneaux sans refetch.
// Un slot null = pas d'onglet correspondant.
//
// `initialTab` (lu dans `?tab=` par la page) : lien profond. Sans lui, la
// pastille de notifications ouvrirait /account sur « Mon compte ». Un onglet
// demandé mais absent (slot null) retombe sur « Mon compte ».
export default function AccountTabs({
  accountSlot,
  notificationsSlot = null,
  initialTab,
  servicesSlot,
  ssoSlot,
  subscriptionSlot,
  supportSlot,
}: {
  accountSlot: ReactNode;
  /** Onglet « Notifications » (C-0048) — optionnel : null = pas d'onglet. */
  notificationsSlot?: ReactNode | null;
  initialTab?: string | null;
  servicesSlot: ReactNode | null;
  ssoSlot: ReactNode | null;
  subscriptionSlot: ReactNode | null;
  supportSlot: ReactNode | null;
}) {
  const t = useTranslations("account");
  const slots: Record<TabKey, ReactNode | null> = {
    account: accountSlot,
    notifications: notificationsSlot,
    services: servicesSlot,
    sso: ssoSlot,
    subscription: subscriptionSlot,
    support: supportSlot,
  };
  const wanted = TAB_KEYS.find((k) => k === initialTab);
  const [tab, setTab] = useState<TabKey>(wanted && slots[wanted] ? wanted : "account");

  return (
    <>
      <div className="tab-bar" style={{ display: "flex" }}>
        <button
          type="button"
          className={`tab ${tab === "account" ? "active" : ""}`}
          onClick={() => setTab("account")}
        >
          {t("tabMyAccount")}
        </button>
        {notificationsSlot && (
          <button
            type="button"
            className={`tab ${tab === "notifications" ? "active" : ""}`}
            onClick={() => setTab("notifications")}
          >
            {t("tabNotifications")}
          </button>
        )}
        {servicesSlot && (
          <button
            type="button"
            className={`tab ${tab === "services" ? "active" : ""}`}
            onClick={() => setTab("services")}
          >
            {t("tabServices")}
          </button>
        )}
        {ssoSlot && (
          <button
            type="button"
            className={`tab ${tab === "sso" ? "active" : ""}`}
            onClick={() => setTab("sso")}
          >
            {t("tabSso")}
          </button>
        )}
        {subscriptionSlot && (
          <button
            type="button"
            className={`tab ${tab === "subscription" ? "active" : ""}`}
            onClick={() => setTab("subscription")}
          >
            {t("tabSubscription")}
          </button>
        )}
        {supportSlot && (
          <button
            type="button"
            className={`tab ${tab === "support" ? "active" : ""}`}
            onClick={() => setTab("support")}
          >
            {t("tabSupport")}
          </button>
        )}
      </div>

      <div style={{ display: tab === "account" ? "block" : "none" }}>
        {accountSlot}
      </div>
      {notificationsSlot && (
        <div style={{ display: tab === "notifications" ? "block" : "none" }}>
          {notificationsSlot}
        </div>
      )}
      {servicesSlot && (
        <div style={{ display: tab === "services" ? "block" : "none" }}>
          {servicesSlot}
        </div>
      )}
      {ssoSlot && (
        <div style={{ display: tab === "sso" ? "block" : "none" }}>
          {ssoSlot}
        </div>
      )}
      {subscriptionSlot && (
        <div style={{ display: tab === "subscription" ? "block" : "none" }}>
          {subscriptionSlot}
        </div>
      )}
      {supportSlot && (
        <div style={{ display: tab === "support" ? "block" : "none" }}>
          {supportSlot}
        </div>
      )}
    </>
  );
}
