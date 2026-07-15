"use client";

// Phase 11c — UI gestion des OrgToken (tokens org-level pour N8n / Make).
//
// Réservé OrgADMIN+ (côté serveur via requireOrgMember("ADMIN")).
//
// Sécurité par défaut :
//   - Nouveau token sans projet sélectionné → bouton désactivé
//   - Checkbox "Tous les projets actuels et futurs" avec confirm dialog
//   - Token brut affiché UNE SEULE FOIS après création

import { useCallback, useEffect, useState, useTransition } from "react";
import { Link } from "@/i18n/navigation";
import { useTranslations } from "next-intl";
import { RiKey2Line } from "@remixicon/react";
import EmptyCard from "@/components/EmptyCard";
import { useConfirm } from "@/components/ConfirmDialog";

const SCOPE_LABELS: Record<string, { label: string; description: string }> = {
  PROJECTS_LIST: {
    label: "List projects",
    description: "Required for dynamic loading in the N8n node.",
  },
  SECRETS_READ: {
    label: "Read secrets",
    description: "Decrypted values of environment secrets.",
  },
  SERVICES_READ: {
    label: "Read services",
    description: "Credentials of external services (Stripe, Firebase…).",
  },
  ACCOUNTS_READ: {
    label: "Read application accounts",
    description: "Test/admin account credentials.",
  },
};

const SCOPE_ORDER = ["PROJECTS_LIST", "SECRETS_READ", "SERVICES_READ", "ACCOUNTS_READ"] as const;
type Scope = (typeof SCOPE_ORDER)[number];

const EXPIRY_OPTIONS: Array<{ label: string; days: number | null }> = [
  { label: "Never", days: null },
  { label: "30 days", days: 30 },
  { label: "90 days", days: 90 },
  { label: "1 year (365 days)", days: 365 },
];

type ProjectOption = { id: string; slug: string; name: string };

type OrgToken = {
  id: string;
  name: string;
  description: string | null;
  prefix: string;
  allProjects: boolean;
  allowedProjectIds: string[];
  allowedScopes: Scope[];
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  createdByEmail: string | null;
};

type AccessLevel = "admin" | "dev" | "denied";

type DevConstraints = {
  maxExpiresInDays: number;
  maxActiveTokensPerUser: number;
};

