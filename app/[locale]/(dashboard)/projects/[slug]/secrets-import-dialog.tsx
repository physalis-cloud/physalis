"use client";

// Dialog d'import bulk d'un .env vers les Secrets d'un environnement.
// Workflow en 2 etapes : (1) saisie + Analyser (dryRun), (2) preview +
// Importer (execute). On NE montre JAMAIS les valeurs des secrets dans
// la preview — uniquement les cles.

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import {
  SECRET_CATEGORIES,
  SECRET_CATEGORY_LABELS,
  UNCATEGORIZED_LABEL,
  type SecretCategory,
} from "@/lib/categories";

type ConflictPolicy = "skip" | "overwrite";

/** Répartition renvoyée par l'API : combien de clés chaque en-tête de
 *  section a rangées, et combien retombent sur la catégorie par défaut.
 *  La clé `_none` = rangées explicitement « sans catégorie ». */
type CategoryBreakdown = {
  byCategory: Record<string, number>;
  fallback: number;
};

type DryRunResponse = {
  dryRun: true;
  summary: {
    parsed: number;
    toCreate: number;
    toUpdate: number;
    toSkip: number;
    invalid: number;
    parseErrors: number;
  };
  categories: CategoryBreakdown;
  keys: {
    toCreate: string[];
    toUpdate: string[];
    toSkip: string[];
    invalid: { key: string; reason: string }[];
  };
  parseErrors: { line: number; reason: string }[];
};

type ExecuteResponse = {
  dryRun: false;
  summary: {
    parsed: number;
    created: number;
    updated: number;
    recategorized: number;
    skipped: number;
    invalid: number;
    parseErrors: number;
    failed: number;
  };
  categories: CategoryBreakdown;
  keys: {
    created: string[];
    updated: string[];
    skipped: string[];
    invalid: { key: string; reason: string }[];
    failed: { key: string; reason: string }[];
  };
  parseErrors: { line: number; reason: string }[];
};

const ENV_TEXT_MAX = 100 * 1024;

