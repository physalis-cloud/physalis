"use client";

// Dialog historique d'un secret (Secret env-level OU OrgSecret).
// Liste les versions, permet de révéler une valeur historique et de
// restaurer une version. Cf. docs/versionning-secrets.md.
//
// Générique sur le type de secret via la prop `apiBaseUrl` qui pointe
// sur la racine `/versions` de la route REST :
//   - Secret env  : /api/projects/<slug>/<env>/secrets/<key>/versions
//   - OrgSecret   : /api/orgs/<slug>/secrets/<key>/versions

import { useEffect, useState } from "react";
import {
  RiCloseLine,
  RiEyeLine,
  RiEyeOffLine,
  RiHistoryLine,
} from "@remixicon/react";
import { useConfirm } from "@/components/ConfirmDialog";

type Version = {
  version: number;
  createdAt: string;
  actor: { id: string; email: string } | null;
};

const REVEAL_AUTO_HIDE_MS = 60_000;

export default function SecretHistoryDialog({
  apiBaseUrl,
  secretKey,
  onClose,
  onRestored,
}: {
  /** URL de base pointant sur `/versions` (sans trailing slash). */
  apiBaseUrl: string;
  secretKey: string;
  onClose: () => void;
  /** Appelé après un rollback réussi pour que le parent recharge sa liste. */
  onRestored: () => void;
}) {
  const [versions, setVersions] = useState<Version[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [revealedValues, setRevealedValues] = useState<
    Record<number, string>
  >({});
  const [revealError, setRevealError] = useState<Record<number, string>>({});
  const [revealing, setRevealing] = useState<number | null>(null);
  const [restoring, setRestoring] = useState<number | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const confirm = useConfirm();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          apiBaseUrl,
        );
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          if (!cancelled) setListError(data.error ?? `HTTP ${res.status}`);
          return;
        }
        const data = (await res.json()) as { versions: Version[] };
        if (!cancelled) setVersions(data.versions);
      } catch (err) {
        if (!cancelled) {
          setListError(err instanceof Error ? err.message : "Erreur réseau");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [apiBaseUrl]);

  // Auto-hide les valeurs révélées après REVEAL_AUTO_HIDE_MS pour éviter
  // qu'elles restent à l'écran indéfiniment.
  useEffect(() => {
    const versionsRevealed = Object.keys(revealedValues).map(Number);
    if (versionsRevealed.length === 0) return;
    const timer = setTimeout(() => setRevealedValues({}), REVEAL_AUTO_HIDE_MS);
    return () => clearTimeout(timer);
  }, [revealedValues]);

  async function reveal(version: number) {
    if (revealedValues[version] !== undefined) {
      // Toggle hide.
      setRevealedValues((prev) => {
        const next = { ...prev };
        delete next[version];
        return next;
      });
      return;
    }
    setRevealing(version);
    setRevealError((prev) => {
      const next = { ...prev };
      delete next[version];
      return next;
    });
    try {
      const res = await fetch(
        `${apiBaseUrl}/${version}`,
      );
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        setRevealError((prev) => ({
          ...prev,
          [version]: data.error ?? `HTTP ${res.status}`,
        }));
        return;
      }
      const data = (await res.json()) as { value: string };
      setRevealedValues((prev) => ({ ...prev, [version]: data.value }));
    } catch (err) {
      setRevealError((prev) => ({
        ...prev,
        [version]: err instanceof Error ? err.message : "Erreur réseau",
      }));
    } finally {
      setRevealing(null);
    }
  }

  async function copy(version: number) {
    const value = revealedValues[version];
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
    } catch (err) {
      console.warn("[secret-history] clipboard write failed:", err);
    }
  }

  async function restore(version: number) {
    const confirmed = await confirm({
      message: `Restaurer la version ${version} ?\n\nLa valeur actuelle sera conservée dans l'historique.`,
    });
    if (!confirmed) return;
    setRestoreError(null);
    setRestoring(version);
    try {
      const res = await fetch(
        `${apiBaseUrl}/${version}/rollback`,
        { method: "POST" },
      );
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        setRestoreError(`Restauration échouée : ${data.error ?? `HTTP ${res.status}`}`);
        return;
      }
      onRestored();
      onClose();
    } catch (err) {
      setRestoreError(
        `Restauration échouée : ${
          err instanceof Error ? err.message : "Erreur réseau"
        }`,
      );
    } finally {
      setRestoring(null);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="history-modal-title"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.4)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
        padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--surface)",
          borderRadius: 12,
          maxWidth: 720,
          width: "100%",
          maxHeight: "85vh",
          padding: 24,
          boxShadow: "0 24px 60px rgba(0,0,0,0.18)",
          display: "flex",
          flexDirection: "column",
          gap: 16,
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <h2
            id="history-modal-title"
            style={{ margin: 0, fontSize: 18, fontWeight: 600, display: "flex", gap: 8, alignItems: "center" }}
          >
            <RiHistoryLine size={20} aria-hidden /> Historique —{" "}
            <span className="code-mono">{secretKey}</span>
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fermer"
            className="btn btn-ghost btn-sm"
            style={{ padding: 6 }}
          >
            <RiCloseLine size={18} aria-hidden />
          </button>
        </div>

        {loading && (
          <div className="help" style={{ fontSize: 13 }}>
            Chargement…
          </div>
        )}

        {!loading && listError && (
          <div
            role="alert"
            style={{
              padding: 12,
              borderRadius: 8,
              background: "#fee2e2",
              color: "#7f1d1d",
              fontSize: 13,
            }}
          >
            {listError}
          </div>
        )}

        {restoreError && (
          <div
            role="alert"
            style={{
              padding: 12,
              borderRadius: 8,
              background: "#fee2e2",
              color: "#7f1d1d",
              fontSize: 13,
            }}
          >
            {restoreError}
          </div>
        )}

        {!loading && !listError && versions.length === 0 && (
          <div className="empty-state">
            <div className="empty-state-title">Aucune version historique</div>
            <div style={{ fontSize: 13 }}>
              Les versions apparaissent à chaque modification de la valeur du
              secret.
            </div>
          </div>
        )}

        {versions.length > 0 && (
          <div
            style={{
              overflow: "auto",
              maxHeight: "60vh",
              border: "1px solid var(--border)",
              borderRadius: 8,
            }}
          >
            <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {versions.map((v, idx) => {
                const isRevealed = revealedValues[v.version] !== undefined;
                const err = revealError[v.version];
                return (
                  <li
                    key={v.version}
                    style={{
                      padding: "12px 16px",
                      borderTop: idx === 0 ? "none" : "1px solid var(--border)",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "flex-start",
                        gap: 12,
                      }}
                    >
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 14, fontWeight: 500 }}>
                          Version {v.version}
                        </div>
                        <div className="help" style={{ fontSize: 12, marginTop: 2 }}>
                          {formatDate(v.createdAt)}
                          {v.actor && (
                            <>
                              {" · "}
                              <span>{v.actor.email}</span>
                            </>
                          )}
                        </div>
                      </div>
                      <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                        <button
                          type="button"
                          className="btn btn-ghost btn-xs"
                          onClick={() => reveal(v.version)}
                          disabled={revealing === v.version}
                        >
                          {isRevealed ? (
                            <>
                              <RiEyeOffLine size={12} aria-hidden /> Masquer
                            </>
                          ) : (
                            <>
                              <RiEyeLine size={12} aria-hidden />{" "}
                              {revealing === v.version
                                ? "Chargement…"
                                : "Voir"}
                            </>
                          )}
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost btn-xs"
                          onClick={() => restore(v.version)}
                          disabled={restoring === v.version}
                          title="La valeur actuelle sera conservée dans l'historique"
                        >
                          {restoring === v.version
                            ? "Restauration…"
                            : "Restaurer"}
                        </button>
                      </div>
                    </div>
                    {isRevealed && (
                      <div
                        style={{
                          marginTop: 8,
                          padding: 10,
                          background: "var(--bg)",
                          borderRadius: 6,
                          fontSize: 13,
                          fontFamily: "var(--font-mono, monospace)",
                          wordBreak: "break-all",
                          display: "flex",
                          gap: 8,
                          alignItems: "center",
                        }}
                      >
                        <span style={{ flex: 1 }}>
                          {revealedValues[v.version]}
                        </span>
                        <button
                          type="button"
                          className="btn btn-ghost btn-xs"
                          onClick={() => copy(v.version)}
                        >
                          Copier
                        </button>
                      </div>
                    )}
                    {err && (
                      <div
                        style={{
                          marginTop: 8,
                          fontSize: 12,
                          color: "var(--danger)",
                        }}
                      >
                        {err}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Fermer
          </button>
        </div>

        {versions.length > 0 && (
          <div className="help" style={{ fontSize: 11 }}>
            Les valeurs révélées sont masquées automatiquement après 1 minute.
            Chaque révélation est tracée dans l&apos;audit log.
          </div>
        )}
      </div>
    </div>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("fr-FR", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