export default function OrgTokensPanel({ slug }: { slug: string }) {
  const t = useTranslations("orgs.tokens");
  const confirm = useConfirm();
  const [tokens, setTokens] = useState<OrgToken[] | null>(null);
  const [projects, setProjects] = useState<ProjectOption[] | null>(null);
  const [accessLevel, setAccessLevel] = useState<AccessLevel>("dev");
  const [devConstraints, setDevConstraints] = useState<DevConstraints | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [justCreated, setJustCreated] = useState<{
    token: string;
    name: string;
  } | null>(null);

  const reload = useCallback(async () => {
    setError(null);
    const res = await fetch(`/api/orgs/${slug}/org-tokens`);
    if (!res.ok) {
      setError(t("loadError"));
      return;
    }
    const data = (await res.json()) as {
      tokens: OrgToken[];
      accessLevel: AccessLevel;
      devConstraints: DevConstraints | null;
    };
    setTokens(data.tokens);
    setAccessLevel(data.accessLevel);
    setDevConstraints(data.devConstraints);
  }, [slug]);

  // Charge la liste des projets de l'org pour le selector. Endpoint
  // session-based (pas integrations) : retourne tous les projets de l'org
  // visibles par l'OrgADMIN courant.
  const loadProjects = useCallback(async () => {
    const res = await fetch(`/api/orgs/${slug}/projects`);
    if (!res.ok) return;
    const data = (await res.json()) as { projects: ProjectOption[] };
    setProjects(data.projects);
  }, [slug]);

  useEffect(() => {
    reload();
    loadProjects();
  }, [reload, loadProjects]);

  async function regenerate(tok: OrgToken) {
    if (!(await confirm({ message: t("regenerateConfirm", { name: tok.name }), danger: true }))) {
      return;
    }
    const res = await fetch(
      `/api/orgs/${slug}/org-tokens/${tok.id}/regenerate`,
      { method: "POST" },
    );
    const data = (await res.json().catch(() => null)) as
      | { token?: string; error?: string }
      | null;
    if (!res.ok || !data?.token) {
      setError(data?.error ?? t("regenerateError"));
      return;
    }
    setJustCreated({ token: data.token, name: tok.name });
    reload();
  }

  async function revoke(tok: OrgToken) {
    if (!(await confirm({ message: t("revokeConfirm", { name: tok.name }), danger: true }))) {
      return;
    }
    const res = await fetch(`/api/orgs/${slug}/org-tokens/${tok.id}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      setError(t("revokeError"));
      return;
    }
    reload();
  }

  function isActive(t: OrgToken): boolean {
    if (t.revokedAt) return false;
    if (t.expiresAt && new Date(t.expiresAt).getTime() < Date.now()) return false;
    return true;
  }

  return (
    <section className="flex flex-col gap-4">
      <div className="section-header">
        <div>
          <h2 className="section-title">{t("title")}</h2>
          <p className="help" style={{ marginTop: 4 }}>
            {t("desc")}
          </p>
          {accessLevel === "dev" && devConstraints && (
            <p
              className="help"
              style={{
                marginTop: 6,
                fontSize: 11,
                background: "rgba(99, 102, 241, 0.08)",
                border: "1px solid rgba(99, 102, 241, 0.25)",
                padding: "6px 10px",
                borderRadius: 4,
              }}
            >
              {t("devModeNote", { days: devConstraints.maxExpiresInDays, max: devConstraints.maxActiveTokensPerUser })}
            </p>
          )}
        </div>
        {!creating && !justCreated && tokens && tokens.length > 0 && (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="btn btn-primary btn-sm"
          >
            {t("createBtn")}
          </button>
        )}
      </div>

      {error && <p className="error-text">{error}</p>}

      {justCreated && (
        <JustCreatedBanner
          token={justCreated.token}
          name={justCreated.name}
          onClose={() => setJustCreated(null)}
        />
      )}

      {creating && (
        <CreateForm
          slug={slug}
          projects={projects ?? []}
          accessLevel={accessLevel}
          devConstraints={devConstraints}
          onCancel={() => setCreating(false)}
          onCreated={(token, name) => {
            setCreating(false);
            setJustCreated({ token, name });
            reload();
          }}
        />
      )}

      {tokens === null ? (
        <p className="help">{t("loading")}</p>
      ) : tokens.length === 0 && !creating && !justCreated ? (
        <EmptyCard
          icon={<RiKey2Line size={22} aria-hidden />}
          title={t("empty")}
          hint={t("emptyHint")}
          action={
            !creating && !justCreated ? (
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => setCreating(true)}
              >
                {t("createBtn")}
              </button>
            ) : undefined
          }
        />
      ) : (
        <div className="row-list">
          {tokens.map((tok) => {
            const active = isActive(tok);
            const projectCount = tok.allProjects
              ? t("allProjectsWarning")
              : t("projectCount", { n: tok.allowedProjectIds.length });
            return (
              <div key={tok.id} className="row" style={{ opacity: active ? 1 : 0.55 }}>
                <div className="row-icon"><RiKey2Line size={18} aria-hidden /></div>
                <div className="row-info">
                  <div className="row-name">
                    {tok.name}
                    <code className="code-mono" style={{ fontSize: 11, marginLeft: 6 }}>
                      {tok.prefix}…
                    </code>
                    {!active && (
                      <span
                        className="chip"
                        style={{
                          marginLeft: 6,
                          fontSize: 10,
                          background: "rgba(239, 68, 68, 0.15)",
                          color: "#ef4444",
                        }}
                      >
                        {tok.revokedAt ? t("revokedStatus") : t("expiredStatus")}
                      </span>
                    )}
                    {tok.allProjects && (
                      <span
                        className="chip"
                        style={{
                          marginLeft: 6,
                          fontSize: 10,
                          background: "rgba(249, 115, 22, 0.15)",
                          color: "#f97316",
                        }}
                      >
                        {t("allProjectsWarning")}
                      </span>
                    )}
                  </div>
                  <div className="row-meta">
                    <span>{projectCount}</span>
                    <span>· {tok.allowedScopes.length} scope{tok.allowedScopes.length === 1 ? "" : "s"}</span>
                    {tok.lastUsedAt && (
                      <span title={new Date(tok.lastUsedAt).toLocaleString()}>
                        · {t("lastUsed", { time: relativeTime(tok.lastUsedAt, t) })}
                      </span>
                    )}
                    {tok.expiresAt && (
                      <span title={new Date(tok.expiresAt).toLocaleString()}>
                        · {t("expires", { time: relativeTime(tok.expiresAt, t) })}
                      </span>
                    )}
                    {tok.createdByEmail && (
                      <span className="text-muted" style={{ fontSize: 11 }}>
                        · {t("createdBy", { email: tok.createdByEmail })}
                      </span>
                    )}
                  </div>
                  {tok.description && (
                    <div className="row-meta" style={{ marginTop: 2 }}>
                      <span className="help" style={{ fontSize: 11 }}>{tok.description}</span>
                    </div>
                  )}
                  {tok.allowedScopes.length > 0 && (
                    <div className="flex flex-wrap gap-1" style={{ marginTop: 4 }}>
                      {tok.allowedScopes.map((s) => (
                        <span key={s} className="chip" style={{ fontSize: 10 }}>
                          {s === "PROJECTS_LIST" ? t("form.scopeProjects")
                            : s === "SECRETS_READ" ? t("form.scopeSecrets")
                            : s === "SERVICES_READ" ? t("form.scopeServices")
                            : s === "ACCOUNTS_READ" ? t("form.scopeAccounts")
                            : s}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                {active && (
                  <div className="row-actions">
                    <button
                      type="button"
                      onClick={() => regenerate(tok)}
                      className="btn btn-ghost btn-xs"
                    >
                      {t("regenerateBtn")}
                    </button>
                    <button
                      type="button"
                      onClick={() => revoke(tok)}
                      className="btn btn-danger btn-xs"
                    >
                      {t("revokeBtn")}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function CreateForm({
  slug,
  projects,
  accessLevel,
  devConstraints,
  onCancel,
  onCreated,
}: {
  slug: string;
  projects: ProjectOption[];
  accessLevel: AccessLevel;
  devConstraints: DevConstraints | null;
  onCancel: () => void;
  onCreated: (token: string, name: string) => void;
}) {
  const t = useTranslations("orgs.tokens");
  const confirm = useConfirm();
  const isDev = accessLevel === "dev";
  // Pour DEV : pas d'option "Jamais", limite à devConstraints.maxExpiresInDays.
  const expiryOptions = isDev && devConstraints
    ? EXPIRY_OPTIONS.filter(
        (o) => o.days !== null && o.days <= devConstraints.maxExpiresInDays,
      )
    : EXPIRY_OPTIONS;

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [scopes, setScopes] = useState<Set<Scope>>(new Set(["PROJECTS_LIST"]));
  const [allProjects, setAllProjects] = useState(false);
  const [selectedProjects, setSelectedProjects] = useState<Set<string>>(new Set());
  const [expiresInDays, setExpiresInDays] = useState<number | null>(
    isDev && devConstraints ? Math.min(90, devConstraints.maxExpiresInDays) : 365,
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function toggleScope(s: Scope) {
    const next = new Set(scopes);
    if (next.has(s)) next.delete(s);
    else next.add(s);
    setScopes(next);
  }

  function toggleProject(id: string) {
    const next = new Set(selectedProjects);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedProjects(next);
  }

  async function handleAllProjectsToggle(checked: boolean) {
    if (checked) {
      const ok = await confirm({ message: t("form.allProjectsConfirm") });
      if (!ok) return;
    }
    setAllProjects(checked);
  }

  const canSubmit =
    name.trim().length > 0 &&
    scopes.size > 0 &&
    (allProjects || selectedProjects.size > 0) &&
    !pending;

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!canSubmit) return;
    setError(null);
    startTransition(async () => {
      const res = await fetch(`/api/orgs/${slug}/org-tokens`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim() || null,
          scopes: Array.from(scopes),
          allProjects,
          allowedProjectIds: allProjects ? [] : Array.from(selectedProjects),
          expiresInDays,
        }),
      });
      const data = (await res.json().catch(() => null)) as
        | { token?: string; error?: string }
        | null;
      if (!res.ok || !data?.token) {
        setError(data?.error ?? t("createError"));
        return;
      }
      onCreated(data.token, name.trim());
    });
  }

  return (
    <form onSubmit={submit} className="card" style={{ padding: 16 }}>
      <h3 className="section-title" style={{ fontSize: 14, marginBottom: 12 }}>
        {t("form.title")}
      </h3>

      <div className="form-row">
        <div className="field" style={{ minWidth: 240, flex: 1 }}>
          <label>{t("form.nameLabel")}</label>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("form.namePlaceholder")}
            className="input"
            disabled={pending}
            required
          />
        </div>
        <div className="field" style={{ minWidth: 180 }}>
          <label>{t("form.expiryLabel")}</label>
          <select
            value={expiresInDays === null ? "never" : String(expiresInDays)}
            onChange={(e) =>
              setExpiresInDays(e.target.value === "never" ? null : Number(e.target.value))
            }
            className="select"
            disabled={pending}
          >
            {expiryOptions.map((o) => (
              <option key={o.label} value={o.days === null ? "never" : String(o.days)}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="field" style={{ marginTop: 8 }}>
        <label>{t("form.descLabel")}</label>
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t("form.descPlaceholder")}
          className="input"
          disabled={pending}
        />
      </div>

      <div className="field" style={{ marginTop: 12 }}>
        <label>{t("form.scopesLabel")}</label>
        <div className="flex flex-col gap-1.5" style={{ marginTop: 4 }}>
          {SCOPE_ORDER.map((s) => (
            <label
              key={s}
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 8,
                cursor: "pointer",
                fontSize: 13,
              }}
            >
              <input
                type="checkbox"
                checked={scopes.has(s)}
                onChange={() => toggleScope(s)}
                disabled={pending}
                style={{ marginTop: 3, cursor: "pointer" }}
              />
              <div>
                <div>
                  {s === "PROJECTS_LIST" ? t("form.scopeProjects")
                    : s === "SECRETS_READ" ? t("form.scopeSecrets")
                    : s === "SERVICES_READ" ? t("form.scopeServices")
                    : t("form.scopeAccounts")}
                </div>
                <div className="help" style={{ fontSize: 11 }}>
                  {s === "PROJECTS_LIST" ? t("form.scopeProjectsDesc")
                    : s === "SECRETS_READ" ? t("form.scopeSecretsDesc")
                    : s === "SERVICES_READ" ? t("form.scopeServicesDesc")
                    : t("form.scopeAccountsDesc")}
                </div>
              </div>
            </label>
          ))}
        </div>
      </div>

      <div className="field" style={{ marginTop: 12 }}>
        <label>{t("form.projectsLabel")}</label>
        <div className="help" style={{ fontSize: 11, marginBottom: 6 }}>
          {t("form.projectsHint")}
        </div>
        {projects.length === 0 ? (
          <p className="help">{t("form.noProjects")}</p>
        ) : (
          <div
            className="flex flex-col gap-1"
            style={{
              maxHeight: 200,
              overflowY: "auto",
              padding: 6,
              border: "1px solid var(--border, rgba(255,255,255,0.1))",
              borderRadius: 4,
              opacity: allProjects ? 0.4 : 1,
            }}
          >
            {projects.map((p) => (
              <label
                key={p.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  cursor: allProjects ? "not-allowed" : "pointer",
                  fontSize: 13,
                  padding: "2px 4px",
                }}
              >
                <input
                  type="checkbox"
                  checked={selectedProjects.has(p.id)}
                  onChange={() => toggleProject(p.id)}
                  disabled={pending || allProjects}
                  style={{ cursor: "inherit" }}
                />
                <span>{p.name}</span>
                <code className="code-mono text-muted" style={{ fontSize: 11 }}>
                  {p.slug}
                </code>
              </label>
            ))}
          </div>
        )}
        {!isDev && (
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginTop: 8,
              cursor: "pointer",
              fontSize: 13,
              color: allProjects ? "#f97316" : "inherit",
            }}
          >
            <input
              type="checkbox"
              checked={allProjects}
              onChange={(e) => handleAllProjectsToggle(e.target.checked)}
              disabled={pending}
              style={{ cursor: "pointer" }}
            />
            <span>
              {t("form.allProjects")}
            </span>
          </label>
        )}
        {isDev && (
          <p className="help" style={{ fontSize: 11, marginTop: 8 }}>
            {t("form.allProjectsNote")}
          </p>
        )}
      </div>

      {error && <p className="error-text" style={{ marginTop: 10 }}>{error}</p>}

      <div className="flex items-center gap-2" style={{ marginTop: 14 }}>
        <button type="submit" disabled={!canSubmit} className="btn btn-primary btn-sm">
          {pending ? t("form.submittingBtn") : t("form.submitBtn")}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="btn btn-ghost btn-sm"
          disabled={pending}
        >
          {t("cancelBtn")}
        </button>
      </div>
    </form>
  );
}

function JustCreatedBanner({
  token,
  name,
  onClose,
}: {
  token: string;
  name: string;
  onClose: () => void;
}) {
  const t = useTranslations("orgs.tokens");
  const [savedToVault, setSavedToVault] = useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");

  async function saveToVault() {
    setSavedToVault("saving");
    const res = await fetch("/api/vault/entries", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: `OrgToken: ${name}`,
        username: null,
        password: token,
        tags: ["physalis-token", "n8n"],
      }),
    });
    setSavedToVault(res.ok ? "saved" : "error");
  }

  return (
    <div
      className="card"
      style={{
        padding: 14,
        background: "rgba(34, 197, 94, 0.08)",
        border: "1px solid rgba(34, 197, 94, 0.3)",
      }}
    >
      <div className="row-name" style={{ marginBottom: 6 }}>
        {t("created", { name })}
      </div>
      <p className="help" style={{ marginBottom: 8 }}>
        {t("saveNow")}
      </p>
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <code
          className="code-mono"
          style={{
            flex: 1,
            padding: "8px 10px",
            background: "var(--surface-hover, rgba(0,0,0,0.2))",
            borderRadius: 4,
            wordBreak: "break-all",
            fontSize: 12,
          }}
        >
          {token}
        </code>
        <button
          type="button"
          onClick={() => {
            navigator.clipboard.writeText(token).catch(() => null);
          }}
          className="btn btn-primary btn-sm"
        >
          {t("copyBtn")}
        </button>
        <button
          type="button"
          onClick={onClose}
          className="btn btn-ghost btn-sm"
        >
          {t("doneBtn")}
        </button>
      </div>
      <div
        className="flex items-center gap-2"
        style={{ marginTop: 8, flexWrap: "wrap" }}
      >
        <button
          type="button"
          onClick={saveToVault}
          disabled={savedToVault === "saving" || savedToVault === "saved"}
          className="btn btn-ghost btn-xs"
          title={t("saveToVaultTitle")}
        >
          {savedToVault === "saved"
            ? t("savedToVault")
            : savedToVault === "saving"
              ? t("savingToVault")
              : savedToVault === "error"
                ? t("saveToVaultError")
                : t("saveToVaultBtn")}
        </button>
        {savedToVault === "saved" && (
          <span className="help" style={{ fontSize: 11 }}>
            {t.rich("savedToVaultNote", {
              name,
              link: (chunks) => <Link href="/vault" className="text-accent">{chunks}</Link>,
            })}
          </span>
        )}
      </div>
      <p className="help" style={{ marginTop: 10, fontSize: 11 }}>
        {t("n8nConfigNote")}
      </p>
    </div>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TFunc = (key: string, values?: any) => string;

function relativeTime(iso: string, t: TFunc): string {
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) return "";
  const diff = ms - Date.now();
  const abs = Math.abs(diff);
  const future = diff > 0;
  const sec = Math.floor(abs / 1000);
  if (sec < 60) return future ? t("relTime.inSeconds") : t("relTime.justNow");
  const min = Math.floor(sec / 60);
  if (min < 60) return future ? t("relTime.inMinutes", { n: min }) : t("relTime.minutesAgo", { n: min });
  const hr = Math.floor(min / 60);
  if (hr < 24) return future ? t("relTime.inHours", { n: hr }) : t("relTime.hoursAgo", { n: hr });
  const day = Math.floor(hr / 24);
  if (day < 30) return future ? t("relTime.inDays", { n: day }) : t("relTime.daysAgo", { n: day });
  const month = Math.floor(day / 30);
  if (month < 12) return future ? t("relTime.inMonths", { n: month }) : t("relTime.monthsAgo", { n: month });
  const year = Math.floor(day / 365);
  return future ? t("relTime.inYears", { n: year }) : t("relTime.yearsAgo", { n: year });
}