export default function SecretsImportDialog({
  slug,
  env,
  onClose,
  onImported,
}: {
  slug: string;
  env: string;
  onClose: () => void;
  onImported: () => void;
}) {
  const t = useTranslations("projects.secrets.import");
  const [envText, setEnvText] = useState("");
  const [conflictPolicy, setConflictPolicy] =
    useState<ConflictPolicy>("skip");
  const [defaultCategory, setDefaultCategory] = useState<SecretCategory | "">(
    "",
  );
  const [preview, setPreview] = useState<DryRunResponse | null>(null);
  const [result, setResult] = useState<ExecuteResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const url = `/api/projects/${slug}/${env}/secrets/import`;

  function buildBody(dryRun: boolean) {
    return JSON.stringify({
      envText,
      conflictPolicy,
      dryRun,
      defaultCategory: defaultCategory || null,
    });
  }

  function analyze() {
    setError(null);
    if (!envText.trim()) {
      setError("Le contenu .env est vide.");
      return;
    }
    if (envText.length > ENV_TEXT_MAX) {
      setError(`Contenu trop volumineux (max ${Math.round(ENV_TEXT_MAX / 1024)} KB).`);
      return;
    }
    startTransition(async () => {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: buildBody(true),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        setError(data?.error ?? "Analyse impossible.");
        return;
      }
      setPreview((await res.json()) as DryRunResponse);
    });
  }

  function execute() {
    setError(null);
    startTransition(async () => {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: buildBody(false),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        setError(data?.error ?? "Import impossible.");
        return;
      }
      setResult((await res.json()) as ExecuteResponse);
      onImported();
    });
  }

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > ENV_TEXT_MAX) {
      setError(`Fichier trop volumineux (max ${Math.round(ENV_TEXT_MAX / 1024)} KB).`);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setEnvText(String(reader.result ?? ""));
      // Reset preview/result si le user recharge un autre fichier.
      setPreview(null);
      setResult(null);
    };
    reader.readAsText(file);
  }

  // ─── Etape 3 : resultat final ─────────────────────────────────────
  if (result) {
    return (
      <div className="dialog-overlay" onClick={onClose}>
        <div
          className="dialog dialog-lg"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="dialog-header">
            <h2 className="dialog-title">{t("complete")}</h2>
            <button
              type="button"
              onClick={onClose}
              className="dialog-close"
              aria-label="Fermer"
            >
              ✕
            </button>
          </div>
          <div className="dialog-body">
            <ResultSummary result={result} />
          </div>
          <div className="dialog-footer">
            <button
              type="button"
              onClick={onClose}
              className="btn btn-primary btn-sm"
            >
              {t("complete")}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ─── Etape 1 + 2 : saisie + (optionnellement) preview ─────────────
  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog dialog-lg" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-header">
          <h2 className="dialog-title">
            {t("title", { env })}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="dialog-close"
            aria-label="Fermer"
          >
            ✕
          </button>
        </div>
        <div className="dialog-body">
          <div className="field">
            <label htmlFor="envText">{t("contentLabel")}</label>
            <textarea
              id="envText"
              value={envText}
              onChange={(e) => {
                setEnvText(e.target.value);
                setPreview(null);
              }}
              placeholder="DATABASE_URL=postgres://...&#10;API_KEY=..."
              className="textarea input-mono"
              rows={10}
              spellCheck={false}
              autoComplete="off"
            />
            <div className="help">
              Colle ton .env ou charge un fichier. Limite&nbsp;:{" "}
              {Math.round(ENV_TEXT_MAX / 1024)} KB.{" "}
              <label
                style={{
                  display: "inline-block",
                  cursor: "pointer",
                  color: "var(--accent-text)",
                  textDecoration: "underline",
                }}
              >
                {t("fileBtn")}
                <input
                  type="file"
                  accept=".env,text/plain"
                  onChange={onFile}
                  style={{ display: "none" }}
                />
              </label>
            </div>
          </div>

          <div className="form-row">
            <div className="field">
              <label htmlFor="conflictPolicy">{t("conflictLabel")}</label>
              <select
                id="conflictPolicy"
                value={conflictPolicy}
                onChange={(e) => {
                  setConflictPolicy(e.target.value as ConflictPolicy);
                  setPreview(null);
                }}
                className="select"
              >
                <option value="skip">
                  {t("skip")}
                </option>
                <option value="overwrite">
                  {t("overwrite")}
                </option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="defaultCategory">{t("categoryLabel")}</label>
              <select
                id="defaultCategory"
                value={defaultCategory}
                onChange={(e) => {
                  setDefaultCategory(e.target.value as SecretCategory | "");
                  setPreview(null);
                }}
                className="select"
              >
                <option value="">{UNCATEGORIZED_LABEL}</option>
                {SECRET_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {SECRET_CATEGORY_LABELS[c]}
                  </option>
                ))}
              </select>
              <div className="help">{t("categoryHelp")}</div>
            </div>
          </div>

          {error && <p className="error-text">{error}</p>}

          {preview && <PreviewSummary preview={preview} />}
        </div>

        <div className="dialog-footer">
          <button
            type="button"
            onClick={onClose}
            className="btn btn-ghost btn-sm"
          >
            Annuler
          </button>
          {!preview ? (
            <button
              type="button"
              onClick={analyze}
              disabled={pending || !envText.trim()}
              className="btn btn-primary btn-sm"
            >
              {pending ? t("analyzeLoading") : t("analyzeBtn")}
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={() => setPreview(null)}
                className="btn btn-ghost btn-sm"
                disabled={pending}
              >
                Modifier
              </button>
              <button
                type="button"
                onClick={execute}
                disabled={
                  pending ||
                  preview.summary.toCreate + preview.summary.toUpdate === 0
                }
                className="btn btn-primary btn-sm"
              >
                {pending
                  ? t("importLoading")
                  : t("executeBtn", { count: preview.summary.toCreate + preview.summary.toUpdate })}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function PreviewSummary({ preview }: { preview: DryRunResponse }) {
  const t = useTranslations("projects.secrets.import");
  const { summary, keys, parseErrors } = preview;
  return (
    <div
      style={{
        background: "var(--code-bg)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        padding: 12,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div style={{ fontWeight: 600, fontSize: 13 }}>{t("previewTitle")}</div>
      {/* Les pictos (✓ ↻ ⊘ ⚠) font partie des chaînes i18n — ne pas les
          redoubler ici, comme dans ResultSummary plus bas. */}
      <div className="row-meta">
        <span>{t("entries", { count: summary.parsed })}</span>
        <span style={{ color: "var(--success)" }}>
          {t("newCount", { count: summary.toCreate })}
        </span>
        {summary.toUpdate > 0 && (
          <span style={{ color: "var(--accent-text)" }}>
            {t("updateCount", { count: summary.toUpdate })}
          </span>
        )}
        {summary.toSkip > 0 && (
          <span style={{ color: "var(--muted)" }}>
            {t("skipCount", { count: summary.toSkip })}
          </span>
        )}
        {summary.invalid > 0 && (
          <span style={{ color: "var(--danger)" }}>
            {t("invalidCount", { count: summary.invalid })}
          </span>
        )}
      </div>

      <CategoryBreakdownRow breakdown={preview.categories} />

      <KeyList label={t("keyListNew")} keys={keys.toCreate} />
      <KeyList
        label={t("keyListToUpdate")}
        keys={keys.toUpdate}
        color="var(--accent-text)"
      />
      <KeyList label={t("keyListToSkip")} keys={keys.toSkip} />
      {keys.invalid.length > 0 && (
        <div>
          <div className="help" style={{ fontWeight: 600, marginBottom: 4 }}>
            {t("keyListInvalidNames")}
          </div>
          <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12 }}>
            {keys.invalid.map((it, idx) => (
              <li key={`${it.key}-${idx}`}>
                <span className="code-mono">{it.key}</span> — {it.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
      {parseErrors.length > 0 && (
        <div>
          <div className="help" style={{ fontWeight: 600, marginBottom: 4 }}>
            {t("keyListParserWarnings")}
          </div>
          <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12 }}>
            {parseErrors.slice(0, 10).map((e, idx) => (
              <li key={`${e.line}-${idx}`}>
                Ligne {e.line} — {e.reason}
              </li>
            ))}
            {parseErrors.length > 10 && (
              <li>…et {parseErrors.length - 10} autre(s)</li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Ce que les commentaires du fichier ont rangé, et ce qui retombe sur
 *  la catégorie par défaut. Affiché AVANT l'import : c'est la seule
 *  occasion de voir le rangement avant qu'il soit écrit. */
function CategoryBreakdownRow({ breakdown }: { breakdown?: CategoryBreakdown }) {
  const t = useTranslations("projects.secrets.import");
  if (!breakdown) return null;
  const detected = Object.entries(breakdown.byCategory).filter(
    ([, n]) => n > 0,
  );
  if (detected.length === 0 && breakdown.fallback === 0) return null;
  return (
    <div>
      <div className="help" style={{ fontWeight: 600, marginBottom: 4 }}>
        {t("detectedCategories")}
      </div>
      <div className="flex flex-wrap gap-1">
        {detected.length === 0 && (
          <span className="chip">{t("noCategoryDetected")}</span>
        )}
        {detected.map(([cat, n]) => (
          <span key={cat} className="chip">
            {cat === "_none"
              ? UNCATEGORIZED_LABEL
              : (SECRET_CATEGORY_LABELS[cat as SecretCategory] ?? cat)}{" "}
            · {n}
          </span>
        ))}
        {breakdown.fallback > 0 && (
          <span className="chip" style={{ opacity: 0.75 }}>
            {t("fallbackCount", { count: breakdown.fallback })}
          </span>
        )}
      </div>
    </div>
  );
}

function ResultSummary({ result }: { result: ExecuteResponse }) {
  const t = useTranslations("projects.secrets.import");
  const { summary, keys } = result;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div className="row-meta">
        <span style={{ color: "var(--success)" }}>
          {t("resultCreated", { count: summary.created })}
        </span>
        {summary.updated > 0 && (
          <span style={{ color: "var(--accent-text)" }}>
            {t("resultUpdated", { count: summary.updated })}
          </span>
        )}
        {summary.recategorized > 0 && (
          <span style={{ color: "var(--accent-text)" }}>
            {t("resultRecategorized", { count: summary.recategorized })}
          </span>
        )}
        {summary.skipped > 0 && (
          <span style={{ color: "var(--muted)" }}>
            {t("resultSkipped", { count: summary.skipped })}
          </span>
        )}
        {summary.invalid > 0 && (
          <span style={{ color: "var(--danger)" }}>
            {t("resultInvalid", { count: summary.invalid })}
          </span>
        )}
        {summary.failed > 0 && (
          <span style={{ color: "var(--danger)" }}>
            {t("resultFailed", { count: summary.failed })}
          </span>
        )}
      </div>
      <CategoryBreakdownRow breakdown={result.categories} />
      <KeyList label={t("keyListCreated")} keys={keys.created} />
      <KeyList label={t("keyListUpdated")} keys={keys.updated} color="var(--accent-text)" />
      {keys.failed.length > 0 && (
        <div>
          <div className="help" style={{ fontWeight: 600, marginBottom: 4 }}>
            {t("keyListFailed")}
          </div>
          <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12 }}>
            {keys.failed.map((it, idx) => (
              <li key={`${it.key}-${idx}`}>
                <span className="code-mono">{it.key}</span> — {it.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function KeyList({
  label,
  keys,
  color,
}: {
  label: string;
  keys: string[];
  color?: string;
}) {
  if (keys.length === 0) return null;
  const display = keys.slice(0, 30);
  return (
    <div>
      <div
        className="help"
        style={{ fontWeight: 600, marginBottom: 4, color }}
      >
        {label} ({keys.length})
      </div>
      <div className="flex flex-wrap gap-1">
        {display.map((k) => (
          <span key={k} className="chip code-mono">
            {k}
          </span>
        ))}
        {keys.length > display.length && (
          <span className="chip">+{keys.length - display.length}</span>
        )}
      </div>
    </div>
  );
}
