"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "@/i18n/navigation";
import { useTranslations } from "next-intl";
import { defaultDeployPath } from "@/lib/validation";
import { useFeature } from "@/components/PlanFeatures";
import { isSyncProvider } from "@/lib/sync/types";
import { useConfirm } from "@/components/ConfirmDialog";

type EnvSummary = {
  id: string;
  name: string;
  url: string | null;
  serverId: string | null;
  deployPath: string | null;
  secretCount: number;
};

type ServerOption = {
  id: string;
  name: string;
  ip: string;
  sshUser: string;
};

export default function SettingsDialog({
  slug,
  orgSlug,
  projectName,
  githubRepo,
  githubWorkflow,
  ciConnectionId,
  ciRepo,
  environments,
  onClose,
}: {
  slug: string;
  orgSlug: string;
  projectName: string;
  githubRepo: string | null;
  githubWorkflow: string | null;
  ciConnectionId: string | null;
  ciRepo: string | null;
  environments: EnvSummary[];
  onClose: () => void;
}) {
  const t = useTranslations("projects.settings");
  const hasCiCd = useFeature("ci_cd");
  const [servers, setServers] = useState<ServerOption[] | null>(null);
  const [serversError, setServersError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch(`/api/orgs/${orgSlug}/servers`);
      if (cancelled) return;
      if (!res.ok) {
        setServers([]);
        if (res.status !== 403) {
          setServersError(t("saveError"));
        }
        return;
      }
      const data = (await res.json()) as { servers: ServerOption[] };
      setServers(data.servers);
    })();
    return () => {
      cancelled = true;
    };
  }, [orgSlug]);

  return (
    <div className="dialog-overlay">
      <div className="dialog dialog-lg">
        <div className="dialog-header">
          <h2 className="dialog-title">{t("title")}</h2>
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
          <ProjectNameSection slug={slug} initialName={projectName} />
          {hasCiCd && (
            <CiSection
              slug={slug}
              orgSlug={orgSlug}
              initialConnectionId={ciConnectionId}
              initialGithubRepo={githubRepo}
              initialGithubWorkflow={githubWorkflow}
              initialCiRepo={ciRepo}
            />
          )}
          <EnvironmentsSection
            slug={slug}
            environments={environments}
            servers={servers}
            serversError={serversError}
          />
          <DeleteProjectSection slug={slug} projectName={projectName} onClose={onClose} />
        </div>
      </div>
    </div>
  );
}

// Zone dangereuse en bas de la modale Paramètres : suppression définitive du
// projet (cascade tenant + purge des résidus admin/externe côté API). Garde-fou
// : il faut retaper le slug du projet pour activer le bouton.
function DeleteProjectSection({
  slug,
  projectName,
  onClose,
}: {
  slug: string;
  projectName: string;
  onClose: () => void;
}) {
  const t = useTranslations("projects.settings");
  const [open, setOpen] = useState(false);

  return (
    <section className="settings-section danger-zone">
      <div className="settings-section-title danger-zone-title">
        {t("dangerZoneTitle")}
      </div>
      <p className="danger-zone-text">{t("deleteHint")}</p>
      <button
        type="button"
        className="btn btn-danger btn-sm"
        onClick={() => setOpen(true)}
      >
        {t("deleteProjectBtn")}
      </button>
      {open && (
        <DeleteProjectDialog
          slug={slug}
          projectName={projectName}
          onCancel={() => setOpen(false)}
          onDeleted={onClose}
        />
      )}
    </section>
  );
}

