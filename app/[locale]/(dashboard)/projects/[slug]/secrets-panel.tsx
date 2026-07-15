"use client";

import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import type { ProjectRole } from "@prisma/client";
import { RiDownload2Line, RiHistoryLine, RiKey2Line, RiUpload2Line } from "@remixicon/react";
import EmptyCard from "@/components/EmptyCard";
import { useTranslations } from "next-intl";
import {
  SECRET_CATEGORIES,
  SECRET_CATEGORY_LABELS,
  UNCATEGORIZED_LABEL,
  type SecretCategory,
} from "@/lib/categories";
import SecretHistoryDialog from "@/components/SecretHistoryDialog";
import TagsInput from "@/components/TagsInput";
import SecretsImportDialog from "./secrets-import-dialog";
import { useConfirm } from "@/components/ConfirmDialog";
import ImmediateRotationSection from "@/components/ImmediateRotationSection";

type RotationStrategy = "DATABASE" | "JWT_SECRET" | "REMINDER" | "API_KEY" | "WEBHOOK";

type SecretListItem = {
  key: string;
  category: SecretCategory | null;
  tags: string[];
  updatedAt: string;
  rotationEnabled: boolean;
  rotationStrategy: RotationStrategy | null;
};

const ROLE_RANK: Record<ProjectRole, number> = {
  VIEWER: 1,
  EDITOR: 2,
  OWNER: 3,
};

