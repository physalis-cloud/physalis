"use client";

import { useEffect } from "react";

/**
 * Filet de sécurité ultime : capté uniquement si le root layout lui-même
 * plante. Il remplace tout l'arbre (y compris <html>/<body>) et s'exécute
 * hors du NextIntlClientProvider — donc pas de traductions ici : texte neutre
 * (anglais, locale par défaut) et styles inline autonomes (globals.css peut
 * ne pas être chargée à ce stade).
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "grid",
          placeItems: "center",
          padding: "24px",
          background: "#f5f3ef",
          color: "#1a1a1a",
          fontFamily:
            '-apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif',
          fontSize: "14px",
          lineHeight: 1.5,
          textAlign: "center",
        }}
      >
        <div style={{ maxWidth: 420 }}>
          <div
            style={{
              width: 56,
              height: 56,
              borderRadius: 16,
              margin: "0 auto 18px",
              display: "grid",
              placeItems: "center",
              background: "#fce8e8",
              border: "1px solid #f0c8c8",
              color: "#8a2222",
            }}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.8}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              style={{ width: 26, height: 26 }}
            >
              <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
              <path d="M12 9v4" />
              <path d="M12 17h.01" />
            </svg>
          </div>
          <h1
            style={{
              fontSize: 24,
              fontWeight: 700,
              letterSpacing: "-0.01em",
              margin: 0,
            }}
          >
            Something went wrong
          </h1>
          <p style={{ color: "#6b6258", margin: "10px 0 0" }}>
            An unexpected error occurred. Your secrets remain encrypted and
            intact. Please try again in a moment.
          </p>
          {error.digest ? (
            <p
              style={{
                marginTop: 16,
                fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
                fontSize: 11.5,
                color: "#6b6258",
              }}
            >
              Reference: {error.digest}
            </p>
          ) : null}
          <button
            type="button"
            onClick={() => reset()}
            style={{
              marginTop: 24,
              padding: "9px 16px",
              borderRadius: 8,
              fontSize: 13,
              fontWeight: 600,
              letterSpacing: "0.02em",
              cursor: "pointer",
              background: "#f4ebd7",
              color: "#6a4c14",
              border: "1px solid #dcbf62",
              fontFamily: "inherit",
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