function DeleteProjectDialog({
  slug,
  projectName,
  onCancel,
  onDeleted,
}: {
  slug: string;
  projectName: string;
  onCancel: () => void;
  /** Appelé après suppression réussie (ferme la modale Paramètres). */
  onDeleted: () => void;
}) {
  const t = useTranslations("projects.settings");
  const router = useRouter();
  const [confirmText, setConfirmText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const matches = confirmText.trim() === slug;

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!matches) return;
    setError(null);
    startTransition(async () => {
      const res = await fetch(`/api/projects/${slug}`, { method: "DELETE" });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        setError(data?.error ?? t("deleteError"));
        return;
      }
      // Le projet n'existe plus → on sort vers la liste des projets.
      onDeleted();
      router.push("/projects");
      router.refresh();
    });
  }

  return (
    <div className="dialog-overlay" onClick={onCancel}>
      <div className="dialog" onClick={(e) => e.stopPropagation()} role="alertdialog">
        <div className="dialog-header">
          <h2 className="dialog-title">{t("deleteDialogTitle")}</h2>
          <button
            type="button"
            onClick={onCancel}
            className="dialog-close"
            aria-label={t("deleteCancelBtn")}
          >
            ✕
          </button>
        </div>
        <form onSubmit={submit}>
          <div className="dialog-body">
            <p style={{ margin: 0 }}>
              {t("deleteWarning", { name: projectName })}
            </p>
            <div className="field">
              <label htmlFor="delete-project-confirm">
                {t("deleteConfirmLabel")} <code>{slug}</code>
              </label>
              <input
                id="delete-project-confirm"
                autoFocus
                autoComplete="off"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder={slug}
                className="input"
              />
            </div>
            {error && <p className="error-text">{error}</p>}
          </div>
          <div className="dialog-footer">
            <button
              type="button"
              onClick={onCancel}
              className="btn btn-ghost btn-sm"
              disabled={pending}
            >
              {t("deleteCancelBtn")}
            </button>
            <button
              type="submit"
              disabled={!matches || pending}
              className="btn btn-danger btn-sm"
            >
              {pending ? t("deletingBtn") : t("deleteSubmitBtn")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

type CiConnectionOption = {
  id: string;
  name: string;
  provider: string;
};

function CiSection({
  slug,
  orgSlug,
  initialConnectionId,
  initialGithubRepo,
  initialGithubWorkflow,
  initialCiRepo,
}: {
  slug: string;
  orgSlug: string;
  initialConnectionId: string | null;
  initialGithubRepo: string | null;
  initialGithubWorkflow: string | null;
  initialCiRepo: string | null;
}) {
  const t = useTranslations("projects.settings");
  const router = useRouter();
  const [connections, setConnections] = useState<CiConnectionOption[] | null>(
    null,
  );
  const [connectionId, setConnectionId] = useState(initialConnectionId ?? "");
  const [githubRepo, setGithubRepo] = useState(initialGithubRepo ?? "");
  const [githubWorkflow, setGithubWorkflow] = useState(
    initialGithubWorkflow ?? "",
  );
  const [ciRepo, setCiRepo] = useState(initialCiRepo ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch(`/api/orgs/${orgSlug}/ci-connections`);
      if (cancelled || !res.ok) return;
      const data = (await res.json()) as { connections: CiConnectionOption[] };
      // Cette section configure le déploiement OIDC : on exclut les connexions de
      // sync sortante (Vercel/Render), qui se relient dans le sous-onglet « Sync »
      // de l'environnement, pas ici.
      setConnections(data.connections.filter((c) => !isSyncProvider(c.provider)));
    })();
    return () => {
      cancelled = true;
    };
  }, [orgSlug]);

  const provider =
    connections?.find((c) => c.id === connectionId)?.provider ?? "github";

  const dirty =
    connectionId !== (initialConnectionId ?? "") ||
    githubRepo.trim() !== (initialGithubRepo ?? "") ||
    githubWorkflow.trim() !== (initialGithubWorkflow ?? "") ||
    ciRepo.trim() !== (initialCiRepo ?? "");

  function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const body: Record<string, string | null> = {
        ciConnectionId: connectionId === "" ? null : connectionId,
      };
      if (provider === "github") {
        const r = githubRepo.trim();
        const w = githubWorkflow.trim();
        body.githubRepo = r === "" ? null : r;
        body.githubWorkflow = w === "" ? null : w;
      } else {
        const r = ciRepo.trim();
        body.ciRepo = r === "" ? null : r;
      }

      const res = await fetch(`/api/projects/${slug}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        setError(data?.error ?? t("saveError"));
        return;
      }
      router.refresh();
    });
  }

  return (
    <section>
      <h3 className="section-title" style={{ fontSize: 14, marginBottom: 8 }}>
        {t("ciSection")}
      </h3>
      <form onSubmit={save} className="flex flex-col gap-2">
        <div className="field">
          <label>{t("ciConnectionLabel")}</label>
          <select
            value={connectionId}
            onChange={(e) => setConnectionId(e.target.value)}
            className="select"
          >
            <option value="">{t("ciConnectionNone")}</option>
            {connections?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.provider})
              </option>
            ))}
          </select>
          {connections?.length === 0 && (
            <p className="help">{t("ciNoConnections")}</p>
          )}
        </div>

        {connectionId !== "" &&
          (provider === "github" ? (
            <>
              <div className="field">
                <label>{t("githubRepoLabel")}</label>
                <input
                  value={githubRepo}
                  onChange={(e) => setGithubRepo(e.target.value)}
                  placeholder={t("githubRepoPlaceholder")}
                  className="input input-mono"
                />
              </div>
              <div className="field">
                <label>{t("githubWorkflowLabel")}</label>
                <input
                  value={githubWorkflow}
                  onChange={(e) => setGithubWorkflow(e.target.value)}
                  placeholder={t("githubWorkflowPlaceholder")}
                  className="input input-mono"
                />
              </div>
            </>
          ) : provider === "gitlab" ? (
            <div className="field">
              <label>{t("gitlabRepoLabel")}</label>
              <input
                value={ciRepo}
                onChange={(e) => setCiRepo(e.target.value)}
                placeholder="group/projet"
                className="input input-mono"
              />
            </div>
          ) : (
            <div className="field">
              <label>{t("bitbucketRepoLabel")}</label>
              <input
                value={ciRepo}
                onChange={(e) => setCiRepo(e.target.value)}
                placeholder="{11111111-2222-3333-4444-555555555555}"
                className="input input-mono"
              />
              <p className="help">{t("bitbucketRepoHelp")}</p>
            </div>
          ))}

        <p className="help">{t("ciNote")}</p>
        {error && <p className="error-text">{error}</p>}
        <div>
          <button
            type="submit"
            disabled={!dirty || pending}
            className="btn btn-primary btn-sm"
          >
            {pending ? "..." : t("saveBtn")}
          </button>
        </div>
      </form>
    </section>
  );
}

function ProjectNameSection({
  slug,
  initialName,
}: {
  slug: string;
  initialName: string;
}) {
  const t = useTranslations("projects.settings");
  const confirm = useConfirm();
  const router = useRouter();
  const [name, setName] = useState(initialName);
  const [slugInput, setSlugInput] = useState(slug);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const trimmedName = name.trim();
  const trimmedSlug = slugInput.trim();
  const slugChanged = trimmedSlug !== slug;
  const nameChanged = trimmedName !== initialName && trimmedName.length > 0;
  const dirty = nameChanged || (slugChanged && trimmedSlug.length > 0);

  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    if (slugChanged) {
      const ok = await confirm({ message: t("slugChangeConfirm", { old: slug, new: trimmedSlug }) });
      if (!ok) return;
    }
    startTransition(async () => {
      const body: Record<string, string> = {};
      if (nameChanged) body.name = trimmedName;
      if (slugChanged) body.slug = trimmedSlug;
      const res = await fetch(`/api/projects/${slug}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        setError(data?.error ?? t("saveError"));
        return;
      }
      if (slugChanged) {
        router.push(`/projects/${trimmedSlug}`);
      } else {
        router.refresh();
      }
    });
  }

  return (
    <section>
      <h3 className="section-title" style={{ fontSize: 14, marginBottom: 8 }}>
        {t("identitySection")}
      </h3>
      <form onSubmit={save} className="flex flex-col gap-2">
        <div className="form-row">
          <div className="field">
            <label>{t("nameLabel")}</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              className="input"
            />
          </div>
          <div className="field">
            <label>{t("slugLabel")}</label>
            <input
              value={slugInput}
              onChange={(e) =>
                setSlugInput(e.target.value.toLowerCase().replace(/\s+/g, "-"))
              }
              required
              className="input input-mono"
            />
          </div>
        </div>
        {slugChanged && (
          <p className="help text-accent">
            {t("slugWarning")}
          </p>
        )}
        {error && <p className="error-text">{error}</p>}
        <div>
          <button
            type="submit"
            disabled={!dirty || pending}
            className="btn btn-primary btn-sm"
          >
            {pending ? "..." : t("saveBtn")}
          </button>
        </div>
      </form>
    </section>
  );
}

