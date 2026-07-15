"use client";

// Bandeau global « hors ligne » : s'affiche dès que le navigateur perd la
// connexion (navigator.onLine + events online/offline). Couvre TOUTES les
// actions de l'app d'un coup — hors ligne, n'importe quel `fetch` échoue, et ce
// bandeau évite l'échec silencieux : l'utilisateur sait que ses actions ne
// partiront pas tant qu'il n'est pas reconnecté. Sticky pour rester visible.

import { useEffect, useState } from "react";
import { RiWifiOffLine } from "@remixicon/react";
import { useTranslations } from "next-intl";

export default function OfflineBanner() {
  const t = useTranslations("offlineBanner");
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    const update = () => setOffline(!navigator.onLine);
    update(); // état initial (au cas où on charge déjà hors ligne)
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  if (!offline) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: "sticky",
        top: 0,
        zIndex: 50,
        display: "flex",
        gap: 10,
        alignItems: "center",
        justifyContent: "center",
        padding: "10px 20px",
        background: "#fef3c7",
        color: "#7c5310",
        borderBottom: "1px solid #fcd34d",
        fontSize: 13,
        fontWeight: 500,
      }}
    >
      <RiWifiOffLine size={18} aria-hidden style={{ flexShrink: 0 }} />
      <span>
        <strong>{t("title")}</strong> {t("desc")}
      </span>
    </div>
  );
}