export default function SecretsPanel({
  slug,
  env,
  role,
  rotationFeatureEnabled,
  orgSlug,
}: {
  slug: string;
  env: string;
  role: ProjectRole;
  rotationFeatureEnabled: boolean;
  orgSlug: string;
}) {
  const t = useTranslations("projects.secrets");
  const confirm = useConfirm();
  const [secrets, setSecrets] = useState<SecretListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [editKey, setEditKey] = useState<string | null>(null);
  const [historyKey, setHistoryKey] = useState<string | null>(null);
  const [rotationKey, setRotationKey] = useState<string | null>(null);
  const [rotationCategory, setRotationCategory] = useState<string | null>(null);

  const canEdit = ROLE_RANK[role] >= ROLE_RANK.EDITOR;

  // Suggestions de tags = tags existants chez ce projet/env, dédupliqués.
  const allTags = useMemo<string[]>(() => {
    if (!secrets) return [];
    const set = new Set<string>();
    for (const s of secrets) for (const tag of s.tags) set.add(tag);
    return Array.from(set).sort();
  }, [secrets]);

  const reload = useCallback(async () => {
    setError(null);
    const res = await fetch(`/api/projects/${slug}/${env}/secrets`);
    if (!res.ok) {
      setError(t("updateError"));
      return;
    }
    const data = (await res.json()) as { secrets: SecretListItem[] };
    setSecrets(data.secrets);
  }, [slug, env]);

  useEffect(() => {
    setSecrets(null);
    setRevealed({});
    setEditKey(null);
    setAdding(false);
    reload();
  }, [reload]);

  const grouped = useMemo<
    { category: SecretCategory | null; label: string; items: SecretListItem[] }[]
  >(() => {
    if (!secrets) return [];
    const buckets = new Map<SecretCategory | null, SecretListItem[]>();
    for (const s of secrets) {
      const arr = buckets.get(s.category) ?? [];
      arr.push(s);
      buckets.set(s.category, arr);
    }
    const result: {
      category: SecretCategory | null;
      label: string;
      items: SecretListItem[];
    }[] = [];
    for (const cat of SECRET_CATEGORIES) {
      const items = buckets.get(cat);
      if (items && items.length > 0) {
        result.push({ category: cat, label: SECRET_CATEGORY_LABELS[cat], items });
      }
    }
    const uncategorized = buckets.get(null);
    if (uncategorized && uncategorized.length > 0) {
      result.push({ category: null, label: UNCATEGORIZED_LABEL, items: uncategorized });
    }
    return result;
  }, [secrets]);

  async function reveal(key: string) {
    if (revealed[key] !== undefined) {
      setRevealed((r) => {
        const copy = { ...r };
        delete copy[key];
        return copy;
      });
      return;
    }
    const res = await fetch(
      `/api/projects/${slug}/${env}/secrets/${encodeURIComponent(key)}`,
    );
    if (!res.ok) {
      setError(t("deleteError"));
      return;
    }
    const data = (await res.json()) as { value: string };
    setRevealed((r) => ({ ...r, [key]: data.value }));
  }

  async function remove(key: string) {
    if (!(await confirm({ message: t("deleteConfirm", { key }), danger: true }))) return;
    const res = await fetch(
      `/api/projects/${slug}/${env}/secrets/${encodeURIComponent(key)}`,
      { method: "DELETE" },
    );
    if (!res.ok) {
      setError(t("deleteError"));
      return;
    }
    setRevealed((r) => {
      const copy = { ...r };
      delete copy[key];
      return copy;
    });
    reload();
  }

  async function updateCategory(key: string, category: SecretCategory | "") {
    setError(null);
    const res = await fetch(
      `/api/projects/${slug}/${env}/secrets/${encodeURIComponent(key)}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ category: category === "" ? null : category }),
      },
    );
    if (!res.ok) {
      setError(t("updateError"));
      return;
    }
    reload();
  }

  function renderRow(s: SecretListItem) {
    if (editKey === s.key && canEdit) {
      return (
        <div className="card">
          <SecretForm
            slug={slug}
            env={env}
            initialKey={s.key}
            initialCategory={s.category}
            initialTags={s.tags}
            allTags={allTags}
            onCancel={() => setEditKey(null)}
            onSaved={() => {
              setEditKey(null);
              setRevealed((r) => {
                const copy = { ...r };
                delete copy[s.key];
                return copy;
              });
              reload();
            }}
          />
        </div>
      );
    }
    return (
      <div className="row">
        <div className="row-icon"><RiKey2Line size={18} aria-hidden /></div>
        <div className="row-info">
          <div className="row-name code-mono" style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            {s.key}
            {s.rotationEnabled && (
              <span
                className="chip"
                style={{ fontSize: 10, background: "rgba(99, 102, 241, 0.15)", color: "#6366f1", fontFamily: "inherit" }}
                title={`Rotation automatique (${s.rotationStrategy ?? ""})`}
              >
                ↻
              </span>
            )}
          </div>
          <div className="row-meta">
            <span className="code-mono">
              {revealed[s.key] !== undefined ? revealed[s.key] : "••••••••••••"}
            </span>
            {s.tags.length > 0 && (
              <span className="flex flex-wrap gap-1">
                {s.tags.map((t) => (
                  <span key={t} className="chip" style={{ fontSize: 10 }}>
                    {t}
                  </span>
                ))}
              </span>
            )}
          </div>
        </div>
        <div className="row-actions">
          <button
            type="button"
            onClick={() => reveal(s.key)}
            className="btn btn-ghost btn-xs"
          >
            {revealed[s.key] !== undefined ? t("hideBtn") : t("revealBtn")}
          </button>
          {canEdit && (
            <>
              <button
                type="button"
                onClick={() => setHistoryKey(s.key)}
                className="btn btn-ghost btn-xs"
                title={t("historyBtn")}
              >
                <RiHistoryLine size={12} aria-hidden /> {t("historyBtn")}
              </button>
              {rotationFeatureEnabled && (s.rotationEnabled || isRotationCandidate(s.key)) && (
                <button
                  type="button"
                  onClick={() => { setRotationKey(s.key); setRotationCategory(s.category ?? null); }}
                  className="btn btn-ghost btn-xs"
                  title="Configurer la rotation automatique"
                >
                  Rotation
                </button>
              )}
              <button
                type="button"
                onClick={() => setEditKey(s.key)}
                className="btn btn-ghost btn-xs"
              >
                {t("editBtn")}
              </button>
              <button
                type="button"
                onClick={() => remove(s.key)}
                className="btn btn-danger btn-xs"
              >
                {t("deleteBtn")}
              </button>
              <select
                value={s.category ?? ""}
                onChange={(e) =>
                  updateCategory(s.key, e.target.value as SecretCategory | "")
                }
                title={t("categoryLabel")}
                className="select"
                style={{ width: "auto", padding: "4px 8px", fontSize: 11 }}
              >
                <option value="">— {UNCATEGORIZED_LABEL} —</option>
                {SECRET_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {SECRET_CATEGORY_LABELS[c]}
                  </option>
                ))}
              </select>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="section-header">
        <h2 className="section-title">
          {t("title", { env })}
        </h2>
        {!adding && (
          <div className="flex items-center gap-2">
            {canEdit && (
              <button
                type="button"
                onClick={() => setImporting(true)}
                className="btn btn-ghost btn-sm"
                title={t("importBtn")}
              >
                <RiUpload2Line size={14} aria-hidden /> {t("importBtn")}
              </button>
            )}
            <a
              href={`/api/projects/${slug}/${env}/secrets/export`}
              download={`.env.${orgSlug}-${slug}-${env}`}
              className="btn btn-ghost btn-sm"
              title={t("exportBtn")}
            >
              <RiDownload2Line size={14} aria-hidden /> {t("exportBtn")}
            </a>
            {canEdit && secrets && secrets.length > 0 && (
              <button
                type="button"
                onClick={() => setAdding(true)}
                className="btn btn-primary btn-sm"
              >
                {t("addBtn")}
              </button>
            )}
          </div>
        )}
      </div>

      {importing && canEdit && (
        <SecretsImportDialog
          slug={slug}
          env={env}
          onClose={() => setImporting(false)}
          onImported={() => reload()}
        />
      )}

      {adding && canEdit && (
        <div className="create-card">
          <SecretForm
            slug={slug}
            env={env}
            onCancel={() => setAdding(false)}
            onSaved={() => {
              setAdding(false);
              reload();
            }}
          />
        </div>
      )}

      {error && <p className="error-text">{error}</p>}

      {secrets === null ? (
        <p className="help">{t("empty")}</p>
      ) : secrets.length === 0 && !adding ? (
        <EmptyCard
          icon={<RiKey2Line size={22} aria-hidden />}
          title={t("empty")}
          action={
            canEdit && !adding ? (
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => setAdding(true)}
              >
                {t("addBtn")}
              </button>
            ) : undefined
          }
        />
      ) : (
        <div className="flex flex-col gap-4">
          {grouped.map((group) => (
            <section
              key={group.category ?? "_none"}
              className="flex flex-col gap-1.5"
            >
              <div className="cat-header">
                <span>{group.label}</span>
                <span className="cat-count">({group.items.length})</span>
              </div>
              <div className="row-list">
                {group.items.map((s) => (
                  <div key={s.key}>{renderRow(s)}</div>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      {historyKey && (
        <SecretHistoryDialog
          apiBaseUrl={`/api/projects/${slug}/${env}/secrets/${encodeURIComponent(historyKey)}/versions`}
          secretKey={historyKey}
          onClose={() => setHistoryKey(null)}
          onRestored={() => {
            setRevealed({});
            reload();
          }}
        />
      )}

      {rotationKey && (
        <SecretRotationDialog
          slug={slug}
          env={env}
          orgSlug={orgSlug}
          secretKey={rotationKey}
          category={rotationCategory}
          onClose={() => { setRotationKey(null); setRotationCategory(null); reload(); }}
        />
      )}
    </div>
  );
}

function SecretForm({
  slug,
  env,
  initialKey,
  initialCategory,
  initialTags,
  allTags,
  onCancel,
  onSaved,
}: {
  slug: string;
  env: string;
  initialKey?: string;
  initialCategory?: SecretCategory | null;
  initialTags?: string[];
  allTags?: string[];
  onCancel: () => void;
  onSaved: () => void;
}) {
  const t = useTranslations("projects.secrets");
  const [key, setKey] = useState(initialKey ?? "");
  const [value, setValue] = useState("");
  const [category, setCategory] = useState<SecretCategory | "">(
    initialCategory ?? "",
  );
  const [tags, setTags] = useState<string[]>(initialTags ?? []);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const isEdit = Boolean(initialKey);

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      let url: string;
      let method: "POST" | "PATCH";
      let body: Record<string, unknown>;
      if (isEdit) {
        // PATCH partiel : on envoie uniquement ce qui a change. La valeur
        // reste inchangee en base si le champ est laisse vide. La cle peut
        // changer (newKey) ; le serveur verifie l'unicite.
        url = `/api/projects/${slug}/${env}/secrets/${encodeURIComponent(initialKey!)}`;
        method = "PATCH";
        body = {
          category: category === "" ? null : category,
          tags,
        };
        if (value !== "") body.value = value;
        if (key !== initialKey) body.newKey = key;
      } else {
        // Creation : POST upsert (valeur obligatoire).
        url = `/api/projects/${slug}/${env}/secrets`;
        method = "POST";
        body = {
          key,
          value,
          category: category === "" ? null : category,
          tags,
        };
      }

      try {
        const res = await fetch(url, {
          method,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => null)) as
            | { error?: string }
            | null;
          setError(data?.error ?? t("updateError"));
          return;
        }
        onSaved();
      } catch {
        // Réseau coupé / connexion perdue : `fetch` throw (TypeError) au lieu
        // de renvoyer !res.ok. Sans ce catch, l'échec était silencieux (aucun
        // message). On affiche l'erreur pour que l'utilisateur puisse réessayer.
        setError(t("updateError"));
      }
    });
  }

  return (
    <form onSubmit={onSubmit}>
      <div className="form-row">
        <div className="field" style={{ minWidth: 200 }}>
          <label>{t("form.keyLabel")}</label>
          <input
            required
            value={key}
            onChange={(e) => setKey(e.target.value.toUpperCase())}
            placeholder={t("form.keyPlaceholder")}
            className="input input-mono"
          />
          {isEdit && key !== initialKey && (
            <div className="help">
              {t("form.renameNote")}
            </div>
          )}
        </div>
        <div className="field" style={{ minWidth: 240, flex: 2 }}>
          <label>{t(isEdit ? "form.valueLabelOptional" : "form.valueLabel")}</label>
          <input
            required={!isEdit}
            autoFocus={isEdit}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={t("form.valuePlaceholder")}
            className="input input-mono"
          />
        </div>
      </div>
      <div className="form-row" style={{ marginTop: 8 }}>
        <div className="field" style={{ maxWidth: 280 }}>
          <label>{t("categoryLabel")}</label>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value as SecretCategory | "")}
            className="select"
          >
            <option value="">— {UNCATEGORIZED_LABEL} —</option>
            {SECRET_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {SECRET_CATEGORY_LABELS[c]}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="field" style={{ marginTop: 8 }}>
        <label>
          {t("form.tagsLabel")}{" "}
          <span className="text-muted" style={{ fontSize: 11 }}>
            {t("form.tagsNote")}
          </span>
        </label>
        <TagsInput value={tags} onChange={setTags} suggestions={allTags ?? []} />
      </div>
      {error && (
        <p className="error-text" style={{ marginTop: 8 }}>
          {error}
        </p>
      )}
      <div className="flex items-center gap-2" style={{ marginTop: 10 }}>
        <button
          type="submit"
          disabled={pending}
          className="btn btn-primary btn-sm"
        >
          {pending ? t("form.submitBtn") : isEdit ? t("form.updateBtn") : t("form.submitBtn")}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="btn btn-ghost btn-sm"
        >
          {t("form.cancelBtn")}
        </button>
      </div>
    </form>
  );
}

type RotationConfig = {
  rotationEnabled: boolean;
  rotationStrategy: RotationStrategy | null;
  rotationIntervalDays: number | null;
  rotationNeedsFullDeploy: boolean;
  rotationLastAt: string | null;
  rotationNextAt: string | null;
  rotationLastStatus: string | null;
  rotationErrorCount: number;
  dbHost: string | null;
  dbPort: number | null;
  dbName: string | null;
  dbType: string | null;
  dbUser: string | null;
  rotationExecMode: string | null;
  apiKeyId: string | null;
  apiKey: { apiId: string } | null;
  rotationWebhookUrl: string | null;
  rotationHookLabel: string | null;
  rotationHookToken: string | null;
};

type DetectedDb = {
  prefix: string;
  dbHost: string | null;
  dbPort: number | null;
  dbName: string | null;
  dbType: string | null;
  dbUser: string | null;
};


const DB_TYPE_LABELS: Record<string, string> = {
  POSTGRESQL: "PostgreSQL",
  MYSQL: "MySQL",
  MONGODB: "MongoDB",
};

// Strategy labels are now built dynamically in the component using t()

// Les 4 stratégies sont TOUJOURS sélectionnables dans la modale (plus de
// restriction dure par catégorie, qui créait des culs-de-sac). Le tri se fait
// sur deux axes séparés :
//  - isRotationCandidate(key) : faut-il proposer le bouton « Rotation » ? (tri
//    positif par NOM, large — l'ambigu passe car la modale laisse choisir)
//  - defaultRotationStrategy(...) : quelle stratégie pré-sélectionner (défaut
//    SÛR : une stratégie destructive — JWT_SECRET, DATABASE — n'est jamais le
//    défaut sur un nom incertain ; l'ambigu retombe sur REMINDER non destructif)
const ALL_STRATEGIES: RotationStrategy[] = ["DATABASE", "JWT_SECRET", "API_KEY", "WEBHOOK", "REMINDER"];

// Tri positif large : le nom dénote-t-il un credential rotable ?
function isRotationCandidate(key: string): boolean {
  const k = key.toLowerCase();
  const tokens = ["password", "passwd", "pwd", "secret", "token", "apikey", "api_key", "credential", "auth", "jwt", "session", "private"];
  if (tokens.some((tok) => k.includes(tok))) return true;
  // « key » en mot délimité : API_KEY, ENCRYPTION_KEY, SECRET_KEY, KEY…
  return /(?:^|[_-])keys?(?:$|[_-])/.test(k);
}

// Défaut SÛR : ambigu → REMINDER (non destructif). hasInternalApiKey = le secret
// est lié à une clé de la gateway Physalis (signal exact, pas le nom).
function defaultRotationStrategy(key: string, category: string | null, hasInternalApiKey: boolean): RotationStrategy {
  if (hasInternalApiKey) return "API_KEY";
  const k = key.toLowerCase();
  if (/(password|passwd|pwd)/.test(k)) return "DATABASE";
  // Random interne légitime à régénérer localement — HAUTE confiance uniquement
  // (on exclut secret_key/app_secret : ambigus avec STRIPE_SECRET_KEY & co.).
  const internalRandom = ["jwt", "signing", "session_secret", "nextauth_secret", "cron_secret", "encryption_key"];
  if (internalRandom.some((tok) => k.includes(tok))) return "JWT_SECRET";
  if (category === "database") return "DATABASE";
  if (category === "infra") return "JWT_SECRET";
  return "REMINDER";
}

function SecretRotationDialog({
  slug,
  env,
  secretKey,
  category,
  onClose,
}: {
  slug: string;
  env: string;
  orgSlug: string;
  secretKey: string;
  category: string | null;
  onClose: () => void;
}) {
  const t = useTranslations("projects.secrets.rotation");
  const confirm = useConfirm();
  // Pré-sélection à l'ouverture (avant fetch) : nom + catégorie, sans le signal
  // ApiKey interne (inconnu tant que la config n'est pas chargée).
  const defaultStrategy = defaultRotationStrategy(secretKey, category, false);
  const STRATEGY_LABELS: Record<RotationStrategy, string> = {
    DATABASE: t("strategyDatabase"),
    JWT_SECRET: t("strategyJwtSecret"),
    REMINDER: t("strategyReminder"),
    API_KEY: t("strategyApiKey"),
    WEBHOOK: t("strategyWebhook"),
  };

  const [config, setConfig] = useState<RotationConfig | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [strategy, setStrategy] = useState<RotationStrategy>(defaultStrategy);
  const [intervalDays, setIntervalDays] = useState<string>("30");
  const [dbHost, setDbHost] = useState<string>("");
  const [dbPort, setDbPort] = useState<string>("");
  const [dbName, setDbName] = useState<string>("");
  const [dbType, setDbType] = useState<string>("POSTGRESQL");
  const [dbUser, setDbUser] = useState<string>("");
  // AGENT = DB Docker-interne (sidecar self-rotation) ; DIRECT = DB managée joignable.
  const [execMode, setExecMode] = useState<string>("AGENT");
  const [detected, setDetected] = useState<DetectedDb[]>([]);
  const [detecting, setDetecting] = useState(false);
  const [needsFullDeploy, setNeedsFullDeploy] = useState(false);
  const [webhookUrl, setWebhookUrl] = useState<string>("");
  const [hookLabel, setHookLabel] = useState<string>("");
  const [hookToken, setHookToken] = useState<string>("");
  const [apiKeyId, setApiKeyId] = useState<string>("");
  const [apis, setApis] = useState<{ id: string; name: string }[]>([]);
  const [selectedApiId, setSelectedApiId] = useState<string>("");
  const [apiKeys, setApiKeys] = useState<{ id: string; name: string; keyPrefix: string; revokedAt: string | null }[]>([]);
  const [loadingKeys, setLoadingKeys] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    fetch(`/api/projects/${slug}/${env}/secrets/${encodeURIComponent(secretKey)}/rotation`)
      .then((r) => r.json() as Promise<{ rotation: RotationConfig }>)
      .then((data) => {
        const r = data.rotation;
        setConfig(r);
        setEnabled(r.rotationEnabled);
        setStrategy(r.rotationStrategy ?? defaultRotationStrategy(secretKey, category, !!r.apiKey || !!r.apiKeyId));
        setIntervalDays(r.rotationIntervalDays ? String(r.rotationIntervalDays) : "30");
        setDbHost(r.dbHost ?? "");
        setDbPort(r.dbPort ? String(r.dbPort) : "");
        setDbName(r.dbName ?? "");
        setDbType(r.dbType ?? "POSTGRESQL");
        setDbUser(r.dbUser ?? "");
        setExecMode(r.rotationExecMode ?? "AGENT");
        setApiKeyId(r.apiKeyId ?? "");
        setSelectedApiId(r.apiKey?.apiId ?? "");
        setNeedsFullDeploy(r.rotationNeedsFullDeploy ?? false);
        setWebhookUrl(r.rotationWebhookUrl ?? "");
        setHookLabel(r.rotationHookLabel ?? "");
        setHookToken(r.rotationHookToken ?? "");
      })
      .catch(() => setError(t("loading")));

    // Charge les APIs du projet pour la stratégie API_KEY
    fetch(`/api/gateway/apis?project=${slug}`)
      .then((r) => r.ok ? r.json() as Promise<{ apis: { id: string; name: string }[] }> : Promise.resolve({ apis: [] }))
      .then((data) => setApis(data.apis ?? []))
      .catch(() => null);
  }, [slug, env, secretKey, category]);

  useEffect(() => {
    if (!selectedApiId) { setApiKeys([]); return; }
    setLoadingKeys(true);
    fetch(`/api/gateway/apis/${selectedApiId}/keys`)
      .then((r) => r.ok ? r.json() as Promise<{ keys: { id: string; name: string; keyPrefix: string; revokedAt: string | null }[] }> : Promise.resolve({ keys: [] }))
      .then((data) => setApiKeys((data.keys ?? []).filter((k) => !k.revokedAt)))
      .catch(() => null)
      .finally(() => setLoadingKeys(false));
  }, [selectedApiId]);

  function applyDetected(d: DetectedDb) {
    if (d.dbHost) setDbHost(d.dbHost);
    if (d.dbPort) setDbPort(String(d.dbPort));
    if (d.dbName) setDbName(d.dbName);
    if (d.dbType) setDbType(d.dbType);
    if (d.dbUser) setDbUser(d.dbUser);
    setDetected([]);
  }

  function autoDetect() {
    setDetecting(true);
    fetch(`/api/projects/${slug}/${env}/secrets/db-detect`)
      .then(async (r) => {
        if (!r.ok) return;
        const d = (await r.json()) as { detected: DetectedDb[] };
        const groups = d.detected ?? [];
        if (groups.length === 1) {
          applyDetected(groups[0]);
        } else {
          setDetected(groups);
        }
      })
      .catch(() => null)
      .finally(() => setDetecting(false));
  }

  function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    // Validation client : ne pas enregistrer une config qui n'échouerait
    // qu'au cron (DATABASE sans connexion, API_KEY sans clé sélectionnée).
    if (enabled && strategy === "DATABASE" && (!dbHost.trim() || !dbName.trim() || !dbUser.trim())) {
      setError(t("validationDbFields"));
      return;
    }
    if (enabled && strategy === "API_KEY" && !apiKeyId) {
      setError(t("validationApiKey"));
      return;
    }
    if (enabled && strategy === "WEBHOOK" && !webhookUrl.trim()) {
      setError(t("validationWebhookUrl"));
      return;
    }
    startTransition(async () => {
      const body: Record<string, unknown> = {
        rotationEnabled: enabled,
        rotationStrategy: enabled ? strategy : null,
        rotationIntervalDays: enabled && intervalDays ? Number(intervalDays) : null,
      };
      if (enabled && strategy === "DATABASE") {
        body.dbHost = dbHost || null;
        body.dbPort = dbPort ? Number(dbPort) : null;
        body.dbName = dbName || null;
        body.dbType = dbType || null;
        body.dbUser = dbUser || null;
        body.rotationExecMode = execMode;
      }
      if (enabled && strategy === "API_KEY") {
        body.apiKeyId = apiKeyId || null;
      }
      if (enabled && strategy === "WEBHOOK") {
        body.rotationWebhookUrl = webhookUrl.trim() || null;
        body.rotationHookLabel = hookLabel.trim() || null;
        body.rotationHookToken = hookToken.trim() || null;
        body.rotationExecMode = execMode;
      }
      body.rotationNeedsFullDeploy = needsFullDeploy;
      const res = await fetch(
        `/api/projects/${slug}/${env}/secrets/${encodeURIComponent(secretKey)}/rotation`,
        { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
      );
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? t("saveError"));
        return;
      }
      onClose();
    });
  }

  // Rotation immédiate pour une stratégie AUTO = forcer la rotation maintenant
  // (rend le secret dû / déclenche hors fenêtre). Confirmation bloquante.
  async function forceNow() {
    setError(null);
    if (!(await confirm({ message: t("forceConfirm") }))) return;
    startTransition(async () => {
      const res = await fetch(
        `/api/projects/${slug}/${env}/secrets/${encodeURIComponent(secretKey)}/rotation/force`,
        { method: "POST" },
      );
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? t("saveError"));
        return;
      }
      onClose();
    });
  }

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog dialog-lg" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-header">
          <h2 className="dialog-title">
            {t("dialogTitle", { key: secretKey })}
          </h2>
          <button type="button" onClick={onClose} className="dialog-close" aria-label={t("closeLabel")}>✕</button>
        </div>

        <div className="dialog-body">
          {config === null ? (
            <p className="help">{t("loading")}</p>
          ) : (
            <form onSubmit={save} className="flex flex-col gap-4">
              {config.rotationLastStatus && (
                <div
                  style={{
                    padding: "8px 12px", borderRadius: 4, fontSize: 13,
                    background: config.rotationLastStatus === "success" ? "rgba(34,197,94,0.1)" : "rgba(239,68,68,0.1)",
                    border: `1px solid ${config.rotationLastStatus === "success" ? "rgba(34,197,94,0.3)" : "rgba(239,68,68,0.3)"}`,
                  }}
                >
                  {t("lastStatus")} <strong>{config.rotationLastStatus === "success" ? t("lastStatusSuccess") : t("lastStatusError", { count: config.rotationErrorCount })}</strong>
                  {config.rotationLastAt && (
                    <span className="text-muted" style={{ marginLeft: 8, fontSize: 11 }}>
                      {new Date(config.rotationLastAt).toLocaleString()}
                    </span>
                  )}
                  {config.rotationNextAt && (
                    <span className="text-muted" style={{ marginLeft: 8, fontSize: 11 }}>
                      {t("nextAt", { date: new Date(config.rotationNextAt).toLocaleString() })}
                    </span>
                  )}
                </div>
              )}

              <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} disabled={pending} />
                <span>{t("enableLabel")}</span>
              </label>

              {enabled && (
                <>
                  <div className="field">
                    <label>{t("strategyLabel")}</label>
                    <select value={strategy} onChange={(e) => setStrategy(e.target.value as RotationStrategy)} className="select" disabled={pending}>
                      {ALL_STRATEGIES.map((s) => (
                        <option key={s} value={s}>{STRATEGY_LABELS[s]}</option>
                      ))}
                    </select>
                  </div>

                  <div className="field">
                    <label>{t("intervalLabel")}</label>
                    <input type="number" value={intervalDays} onChange={(e) => setIntervalDays(e.target.value)} min={1} max={3650} className="input" style={{ maxWidth: 120 }} disabled={pending} placeholder="30" />
                  </div>

                  {strategy === "DATABASE" && (
                    <>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                        <span className="help" style={{ fontSize: 12 }}>{t("dbConnectionLabel")}</span>
                        <button type="button" onClick={autoDetect} disabled={detecting || pending} className="btn btn-ghost btn-xs">
                          {detecting ? t("detectingBtn") : t("detectBtn")}
                        </button>
                      </div>

                      {detected.length > 1 && (
                        <div className="card" style={{ padding: 10 }}>
                          <p className="help" style={{ marginBottom: 6 }}>{t("multipleGroupsHint")}</p>
                          {detected.map((d) => (
                            <button key={d.prefix} type="button" onClick={() => applyDetected(d)} className="btn btn-ghost btn-xs" style={{ display: "block", marginBottom: 4, textAlign: "left" }}>
                              <strong>{d.prefix}</strong> — {d.dbHost}:{d.dbPort}/{d.dbName} ({d.dbType ?? "?"})
                            </button>
                          ))}
                        </div>
                      )}

                      <div className="form-row">
                        <div className="field" style={{ flex: 2 }}>
                          <label>{t("dbTypeLabel")}</label>
                          <select value={dbType} onChange={(e) => setDbType(e.target.value)} className="select" disabled={pending}>
                            {Object.entries(DB_TYPE_LABELS).map(([k, v]) => (
                              <option key={k} value={k}>{v}</option>
                            ))}
                          </select>
                        </div>
                        <div className="field" style={{ flex: 3 }}>
                          <label>{t("dbHostLabel")} <span style={{ fontSize: "0.85em", textTransform: "lowercase" }}>({t("dbHostNote")})</span></label>
                          <input value={dbHost} onChange={(e) => setDbHost(e.target.value)} placeholder="db.example.com" className="input" disabled={pending} />
                        </div>
                        <div className="field" style={{ width: 80 }}>
                          <label>{t("dbPortLabel")}</label>
                          <input value={dbPort} onChange={(e) => setDbPort(e.target.value)} type="number" placeholder="5432" className="input" disabled={pending} />
                        </div>
                      </div>

                      <div className="form-row" style={{ alignItems: "flex-start" }}>
                        <div className="field" style={{ flex: 1 }}>
                          <label>{t("dbNameLabel")}</label>
                          <input value={dbName} onChange={(e) => setDbName(e.target.value)} placeholder="myapp_prod" className="input input-mono" disabled={pending} />
                        </div>
                        <div className="field" style={{ flex: 1 }}>
                          <label>{t("dbUserLabel")}</label>
                          <input value={dbUser} onChange={(e) => setDbUser(e.target.value)} placeholder="app_user" className="input input-mono" disabled={pending} />
                          <p className="help" style={{ fontSize: 11, marginTop: 2 }}>{t("dbUserNote")}</p>
                        </div>
                      </div>

                      <div className="form-row">
                        <div className="field" style={{ flex: 1 }}>
                          <label>{t("execModeLabel")}</label>
                          <select value={execMode} onChange={(e) => setExecMode(e.target.value)} className="select" disabled={pending}>
                            <option value="AGENT">{t("execModeAgent")}</option>
                            <option value="DIRECT">{t("execModeDirect")}</option>
                          </select>
                          <p className="help" style={{ fontSize: 11, marginTop: 2 }}>{t("execModeNote")}</p>
                        </div>
                      </div>

                    </>
                  )}

                  {strategy === "JWT_SECRET" && (
                    <p className="help" style={{ fontSize: 12 }}>
                      {t("jwtHint")}
                    </p>
                  )}

                  {strategy === "REMINDER" && (
                    <p className="help" style={{ fontSize: 12 }}>
                      {t("reminderHint")}
                    </p>
                  )}

                  {strategy === "WEBHOOK" && (
                    <>
                      <p className="help" style={{ fontSize: 12 }}>{t("webhookHint")}</p>
                      <div className="field">
                        <label>{t("webhookUrlLabel")} *</label>
                        <input value={webhookUrl} onChange={(e) => setWebhookUrl(e.target.value)} placeholder="http://app:3000/internal/rotate" className="input input-mono" disabled={pending} autoComplete="off" name="rotation-hook-url" />
                      </div>
                      <div className="field">
                        <label>{t("hookLabelLabel")}</label>
                        <input value={hookLabel} onChange={(e) => setHookLabel(e.target.value)} placeholder={t("hookLabelPlaceholder")} className="input" disabled={pending} />
                      </div>
                      <div className="field">
                        <label>{t("hookTokenLabel")}</label>
                        <input value={hookToken} onChange={(e) => setHookToken(e.target.value)} type="password" autoComplete="new-password" name="rotation-hook-token" placeholder={t("hookTokenPlaceholder")} className="input input-mono" disabled={pending} />
                        <p className="help" style={{ fontSize: 11, marginTop: 2 }}>{t("hookTokenNote")}</p>
                      </div>
                      <div className="field">
                        <label>{t("execModeLabel")}</label>
                        <select value={execMode} onChange={(e) => setExecMode(e.target.value)} className="select" disabled={pending}>
                          <option value="AGENT">{t("hookExecAgent")}</option>
                          <option value="DIRECT">{t("hookExecDirect")}</option>
                        </select>
                        <p className="help" style={{ fontSize: 11, marginTop: 2 }}>{t("hookExecNote")}</p>
                      </div>
                    </>
                  )}

                  {strategy !== "REMINDER" && (
                    <div className="field">
                      <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", userSelect: "none" }}>
                        <input
                          type="checkbox"
                          checked={needsFullDeploy}
                          onChange={(e) => setNeedsFullDeploy(e.target.checked)}
                          disabled={pending}
                        />
                        <span style={{ fontSize: 13 }}>
                          {t("fullDeployLabel")}
                          <span className="help" style={{ display: "block", fontSize: 11, fontWeight: "normal" }}>
                            {t("fullDeployNote")}
                          </span>
                        </span>
                      </label>
                    </div>
                  )}

                  {strategy === "API_KEY" && (
                    <>
                      <p className="help" style={{ fontSize: 12 }}>
                        {t("apiKeyHint")}
                      </p>
                      <div style={{ background: "rgba(234,179,8,0.08)", border: "1px solid rgba(234,179,8,0.3)", borderRadius: 6, padding: "8px 12px", fontSize: 12, lineHeight: 1.6 }}>
                        {t("apiKeyWarning")}
                      </div>
                      {apis.length === 0 ? (
                        <p className="help" style={{ fontSize: 12, color: "var(--warning)" }}>
                          {t("noApiConfigured")}
                        </p>
                      ) : (
                        <div className="form-row" style={{ alignItems: "flex-start" }}>
                          <div className="field" style={{ flex: 1 }}>
                            <label>{t("apiLabel")}</label>
                            <select
                              value={selectedApiId}
                              onChange={(e) => { setSelectedApiId(e.target.value); setApiKeyId(""); }}
                              className="select"
                              disabled={pending}
                            >
                              <option value="">{t("selectApiPlaceholder")}</option>
                              {apis.map((a) => (
                                <option key={a.id} value={a.id}>{a.name}</option>
                              ))}
                            </select>
                          </div>
                          <div className="field" style={{ flex: 1 }}>
                            <label>{t("activeKeyLabel")}</label>
                            <select
                              value={apiKeyId}
                              onChange={(e) => setApiKeyId(e.target.value)}
                              className="select"
                              disabled={pending || !selectedApiId || loadingKeys}
                            >
                              <option value="">
                                {loadingKeys ? t("loadingKeys") : selectedApiId ? t("selectKeyPlaceholder") : t("selectApiFirst")}
                              </option>
                              {apiKeys.map((k) => (
                                <option key={k.id} value={k.id}>{k.name} ({k.keyPrefix}…)</option>
                              ))}
                            </select>
                            <p className="help" style={{ fontSize: 11, marginTop: 2 }}>
                              {t("activeKeyNote")}
                            </p>
                          </div>
                        </div>
                      )}
                    </>
                  )}
                </>
              )}

              {/* Rotation immédiate — basée sur la config SAUVEGARDÉE (config),
                  pas le formulaire en cours. REMINDER → section assistée ;
                  stratégie auto activée → bouton Forcer. */}
              {config?.rotationStrategy === "REMINDER" && (
                <ImmediateRotationSection
                  endpoint={`/api/projects/${slug}/${env}/secrets/${encodeURIComponent(secretKey)}/rotation/mark-rotated`}
                  payloadKey="newValue"
                  onDone={onClose}
                />
              )}
              {config?.rotationEnabled && config.rotationStrategy && config.rotationStrategy !== "REMINDER" && (
                <div className="field" style={{ borderTop: "1px solid var(--border, rgba(0,0,0,0.1))", paddingTop: 12, marginTop: 4 }}>
                  <label>{t("forceHeading")}</label>
                  <p className="help" style={{ fontSize: 11, marginTop: 0, marginBottom: 6 }}>{t("forceHint")}</p>
                  <button type="button" onClick={forceNow} disabled={pending} className="btn btn-secondary btn-sm">
                    {t("forceBtn")}
                  </button>
                </div>
              )}

              {error && <p className="error-text">{error}</p>}

              <div className="flex items-center gap-2">
                <button type="submit" disabled={pending} className="btn btn-primary btn-sm">
                  {pending ? t("savingBtn") : t("saveBtn")}
                </button>
                <button type="button" onClick={onClose} className="btn btn-ghost btn-sm" disabled={pending}>
                  {t("cancelBtn")}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
