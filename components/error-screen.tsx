import type { ReactNode } from "react";
import Image from "next/image";
import { Link } from "@/i18n/navigation";

/**
 * Écran d'erreur partagé — 404 / 500 / 403 / 503.
 *
 * Purement présentationnel : le texte (traduit) et les actions sont fournis
 * par l'appelant (page serveur ou boundary client), ce qui permet de réutiliser
 * le même visuel côté serveur (`not-found.tsx`) comme côté client (`error.tsx`).
 *
 * Cf. maquette validée : docs/modele/vault-error-pages.html.
 */

export type ErrorVariant = "notFound" | "server" | "forbidden" | "maintenance";

type VariantSpec = { code: string; danger: boolean; icon: ReactNode };

const S = 1.8;
const svg = (children: ReactNode) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={S}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {children}
  </svg>
);

const VARIANTS: Record<ErrorVariant, VariantSpec> = {
  notFound: {
    code: "404",
    danger: false,
    icon: svg(
      <>
        <circle cx="11" cy="11" r="7" />
        <path d="m21 21-4.3-4.3" />
        <path d="M11 8v3" />
        <path d="M11 14h.01" />
      </>,
    ),
  },
  server: {
    code: "500",
    danger: true,
    icon: svg(
      <>
        <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
        <path d="M12 9v4" />
        <path d="M12 17h.01" />
      </>,
    ),
  },
  forbidden: {
    code: "403",
    danger: false,
    icon: svg(
      <>
        <rect width="18" height="11" x="3" y="11" rx="2" />
        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
      </>,
    ),
  },
  maintenance: {
    code: "503",
    danger: false,
    icon: svg(
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />,
    ),
  },
};

export interface ErrorScreenProps {
  variant: ErrorVariant;
  /** Libellé au-dessus du titre, ex. « Erreur 404 ». */
  eyebrow: string;
  title: string;
  text: string;
  /** Tagline affichée à droite du logo dans l'en-tête. */
  tagline: string;
  /** Bloc détail technique optionnel (ex. référence d'incident 500). */
  detail?: { label: string; value: string } | null;
  /** Zone d'actions (boutons / liens). */
  children?: ReactNode;
  /** Ligne de support optionnelle sous les actions. */
  support?: ReactNode;
}

export function ErrorScreen({
  variant,
  eyebrow,
  title,
  text,
  tagline,
  detail,
  children,
  support,
}: ErrorScreenProps) {
  const spec = VARIANTS[variant];
  return (
    <div className="err-page">
      <header className="app-header">
        <Link className="brand" href="/">
          <Image
            src="/icon-32.png"
            alt="Physalis"
            width={32}
            height={32}
            className="err-brand-icon"
            priority
          />
          Physalis
        </Link>
        <span className="err-header-hint">{tagline}</span>
      </header>

      <div className="err-body">
        <div className="err-ghost" aria-hidden="true">
          {spec.code}
        </div>
        <div className="err-inner">
          <div className={`err-glyph${spec.danger ? " is-danger" : ""}`}>
            {spec.icon}
          </div>
          <span className={`err-eyebrow${spec.danger ? " is-danger" : ""}`}>
            {eyebrow}
          </span>
          <h1 className="err-title">{title}</h1>
          <p className="err-text">{text}</p>

          {detail ? (
            <div className="err-detail">
              <span className="k">{detail.label}</span>
              <span>{detail.value}</span>
            </div>
          ) : null}

          {children ? <div className="err-actions">{children}</div> : null}
          {support ? <p className="err-support">{support}</p> : null}
        </div>
      </div>
    </div>
  );
}