function EnvironmentsSection({
  slug,
  environments,
  servers,
  serversError,
}: {
  slug: string;
  environments: EnvSummary[];
  servers: ServerOption[] | null;
  serversError: string | null;
}) {
  const t = useTranslations("projects.settings");
  const router = useRouter();
  const [adding, setAdding] = useState(false);

  return (
    <section>
      <div className="section-header">
        <h3 className="section-title" style={{ fontSize: 14 }}>
          {t("envsSection")}
        </h3>
        {!adding && (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="btn btn-ghost btn-xs"
          >
            {t("addEnvBtn")}
          </button>
        )}
      </div>

      {serversError && (
        <p className="help text-accent" style={{ marginBottom: 8 }}>
          {serversError}
        </p>
      )}

      {adding && (
        <div className="create-card">
          <AddEnvForm
            slug={slug}
            servers={servers}
            onCancel={() => setAdding(false)}
            onCreated={() => {
              setAdding(false);
              router.refresh();
            }}
          />
        </div>
      )}

      <div className="row-list">
        {environments.map((env) => (
          <EnvRow
            key={env.id}
            slug={slug}
            env={env}
            servers={servers}
            onChanged={() => router.refresh()}
          />
        ))}
      </div>
    </section>
  );
}

function AddEnvForm({
  slug,
  servers,
  onCancel,
  onCreated,
}: {
  slug: string;
  servers: ServerOption[] | null;
  onCancel: () => void;
  onCreated: () => void;
}) {
  const t = useTranslations("projects.settings");
  const hasServers = useFeature("server_management");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [serverId, setServerId] = useState("");
  const [deployPath, setDeployPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const body: Record<string, string | null | undefined> = { name };
      if (url.trim()) body.url = url.trim();
      if (serverId) body.serverId = serverId;
      if (deployPath.trim()) body.deployPath = deployPath.trim();

      const res = await fetch(`/api/projects/${slug}/environments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        setError(data?.error ?? t("saveError"));
        return;
      }
      onCreated();
    });
  }

  const previewName = name.trim() || "<env>";
  const deployPathPlaceholder = `${defaultDeployPath(previewName, slug)}${t("envDeployPathDefaultSuffix")}`;

  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      <div className="form-row">
        <div className="field">
          <label>{t("envNameLabel")}</label>
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value.toLowerCase())}
            placeholder={t("envNamePlaceholder")}
            className="input input-mono"
          />
        </div>
        <div className="field" style={{ flex: 2 }}>
          <label>{t("envUrlLabel")}</label>
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder={t("envUrlPlaceholder")}
            className="input"
          />
        </div>
      </div>
      {/* Chemin de déploiement + serveur : dépendent de la gestion de serveurs,
          absente du plan gratuit (quota 0). Les masquer évite de proposer une
          destination que l'utilisateur ne peut pas créer. */}
      {hasServers && (
        <>
      <div className="field">
        <label>{t("envDeployPathLabel")}</label>
        <input
          value={deployPath}
          onChange={(e) => setDeployPath(e.target.value)}
          placeholder={deployPathPlaceholder}
          className="input input-mono"
        />
      </div>
      <div className="field">
        <label>{t("envServerLabel")}</label>
        <ServerSelect
          servers={servers}
          value={serverId}
          onChange={setServerId}
        />
      </div>
        </>
      )}
      {error && <p className="error-text">{error}</p>}
      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={pending || !name.trim()}
          className="btn btn-primary btn-sm"
        >
          {pending ? "..." : t("saveBtn")}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="btn btn-ghost btn-sm"
        >
          {t("cancelBtn")}
        </button>
      </div>
    </form>
  );
}

function ServerSelect({
  servers,
  value,
  onChange,
}: {
  servers: ServerOption[] | null;
  value: string;
  onChange: (id: string) => void;
}) {
  const t = useTranslations("projects.settings");
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="select"
    >
      <option value="">{t("envServerNone")}</option>
      {servers?.map((s) => (
        <option key={s.id} value={s.id}>
          {s.name} ({s.sshUser}@{s.ip})
        </option>
      ))}
    </select>
  );
}

function EnvRow({
  slug,
  env,
  servers,
  onChanged,
}: {
  slug: string;
  env: EnvSummary;
  servers: ServerOption[] | null;
  onChanged: () => void;
}) {
  const t = useTranslations("projects.settings");
  const hasServers = useFeature("server_management");
  const confirm = useConfirm();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(env.name);
  const [url, setUrl] = useState(env.url ?? "");
  const [serverId, setServerId] = useState(env.serverId ?? "");
  const [deployPath, setDeployPath] = useState(env.deployPath ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const dirty =
    name !== env.name ||
    url !== (env.url ?? "") ||
    serverId !== (env.serverId ?? "") ||
    deployPath !== (env.deployPath ?? "");

  const linkedServer = env.serverId
    ? servers?.find((s) => s.id === env.serverId)
    : null;

  function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const body: Record<string, string | null | undefined> = {};
      if (name !== env.name) body.name = name;
      if (url !== (env.url ?? "")) body.url = url.trim() || null;
      if (serverId !== (env.serverId ?? "")) {
        body.serverId = serverId === "" ? null : serverId;
      }
      if (deployPath !== (env.deployPath ?? "")) {
        body.deployPath = deployPath.trim() || null;
      }
      const res = await fetch(
        `/api/projects/${slug}/environments/${encodeURIComponent(env.name)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        setError(data?.error ?? t("saveError"));
        return;
      }
      setEditing(false);
      onChanged();
    });
  }

  async function remove() {
    if (
      !(await confirm({ message: t("envDeleteConfirm", { name: env.name, count: env.secretCount }), danger: true }))
    )
      return;
    startTransition(async () => {
      const res = await fetch(
        `/api/projects/${slug}/environments/${encodeURIComponent(env.name)}`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        setError(data?.error ?? t("saveError"));
        return;
      }
      onChanged();
    });
  }

  if (!editing) {
    return (
      <div className="row">
        <div className="row-icon">{env.name.slice(0, 2).toUpperCase()}</div>
        <div className="row-info">
          <div className="row-name">
            <span className="code-mono">{env.name}</span>
            {linkedServer && (
              <span
                className="code-mono text-muted"
                style={{ fontSize: 12, marginLeft: 6, fontWeight: 400 }}
              >
                ({linkedServer.name})
              </span>
            )}
            {!linkedServer && env.serverId && (
              <span
                className="code-mono text-muted"
                style={{ fontSize: 12, marginLeft: 6, fontWeight: 400 }}
              >
                (introuvable)
              </span>
            )}
          </div>
          <div className="row-meta">
            {env.url && <span>{env.url}</span>}
          </div>
          {error && <p className="error-text">{error}</p>}
        </div>
        <div className="row-actions">
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="btn btn-ghost btn-xs"
          >
            Modifier
          </button>
          <button
            type="button"
            onClick={remove}
            disabled={pending}
            className="btn btn-danger btn-xs"
          >
            {t("envDeleteBtn")}
          </button>
        </div>
      </div>
    );
  }

  const previewName = name.trim() || "<env>";
  const deployPathPlaceholder = `${defaultDeployPath(previewName, slug)}${t("envDeployPathDefaultSuffix")}`;

  return (
    <div className="card">
      <form onSubmit={save} className="flex flex-col gap-2">
        <div className="form-row">
          <div className="field">
            <label>{t("envNameLabel")}</label>
            <input
              required
              value={name}
              onChange={(e) => setName(e.target.value.toLowerCase())}
              className="input input-mono"
            />
          </div>
          <div className="field" style={{ flex: 2 }}>
            <label>{t("envUrlLabel")}</label>
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={t("envUrlPlaceholder")}
              className="input"
            />
          </div>
        </div>
        {/* Cf. note du formulaire de création : mêmes champs, second endroit. */}
        {hasServers && (
          <>
            <div className="field">
              <label>{t("envDeployPathLabel")}</label>
              <input
                value={deployPath}
                onChange={(e) => setDeployPath(e.target.value)}
                placeholder={deployPathPlaceholder}
                className="input input-mono"
              />
            </div>
            <div className="field">
              <label>{t("envServerLabel")}</label>
              <ServerSelect
                servers={servers}
                value={serverId}
                onChange={setServerId}
              />
            </div>
          </>
        )}
        {name !== env.name && (
          <p className="help text-accent">
            {t("slugWarning")}
          </p>
        )}
        {error && <p className="error-text">{error}</p>}
        <div className="flex items-center gap-2">
          <button
            type="submit"
            disabled={pending || !dirty}
            className="btn btn-primary btn-sm"
          >
            {pending ? "..." : t("saveBtn")}
          </button>
          <button
            type="button"
            onClick={() => {
              setEditing(false);
              setName(env.name);
              setUrl(env.url ?? "");
              setServerId(env.serverId ?? "");
              setDeployPath(env.deployPath ?? "");
              setError(null);
            }}
            className="btn btn-ghost btn-sm"
          >
            {t("cancelBtn")}
          </button>
        </div>
      </form>
    </div>
  );
}
