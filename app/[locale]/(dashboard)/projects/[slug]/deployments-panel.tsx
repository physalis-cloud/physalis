"use client";

// Historique des déploiements d'un environnement (C-0051, Phase 3).
// Cf. lib/deployment.ts et documentation/plans/guide-installation-projet.md §3.6.
//
// ⚠️ Vocabulaire : « réussi » est une DÉCLARATION du pipeline, pas un constat
// de Physalis — le libellé et l'infobulle le disent. Les paliers d'attente
// (long / anormal / expiré) sont calculés côté serveur à chaque lecture.

import { useCallback, useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { DeploymentPhase, DeploymentView } from "@/lib/deployment";

/** Rafraîchissement tant qu'un déploiement attend son rapport. */
const POLL_MS = 30_000;

const PENDING: DeploymentPhase[] = ["running", "long", "abnormal"];

const PAGE_SIZE = 10;

/** Même carte blanche que l'historique de l'onglet Backup. */
const WHITE_CARD = {
  background: "var(--surface)",
  border: "1px solid var(--accent-soft)",
  borderRadius: 12,
  padding: 16,
} as const;

export function phaseBadgeClass(phase: DeploymentPhase): string {
  if (phase === "succeeded") return "badge success";
  if (phase === "failed" || phase === "abnormal") return "badge danger";
  if (phase === "expired") return "badge expired";
  return "badge";
}

export default function DeploymentsPanel({
  slug,
  env,
  canRerun = false,
  onChange,
}: {
  slug: string;
  env: string;
  /** Rôle EDITOR+ et plan `ci_cd` : la relance est permise à cet utilisateur.
   *  Il faut EN PLUS un jeton sur la connexion (rendu par l'API). */
  canRerun?: boolean;
  /** Prévenu à chaque lecture : la barre d'onglets met sa pastille à jour. */
  onChange?: () => void;
}) {
  const t = useTranslations("projects.deployments");
  const locale = useLocale();
  const [rows, setRows] = useState<DeploymentView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hasToken, setHasToken] = useState(false);
  const [rerunning, setRerunning] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const tPager = useTranslations("projects.backup.pager");

  const load = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/projects/${slug}/${encodeURIComponent(env)}/deployments`,
      );
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as { deployments: DeploymentView[]; canRerun?: boolean };
      setRows(data.deployments);
      setHasToken(Boolean(data.canRerun));
      setError(null);
      onChange?.();
    } catch {
      setError(t("loadError"));
    }
  }, [slug, env, t, onChange]);

  async function rerun(id: string) {
    setRerunning(id);
    setNotice(null);
    setError(null);
    try {
      const res = await fetch(
        `/api/projects/${slug}/${encodeURIComponent(env)}/deployments/${id}/rerun`,
        { method: "POST" },
      );
      const data = (await res.json().catch(() => null)) as
        | { error?: string; details?: string }
        | null;
      if (!res.ok) {
        setNotice(
          [data?.error ?? t("rerunError"), data?.details].filter(Boolean).join(" — "),
        );
        return;
      }
      setNotice(t("rerunDone"));
    } finally {
      setRerunning(null);
    }
  }

  useEffect(() => {
    setRows(null);
    setPage(1);
    load();
  }, [load]);

  // Polling seulement tant qu'un déploiement attend son rapport : au-delà de
  // 45 min il passe « expiré » côté serveur, et le polling s'arrête de lui-même.
  const waiting = rows?.some((r) => PENDING.includes(r.phase)) ?? false;
  useEffect(() => {
    if (!waiting) return;
    const id = setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, [waiting, load]);

  if (error) return <p className="error-text">{error}</p>;
  if (rows === null) return <p className="help">{t("loading")}</p>;

  // Pagination côté client : l'API rend au plus 25 lignes (rétention par
  // environnement), affichées par 10.
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const safePage = Math.min(page, pages);
  const pageRows = rows.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  return (
    <div className="flex flex-col gap-3">
      {/* Titre et description resserrés, comme l'onglet Backup. */}
      <div className="section-header" style={{ marginBottom: 0 }}>
        <div>
          <h2 className="section-title">{t("title", { env })}</h2>
          <p className="panel-subtitle">{t("intro")}</p>
        </div>
      </div>
      {notice && (
        <p className="help" role="status" style={{ margin: 0 }}>
          {notice}
        </p>
      )}

      {rows.length === 0 ? (
        <p className="help">{t("empty")}</p>
      ) : (
        <div style={WHITE_CARD}>
        <table className="table">
          <thead>
            <tr>
              <th>{t("colStatus")}</th>
              <th>{t("colRun")}</th>
              <th>{t("colBranch")}</th>
              <th>{t("colWhen")}</th>
              {canRerun && hasToken && <th />}
            </tr>
          </thead>
          <tbody>
            {pageRows.map((r) => {
              // Issue réglée : on dit d'où elle vient (constat chez la plateforme,
              // ou déclaration du pipeline). En attente : le palier.
              const hint =
                r.phase === "succeeded" || r.phase === "failed"
                  ? r.statusSource === "platform"
                    ? t("source.platform")
                    : r.statusSource === "reported"
                      ? t("source.reported")
                      : null
                  : r.phase === "long" || r.phase === "abnormal" || r.phase === "expired"
                    ? t(`hint.${r.phase}`)
                    : null;
              return (
                <tr key={r.id}>
                  <td>
                    <span className={phaseBadgeClass(r.phase)} title={hint ?? undefined}>
                      {t(`phase.${r.phase}`)}
                    </span>
                    {!r.correlated && (
                      <span
                        className="badge danger"
                        title={t("uncorrelatedHint")}
                        style={{ marginLeft: 6 }}
                      >
                        {t("uncorrelated")}
                      </span>
                    )}
                    {hint && (
                      <div className="text-muted" style={{ fontSize: 11, marginTop: 2 }}>
                        {hint}
                      </div>
                    )}
                    {r.detail && (
                      <div className="text-muted" style={{ fontSize: 11 }}>
                        {r.detail}
                      </div>
                    )}
                  </td>
                  <td style={{ fontSize: 12 }}>
                    <span className="code-mono">{r.workflow || r.provider}</span>
                    {r.sha && (
                      <span className="text-muted code-mono"> · {r.sha.slice(0, 7)}</span>
                    )}
                    {r.runUrl && (
                      <div>
                        <a href={r.runUrl} target="_blank" rel="noopener noreferrer">
                          {t("openRun")}
                        </a>
                      </div>
                    )}
                  </td>
                  <td className="text-muted" style={{ fontSize: 12 }}>
                    {r.branch}
                  </td>
                  <td className="text-muted" style={{ fontSize: 12 }}>
                    {new Date(r.reportedAt ?? r.authorizedAt ?? r.createdAt).toLocaleString(
                      locale,
                    )}
                  </td>
                  {canRerun && hasToken && (
                    <td style={{ whiteSpace: "nowrap" }}>
                      {/* Pas de relance d'un run encore en cours. */}
                      {!PENDING.includes(r.phase) && (
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          disabled={rerunning !== null}
                          onClick={() => rerun(r.id)}
                        >
                          {rerunning === r.id ? t("rerunning") : t("rerun")}
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
        {pages > 1 && (
          <div className="flex items-center gap-2" style={{ justifyContent: "flex-end", marginTop: 8 }}>
            <button type="button" className="btn btn-ghost btn-sm" disabled={safePage <= 1} onClick={() => setPage(Math.max(1, safePage - 1))}>
              {tPager("prev")}
            </button>
            <span className="help" style={{ margin: 0 }}>{tPager("info", { page: safePage, pages })}</span>
            <button type="button" className="btn btn-ghost btn-sm" disabled={safePage >= pages} onClick={() => setPage(Math.min(pages, safePage + 1))}>
              {tPager("next")}
            </button>
          </div>
        )}
        </div>
      )}
    </div>
  );
}
