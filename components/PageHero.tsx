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
  stackActions = false,
}: {
  icon: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  /** Descend les actions sur leur propre ligne (toujours à droite) au lieu de
   *  les poser à côté du titre. À réserver aux pages dont le titre est un
   *  intitulé libre et long : à côté de deux ou trois boutons, il se hachait en
   *  plusieurs lignes alors qu'il tient sur une seule pleine largeur. */
  stackActions?: boolean;
}) {
  return (
    <div className={`page-hero${stackActions ? " page-hero-stacked" : ""}`}>
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
