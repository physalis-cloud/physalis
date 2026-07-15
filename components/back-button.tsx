"use client";

/** Bouton « Page précédente » — revient dans l'historique du navigateur. */
export function BackButton({ label }: { label: string }) {
  return (
    <button
      type="button"
      className="btn btn-ghost"
      onClick={() => window.history.back()}
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        style={{ width: 15, height: 15 }}
      >
        <path d="m12 19-7-7 7-7" />
        <path d="M19 12H5" />
      </svg>
      {label}
    </button>
  );
}
