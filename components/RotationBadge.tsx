"use client";

import { useLocale, useTranslations } from "next-intl";
import { RiLoopRightLine, RiTimeLine } from "@remixicon/react";

// Pastille « rotation configurée » d'une ligne de liste (secret, compte,
// service, entrée de coffre). Deux axes :
//  - le MODE : ↻ automatique (DATABASE/JWT_SECRET/API_KEY/WEBHOOK) ou horloge
//    assistée (REMINDER, ou stratégie absente = REMINDER implicite des services
//    et coffres) ;
//  - l'ÉTAT : neutre (à jour), orange (échéance passée), rouge (échec).
//
// ⚠️ `rotationLastStatus` vaut "success", "reminder" ou "error" (cf.
// `tonDernierEtat` dans secrets-panel). "reminder" = le rappel est parti, donc
// l'échéance EST passée : il compte comme « à roter », jamais comme une erreur.
// L'échéance se lit aussi sur `rotationNextAt` : le cron ne tourne qu'à heure
// fixe, la pastille ne doit pas attendre son passage pour virer à l'orange.
export default function RotationBadge({
  strategy,
  nextAt,
  lastStatus,
}: {
  strategy: string | null | undefined;
  nextAt: string | null | undefined;
  lastStatus: string | null | undefined;
}) {
  const t = useTranslations("rotationBadge");
  const locale = useLocale();
  const assisted = !strategy || strategy === "REMINDER";

  const due =
    lastStatus === "reminder" ||
    (nextAt != null && new Date(nextAt).getTime() <= Date.now());
  const failed = !assisted && lastStatus != null && lastStatus !== "success" && lastStatus !== "reminder";

  const rgb = failed ? "239,68,68" : due ? "234,179,8" : "99,102,241";
  const mode = assisted ? t("assisted") : t("auto");
  const date = nextAt ? new Date(nextAt).toLocaleDateString(locale) : null;
  const state = failed
    ? t("failed")
    : due
      ? t("due")
      : date
        ? t("nextAt", { date })
        : null;
  const title = state ? `${mode} — ${state}` : mode;
  const Icon = assisted ? RiTimeLine : RiLoopRightLine;

  return (
    <span
      className="chip"
      style={{
        fontSize: 10,
        background: `rgba(${rgb}, 0.15)`,
        color: `rgb(${rgb})`,
        fontFamily: "inherit",
        display: "inline-flex",
        alignItems: "center",
        gap: 3,
      }}
      title={title}
      aria-label={title}
    >
      <Icon size={12} aria-hidden />
      {due || failed ? state : null}
    </span>
  );
}
