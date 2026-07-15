import type { ReactNode } from "react";

// En-tête unifié des pages principales (modèle de la page Docs) : une pastille
// carrée dorée contenant l'icône de la page, à gauche du titre + sous-titre.
// Slot `actions` optionnel pour les boutons alignés à droite.
//
// Composant pur (server & client safe) — aucun hook, aucun "use client".
export default function PageHero({
  icon,
  title,
  subtitle,
  actions,
}: {
  icon: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="page-hero">
      <div className="page-hero-icon" aria-hidden>
        {icon}
      </div>
      <div className="page-hero-main">
        <h1 className="page-hero-title">{title}</h1>
        {subtitle != null && (
          <div className="page-hero-subtitle">{subtitle}</div>
        )}
      </div>
      {actions != null && <div className="page-hero-actions">{actions}</div>}
    </div>
  );
}
