"use client";

import { useEffect } from "react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { ErrorScreen } from "@/components/error-screen";
import { HomeIcon, RefreshIcon } from "@/components/error-icons";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations("errors");

  useEffect(() => {
    // Journalise côté client ; l'erreur détaillée reste serveur-only.
    console.error(error);
  }, [error]);

  return (
    <ErrorScreen
      variant="server"
      tagline={t("tagline")}
      eyebrow={t("server.eyebrow")}
      title={t("server.title")}
      text={t("server.text")}
      detail={
        error.digest
          ? { label: t("server.reference"), value: error.digest }
          : null
      }
      support={t.rich("server.support", {
        link: (chunks) => <Link href="/account">{chunks}</Link>,
      })}
    >
      <button type="button" className="btn btn-primary" onClick={() => reset()}>
        <RefreshIcon />
        {t("server.retry")}
      </button>
      <Link className="btn btn-ghost" href="/dashboard">
        <HomeIcon />
        {t("backToDashboard")}
      </Link>
    </ErrorScreen>
  );
}
