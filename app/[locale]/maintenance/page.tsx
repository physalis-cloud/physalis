"use client";

import { useTranslations } from "next-intl";
import { ErrorScreen } from "@/components/error-screen";
import { RefreshIcon } from "@/components/error-icons";

// Page 503 : écran de maintenance. Destinée à être affichée quand le service
// est volontairement indisponible (mise à jour). Le bouton « Rafraîchir »
// recharge la page pour re-tester la disponibilité.
export default function Maintenance() {
  const t = useTranslations("errors");
  return (
    <ErrorScreen
      variant="maintenance"
      tagline={t("tagline")}
      eyebrow={t("maintenance.eyebrow")}
      title={t("maintenance.title")}
      text={t("maintenance.text")}
    >
      <button
        type="button"
        className="btn btn-primary"
        onClick={() => window.location.reload()}
      >
        <RefreshIcon />
        {t("maintenance.refresh")}
      </button>
    </ErrorScreen>
  );
}
