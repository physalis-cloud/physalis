"use client";

import { useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";

type TabKey = "account" | "services" | "sso" | "subscription" | "support";

// Onglets de la page /account : « Mon compte » (profil, sécurité, données),
// « Services » (email, backup, orgs ajoutées), « SSO » (config SSO Enterprise,
// gestionnaires uniquement) et « Abonnement » (plan, quotas, facturation). Les
// slots sont rendus côté serveur et passés en props ; on bascule l'affichage
// côté client (display none) pour conserver l'état des panneaux sans refetch.
// Un slot null = pas d'onglet correspondant.
export default function AccountTabs({
  accountSlot,
  servicesSlot,
  ssoSlot,
  subscriptionSlot,
  supportSlot,
}: {
  accountSlot: ReactNode;
  servicesSlot: ReactNode | null;
  ssoSlot: ReactNode | null;
  subscriptionSlot: ReactNode | null;
  supportSlot: ReactNode | null;
}) {
  const t = useTranslations("account");
  const [tab, setTab] = useState<TabKey>("account");

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
