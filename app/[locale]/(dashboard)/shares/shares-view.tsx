"use client";

// Vue Partages consolidée (client) : en-tête PageHero avec bouton de création
// contextuel à droite (au niveau du titre), rangée de stats, onglets, et liste
// active. Les compteurs sont calculés côté serveur et passés en props.
//
// Le bouton de création est contextuel à l'onglet : "Créer un partage" sur
// "Mes partages", "Autoriser un partage externe" sur "Demandes externes". Il
// vit dans le slot actions du header — d'où la consolidation ici (l'état
// d'onglet + le refresh de la liste externe restent dans le même arbre).

import { useEffect, useState, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { useRouter, usePathname } from "@/i18n/navigation";
import { useTranslations } from "next-intl";
import {
  RiShareForward2Line,
  RiTimerLine,
  RiMailLine,
} from "@remixicon/react";
import PageHero from "@/components/PageHero";
import SharesList from "./shares-list";
import SecretRequestsTab from "./secret-requests-tab";
import SecretRequestCreateButton from "./secret-request-create-button";
import ShareCreateButton from "../share-create-button";

type Tab = "mine" | "external";

export default function SharesView({
  stats,
}: {
  stats: { active: number; expired: number; external: number };
}) {
  const t = useTranslations("shares");
  const sp = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const initial: Tab = sp.get("tab") === "external" ? "external" : "mine";
  const [tab, setTab] = useState<Tab>(initial);

  // Compteur incrémenté quand une demande externe est créée → SecretRequestsTab
  // se reload via ce changement de key.
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    const params = new URLSearchParams(sp.toString());
    if (tab === "external") params.set("tab", "external");
    else params.delete("tab");
    const qs = params.toString();
    router.replace(`${pathname}${qs ? `?${qs}` : ""}`, { scroll: false });
  }, [tab, pathname, router, sp]);

  // Bouton d'action contextuel, placé dans le header (slot actions).
  const action =
    tab === "mine" ? (
      <ShareCreateButton />
    ) : (
      <SecretRequestCreateButton
        onCreated={() => setRefreshKey((k) => k + 1)}
      />
    );

  return (
    <>
      <PageHero
        icon={<RiShareForward2Line size={28} aria-hidden />}
        title={t("pageTitle")}
        subtitle={t.rich("pageDesc", {
          br: () => <br />,
          strong: (c) => <strong>{c}</strong>,
        })}
        actions={action}
      />

      <div className="stat-grid" style={{ marginTop: 4, marginBottom: 20 }}>
        <ShareStat
          icon={<RiShareForward2Line size={15} aria-hidden />}
          value={stats.active}
          label={t("statShareActive")}
        />
        <ShareStat
          icon={<RiTimerLine size={15} aria-hidden />}
          value={stats.expired}
          label={t("statShareExpired")}
        />
        <ShareStat
          icon={<RiMailLine size={15} aria-hidden />}
          value={stats.external}
          label={t("statExternalRequests")}
        />
      </div>

      <div className="flex flex-col gap-4">
        <div className="tab-bar">
          <button
            type="button"
            className={`tab ${tab === "mine" ? "active" : ""}`}
            onClick={() => setTab("mine")}
          >
            {t("tabMyShares")}
          </button>
          <button
            type="button"
            className={`tab ${tab === "external" ? "active" : ""}`}
            onClick={() => setTab("external")}
          >
            {t("tabExternalRequests")}
          </button>
        </div>

        {tab === "mine" ? (
          <SharesList />
        ) : (
          <SecretRequestsTab refreshKey={refreshKey} />
        )}
      </div>
    </>
  );
}

// Carte de stat (cartes blanches, valeur + icône dorées) — reprend les tokens
// de l'accueil.
function ShareStat({
  icon,
  value,
  label,
}: {
  icon: ReactNode;
  value: number;
  label: string;
}) {
  return (
    <div className="stat-card">
      <div
        className="stat-card-label"
        style={{ display: "flex", alignItems: "center", gap: 6 }}
      >
        <span
          style={{
            color: "var(--accent-text)",
            display: "inline-flex",
            alignItems: "center",
          }}
        >
          {icon}
        </span>
        {label}
      </div>
      <div className="stat-card-value" style={{ color: "var(--accent-text)" }}>
        {value}
      </div>
    </div>
  );
}
