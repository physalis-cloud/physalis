"use client";

// Repli du bloc « Activité récente ». Le contenu (filtres, liste, pagination)
// reste rendu cote serveur et arrive en `children` : ce composant ne gere que
// l'etat ouvert/ferme et le bouton, place juste a droite du titre.
//
// Ferme par defaut. Le choix est memorise (localStorage) : sans ca, chaque
// clic sur un filtre ou une page — qui recharge la route — refermerait le
// bloc que l'user vient d'ouvrir. Lecture dans un effet, pas a l'init, pour
// ne pas diverger du HTML rendu cote serveur (hydratation).

import { useEffect, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { RiArrowDownSLine, RiArrowUpSLine } from "@remixicon/react";

const OPEN_KEY = "physalis.dashboard.activityOpen";

export default function ActivityCollapse({
  meta,
  children,
}: {
  meta?: ReactNode;
  children: ReactNode;
}) {
  const t = useTranslations("dashboard.activity");
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.localStorage.getItem(OPEN_KEY) === "1") setOpen(true);
  }, []);

  function toggle() {
    setOpen((v) => {
      const next = !v;
      if (typeof window !== "undefined") {
        window.localStorage.setItem(OPEN_KEY, next ? "1" : "0");
      }
      return next;
    });
  }

  return (
    <>
      <div className="section-header">
        <div className="flex items-center gap-2">
          <h2 className="section-title">{t("title")}</h2>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={toggle}
            aria-expanded={open}
            aria-controls="activity-body"
          >
            {open ? (
              <RiArrowUpSLine size={14} aria-hidden />
            ) : (
              <RiArrowDownSLine size={14} aria-hidden />
            )}
            {open ? t("hide") : t("show")}
          </button>
        </div>
        {open && meta}
      </div>
      <div id="activity-body" hidden={!open}>
        {children}
      </div>
    </>
  );
}
