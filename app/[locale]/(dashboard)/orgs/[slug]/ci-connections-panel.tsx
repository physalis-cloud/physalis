"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import type { OrgRole } from "@prisma/client";
import { RiGitBranchLine } from "@remixicon/react";
import EmptyCard from "@/components/EmptyCard";
import { useConfirm } from "@/components/ConfirmDialog";

type Connection = {
  id: string;
  name: string;
  provider: string;
  issuer: string | null;
  projectCount: number;
  syncTargetCount?: number;
  secretsSet: string[];
};

const ORG_ROLE_RANK: Record<OrgRole, number> = {
  MEMBER: 1,
  DEV: 2,
  ADMIN_DEV: 3,
  ADMIN: 4,
  OWNER: 5,
};

export default function CiConnectionsPanel({
  slug,
  role,
}: {
  slug: string;
  role: OrgRole;
}) {
  const t = useTranslations("orgs.cicd");
  const confirm = useConfirm();
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const canManage = ORG_ROLE_RANK[role] >= ORG_ROLE_RANK.ADMIN_DEV;

  const reload = useCallback(async () => {
    setError(null);
    const res = await fetch(`/api/orgs/${slug}/ci-connections`);
    if (!res.ok) {
      setError(t("loadError"));
      return;
    }
    const data = (await res.json()) as { connections: Connection[] };
    setConnections(data.connections);
  }, [slug, t]);

  useEffect(() => {
    setConnections(null);
    setAdding(false);
    reload();
  }, [reload]);

  async function remove(c: Connection) {
    if (!(await confirm({ message: t("deleteConfirm", { name: c.name }), danger: true }))) return;
    const res = await fetch(`/api/orgs/${slug}/ci-connections/${c.id}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      setError(data?.error ?? t("deleteError"));
      return;
    }
    reload();
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="section-header">
        <div>
          <h2 className="section-title">{t("title")}</h2>
          <p className="help" style={{ marginTop: 4 }}>
            {t("desc")}
          </p>
        </div>
        {canManage && !adding && connections && connections.length > 0 && (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="btn btn-primary btn-sm"
          >
            {t("addBtn")}
          </button>
        )}
      </div>

      {adding && canManage && (
        <div className="create-card">
          <ConnectionForm
            slug={slug}
            onCancel={() => setAdding(false)}
            onSaved={() => {
              setAdding(false);
              reload();
            }}
          />
        </div>
      )}

      {error && <p className="error-text">{error}</p>}

      {connections === null ? (
        <p className="help">…</p>
      ) : connections.length === 0 && !adding ? (
        <EmptyCard
          icon={<RiGitBranchLine size={22} aria-hidden />}
          title={t("empty")}
          hint={t("emptyHint")}
          action={
            canManage ? (
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
        <div className="row-list">
          {connections.map((c) =>
            editingId === c.id ? (
              <div key={c.id} className="card">
                <ConnectionForm
                  slug={slug}
                  initial={c}
                  onCancel={() => setEditingId(null)}
                  onSaved={() => {
                    setEditingId(null);
                    reload();
                  }}
                />
              </div>
            ) : (
              <div key={c.id} className="row">
                <div className="row-icon">
                  <RiGitBranchLine size={18} aria-hidden />
                </div>
                <div className="row-info">
                  <div className="row-name">
                    {c.name}{" "}
                    <span className="text-muted code-mono" style={{ fontSize: 12 }}>
                      {c.provider}
                    </span>
                  </div>
                  <div className="row-meta code-mono" style={{ fontSize: 12 }}>
                    {c.issuer && <span>{c.issuer} · </span>}
                    <span>
                      {t("secretsCount", { n: c.secretsSet.length })} ·{" "}
                      {c.provider === "vercel" || c.provider === "render" || c.provider === "railway"
                        ? t("syncTargetsCount", { n: c.syncTargetCount ?? 0 })
                        : t("projectsCount", { n: c.projectCount })}
                    </span>
                  </div>
                </div>
                {canManage && (
                  <div className="row-actions">
                    <button
                      type="button"
                      onClick={() => setEditingId(c.id)}
                      className="btn btn-ghost btn-xs"
                    >
                      {t("editBtn")}
                    </button>
                    <button
                      type="button"
                      onClick={() => remove(c)}
                      className="btn btn-danger btn-xs"
                    >
                      {t("deleteBtn")}
                    </button>
                  </div>
                )}
              </div>
            ),
          )}
        </div>
      )}
    </div>
  );
}

function ConnectionForm({
  slug,
  initial,
  onCancel,
  onSaved,
}: {
  slug: string;
  initial?: Connection;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const t = useTranslations("orgs.cicd");
  const isEdit = Boolean(initial);
  const [name, setName] = useState(initial?.name ?? "");
  const [provider, setProvider] = useState(initial?.provider ?? "github");
  const [issuer, setIssuer] = useState(initial?.issuer ?? "");
  const [redeployToken, setRedeployToken] = useState("");
  const [registryUrl, setRegistryUrl] = useState("");
  const [registryUser, setRegistryUser] = useState("");
  const [registryToken, setRegistryToken] = useState("");
  // Identité Basic auth Bitbucket (email Atlassian / username) — seulement BB.
  const [apiIdentity, setApiIdentity] = useState("");
  const [syncToken, setSyncToken] = useState("");
  // kinds dont la valeur révélée est affichée en clair (sinon champ password).
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // Providers de sync sortante (Vercel/Render/Railway) : formulaire token, pas d'OIDC.
  const isVercel = provider === "vercel";
  const isSync = provider === "vercel" || provider === "render" || provider === "railway";
  // `kind` du token selon le provider de sync (cf. lib/sync/types SYNC_TOKEN_KIND).
  const syncTokenKind =
    provider === "render"
      ? "render_token"
      : provider === "railway"
        ? "railway_token"
        : "vercel_token";
  const syncTokenLabelKey =
    provider === "render"
      ? "renderTokenLabel"
      : provider === "railway"
        ? "railwayTokenLabel"
        : "vercelTokenLabel";
  const syncTokenHelpKey =
    provider === "render"
      ? "renderTokenHelp"
      : provider === "railway"
        ? "railwayTokenHelp"
        : "vercelTokenHelp";

  const has = (kind: string) => initial?.secretsSet.includes(kind) ?? false;
  // En édition, un champ secret laissé vide = inchangé (on ne l'envoie pas).
  const secretPlaceholder = (kind: string) =>
    isEdit && has(kind) ? t("secretKeep") : "";

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const body: Record<string, string | null> = { name: name.trim() };
      if (!isEdit) body.provider = provider;
      if (provider !== "github") body.issuer = issuer.trim();
      if (isSync) {
        // Provider de sync : token (write-only) ; pas de secrets OIDC/registre.
        if (syncToken.trim()) body.syncToken = syncToken.trim();
      } else {
        // Secrets OIDC : on n'envoie que ceux saisis (non vides).
        if (redeployToken.trim()) body.redeployToken = redeployToken.trim();
        if (registryUrl.trim()) body.registryUrl = registryUrl.trim();
        if (registryUser.trim()) body.registryUser = registryUser.trim();
        if (registryToken.trim()) body.registryToken = registryToken.trim();
        if (provider === "bitbucket" && apiIdentity.trim())
          body.apiIdentity = apiIdentity.trim();
      }

      const url = isEdit
        ? `/api/orgs/${slug}/ci-connections/${initial!.id}`
        : `/api/orgs/${slug}/ci-connections`;
      const res = await fetch(url, {
        method: isEdit ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? t("saveError"));
        return;
      }
      onSaved();
    });
  }

  // Reveal d'un secret déjà posé (DEV+) → remplit le champ pour vérif/copie.
  async function reveal(kind: string, setter: (v: string) => void) {
    if (!initial) return;
    const res = await fetch(
      `/api/orgs/${slug}/ci-connections/${initial.id}/secret/${kind}`,
    );
    if (!res.ok) {
      setError(t("revealError"));
      return;
    }
    const data = (await res.json()) as { value: string };
    setter(data.value);
    setRevealed((prev) => new Set(prev).add(kind)); // afficher en clair
  }

  // Champ secret avec bouton « Afficher » en édition (si le secret est posé).
  // Après reveal, le champ password passe en clair (sinon il afficherait des
  // points). autoComplete + name dédié pour éviter l'autofill du navigateur.
  const secretField = (
    label: string,
    kind: string,
    value: string,
    onChange: (v: string) => void,
    placeholder: string,
    type: "text" | "password",
  ) => {
    const isPassword = type === "password";
    const effectiveType = isPassword && revealed.has(kind) ? "text" : type;
    return (
      <div className="field">
        <label className="flex items-center justify-between gap-2">
          <span>{label}</span>
          {isEdit && has(kind) && (
            <button
              type="button"
              className="btn btn-ghost btn-xs"
              onClick={() => reveal(kind, onChange)}
            >
              {t("revealBtn")}
            </button>
          )}
        </label>
        <input
          type={effectiveType}
          name={`ci-${kind}`}
          autoComplete={isPassword ? "new-password" : "off"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="input input-mono"
        />
      </div>
    );
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-2" autoComplete="off">
      <div className="form-row">
        <div className="field">
          <label>{t("nameLabel")}</label>
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("namePlaceholder")}
            className="input"
          />
        </div>
        <div className="field">
          <label>{t("providerLabel")}</label>
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            disabled={isEdit}
            className="select"
          >
            <option value="github">GitHub Actions</option>
            <option value="gitlab">GitLab CI/CD</option>
            <option value="bitbucket">Bitbucket Pipelines</option>
            <option value="vercel">Vercel (sync sortante)</option>
            <option value="render">Render (sync sortante)</option>
            <option value="railway">Railway (sync sortante)</option>
          </select>
        </div>
      </div>

      {!isSync && provider !== "github" && (
        <div className="field">
          <label>{t("issuerLabel")}</label>
          <input
            value={issuer}
            onChange={(e) => setIssuer(e.target.value)}
            placeholder={
              provider === "gitlab"
                ? "https://gitlab.com"
                : "https://api.bitbucket.org/2.0/workspaces/<ws>/pipelines-config/identity/oidc"
            }
            className="input input-mono"
          />
          <p className="help">
            {provider === "gitlab" ? t("issuerHelpGitlab") : t("issuerHelpBitbucket")}
          </p>
        </div>
      )}

      {/* Providers de sync (Vercel/Render) : token ; team optionnel pour Vercel. */}
      {isSync && (
        <>
          {isVercel && (
            <div className="field">
              <label>{t("vercelTeamLabel")}</label>
              <input
                value={issuer}
                onChange={(e) => setIssuer(e.target.value)}
                placeholder={t("vercelTeamPlaceholder")}
                className="input input-mono"
              />
              <p className="help">{t("vercelTeamHelp")}</p>
            </div>
          )}
          <div className="field">
            <label>{t(syncTokenLabelKey)}</label>
            {/* Token write-only : pas de bouton « Afficher » (non relisible). */}
            <input
              type="password"
              name={`ci-${syncTokenKind}`}
              autoComplete="new-password"
              value={syncToken}
              onChange={(e) => setSyncToken(e.target.value)}
              placeholder={isEdit && has(syncTokenKind) ? t("secretKeep") : ""}
              className="input input-mono"
            />
            <p className="help">{t(syncTokenHelpKey)}</p>
          </div>
        </>
      )}

      {/* Registre conteneur + redeploy : providers OIDC uniquement. */}
      {!isSync && (
        <>
          <div
            className="section-title"
            style={{ fontSize: 13, marginTop: 4, marginBottom: 0 }}
          >
            {t("registrySection")}
          </div>
          <p className="help" style={{ marginTop: 0 }}>
            {t("registryNote")}
          </p>
          <div className="form-row">
            {secretField(
              t("registryUrlLabel"),
              "registry_url",
              registryUrl,
              setRegistryUrl,
              has("registry_url") ? secretPlaceholder("registry_url") : "ghcr.io",
              "text",
            )}
            {secretField(
              t("registryUserLabel"),
              "registry_user",
              registryUser,
              setRegistryUser,
              secretPlaceholder("registry_user"),
              "text",
            )}
          </div>
          {secretField(
            t("registryTokenLabel"),
            "registry_token",
            registryToken,
            setRegistryToken,
            secretPlaceholder("registry_token"),
            "password",
          )}

          {/* Token API du provider : lecture du repo (docs projet) + redeploy. */}
          {secretField(
            t("redeployTokenLabel"),
            "redeploy_token",
            redeployToken,
            setRedeployToken,
            secretPlaceholder("redeploy_token"),
            "password",
          )}
          <p className="help">
            {provider === "gitlab"
              ? t("apiTokenHelpGitlab")
              : provider === "bitbucket"
                ? t("apiTokenHelpBitbucket")
                : t("apiTokenHelpGithub")}
          </p>

          {/* Bitbucket : identité pour l'auth Basic (API token ATATT / app
              password). Laisser vide si Access Token ATCTT (Bearer). */}
          {provider === "bitbucket" && (
            <>
              {secretField(
                t("bitbucketIdentityLabel"),
                "api_identity",
                apiIdentity,
                setApiIdentity,
                has("api_identity")
                  ? secretPlaceholder("api_identity")
                  : "you@example.com",
                "text",
              )}
              <p className="help">{t("bitbucketIdentityHelp")}</p>
            </>
          )}
        </>
      )}

      <p className="help">{isSync ? t("vercelSecretsNote") : t("secretsNote")}</p>
      {error && <p className="error-text">{error}</p>}
      <div className="flex items-center gap-2">
        <button type="submit" disabled={pending} className="btn btn-primary btn-sm">
          {isEdit ? t("saveBtn") : t("createBtn")}
        </button>
        <button type="button" onClick={onCancel} className="btn btn-ghost btn-sm">
          {t("cancelBtn")}
        </button>
      </div>
    </form>
  );
}
