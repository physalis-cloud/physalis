import type { ReactNode } from "react";

// Encart d'état vide : carte bordée centrée, icône dans une pastille ronde
// douce (accent-bg), titre, hint, et action optionnelle (ex. bouton de
// création). Composant pur (server & client safe).
export default function EmptyCard({
  icon,
  title,
  hint,
  action,
}: {
  icon: ReactNode;
  title: ReactNode;
  hint?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty-card-frame">
      <div className="empty-card">
        <div className="empty-card-icon" aria-hidden>
          {icon}
        </div>
        <div className="empty-card-title">{title}</div>
        {hint != null && <p className="empty-card-hint">{hint}</p>}
        {action != null && <div className="empty-card-action">{action}</div>}
      </div>
    </div>
  );
}
