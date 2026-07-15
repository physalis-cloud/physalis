"use client";

// Config de la sync sortante d'un environnement : mappe l'env vers un projet
// Vercel (via une connexion org de provider "vercel") + targets + filtre par tag.
// Affiche l'état de sync et permet un resync manuel. Cf. lib/sync/.

import { useCallback, useEffect, useState, useTransition } from "react";
import { RiRefreshLine } from "@remixicon/react";
import { useTranslations } from "next-intl";
import EmptyCard from "@/components/EmptyCard";
import type { ProjectRole } from "@prisma/client";
import { isSyncProvider } from "@/lib/sync/types";
import { useConfirm } from "@/components/ConfirmDialog";

type Target = {
  id: string;
  ciConnectionId: string;
  externalProjectId: string;
  externalProjectName: string | null;
  targets: string[];
  tagFilter: string[];
  lastSyncAt: string | null;
  lastSyncStatus: string | null;
  lastSyncError: string | null;
  ciConnection: { name: string; provider: string };
};
type Conn = { id: string; name: string; provider: string };
type RemoteProject = { id: string; name: string };

const ALL_TARGETS = ["production", "preview", "development"] as const;

export default function SyncPanel({
  slug,
  env,
  role,
  orgSlug,
}: {
  slug: string;
  env: string;
  role: ProjectRole;
  orgSlug: string;
}) {
  const t = useTranslations("projects.sync");
  const confirm = useConfirm();
  const [targets, setTargets] = useState<Target[] | null>(null);
  const [conns, setConns] = useState<Conn[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const canManage = role === "OWNER";
  const canResync = role === "OWNER" || role === "EDITOR";

  const reload = useCallback(async () => {
    setError(null);
    const res = await fetch(`/api/projects/${slug}/${env}/sync-target`);
    if (!res.ok) {
      setError(t("loadError"));
      return;
    }
    const data = (await res.json()) as { targets: Target[] };
    setTargets(data.targets);
  }, [slug, env, t]);

  useEffect(() => {
    setTargets(null);
    setAdding(false);
    reload();
    // Connexions de sync de l'org (Vercel/Render) pour le picker de création.
    (async () => {
      const res = await fetch(`/api/orgs/${orgSlug}/ci-connections`);
      if (!res.ok) return;
      const data = (await res.json()) as { connections: Conn[] };
      setConns(data.connections.filter((c) => isSyncProvider(c.provider)));
    })();
  }, [reload, orgSlug]);

  async function resync(id: string) {
    setBusyId(id);
    setError(null);
    const res = await fetch(`/api/projects/${slug}/${env}/sync-target/${id}/resync`, {
      method: "POST",
    });
    setBusyId(null);
    if (!res.ok) {
      setError(t("resyncError"));
      return;
    }
    reload();
  }

  async function remove(target: Target) {
    if (!(await confirm({ message: t("deleteConfirm", { name: target.ciConnection.name }), danger: true }))) return;
    const deleteRemote = await confirm({ message: t("deleteRemoteConfirm"), danger: true });
    const res = await fetch(
      `/api/projects/${slug}/${env}/sync-target/${target.id}?deleteRemote=${deleteRemote ? "1" : "0"}`,
      { method: "DELETE" },
    );
    if (!res.ok) {
      setError(t("deleteError"));
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
        {canManage && !adding && conns.length > 0 && (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="btn btn-primary btn-sm"
          >
            {t("addBtn")}
          </button>
        )}
      </div>

      {error && <p className="error-text">{error}</p>}

      {canManage && conns.length === 0 && (
        <EmptyCard
          icon={<RiRefreshLine size={22} aria-hidden />}
          title={t("noConnTitle")}
          hint={t("noConnHint")}
        />
      )}

      {adding && canManage && (
        <div className="create-card">
          <AddForm
            slug={slug}
            env={env}
            conns={conns}
            onCancel={() => setAdding(false)}
            onSaved={() => {
              setAdding(false);
              reload();
            }}
          />
        </div>
      )}

      {targets === null ? (
        <p className="help">…</p>
      ) : targets.length === 0 ? (
        conns.length > 0 && <p className="help">{t("empty")}</p>
      ) : (
        <div className="row-list">
          {targets.map((target) => (
            <div key={target.id} className="row row-no-icon">
              <div className="row-info">
                <div className="row-name">
                  {target.externalProjectName ?? target.externalProjectId}{" "}
                  <span className="text-muted" style={{ fontSize: 12 }}>
                    · {target.ciConnection.name}
                  </span>
                </div>
                <div className="row-meta code-mono" style={{ fontSize: 12 }}>
                  <span>{target.targets.join(", ")}</span>
                  {target.tagFilter.length > 0 && (
                    <span> · {t("tagFilterShort", { tags: target.tagFilter.join(",") })}</span>
                  )}
                  {" · "}
                  <SyncStatus target={target} t={t} />
                </div>
                {target.lastSyncStatus === "error" && target.lastSyncError && (
                  <div className="error-text" style={{ fontSize: 12 }}>
                    {target.lastSyncError}
                  </div>
                )}
              </div>
              <div className="row-actions">
                {canResync && (
                  <button
                    type="button"
                    onClick={() => resync(target.id)}
                    disabled={busyId === target.id}
                    className="btn btn-ghost btn-xs"
                  >
                    {busyId === target.id ? t("syncing") : t("resyncBtn")}
                  </button>
                )}
                {canManage && (
                  <button
                    type="button"
                    onClick={() => remove(target)}
                    className="btn btn-danger btn-xs"
                  >
                    {t("deleteBtn")}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SyncStatus({
  target,
  t,
}: {
  target: Target;
  t: ReturnType<typeof useTranslations>;
}) {
  const when = target.lastSyncAt
    ? new Date(target.lastSyncAt).toLocaleString()
    : null;
  if (target.lastSyncStatus === "success") {
    return <span style={{ color: "var(--success, #16a34a)" }}>{t("statusOk", { when: when ?? "" })}</span>;
  }
  if (target.lastSyncStatus === "error") {
    return <span className="error-text">{t("statusError")}</span>;
  }
  return <span className="text-muted">{t("statusNever")}</span>;
}

type RemoteRef = { id: string; name: string };
type TreeProject = RemoteRef & { environments: RemoteRef[]; services: RemoteRef[] };

function AddForm({
  slug,
  env,
  conns,
  onCancel,
  onSaved,
}: {
  slug: string;
  env: string;
  conns: Conn[];
  onCancel: () => void;
  onSaved: () => void;
}) {
  const t = useTranslations("projects.sync");
  const [connectionId, setConnectionId] = useState(conns[0]?.id ?? "");
  const [projects, setProjects] = useState<RemoteProject[] | null>(null);
  const [tree, setTree] = useState<TreeProject[] | null>(null);
  const [externalProjectId, setExternalProjectId] = useState("");
  // Railway : sélection en cascade.
  const [rwProjectId, setRwProjectId] = useState("");
  const [rwEnvId, setRwEnvId] = useState("");
  const [rwServiceId, setRwServiceId] = useState("");
  const [targets, setTargets] = useState<string[]>(["production"]);
  const [tagFilter, setTagFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loadingProjects, setLoadingProjects] = useState(false);
  const [pending, startTransition] = useTransition();

  const selectedProvider = conns.find((c) => c.id === connectionId)?.provider ?? "vercel";
  const supportsTargets = selectedProvider === "vercel"; // Vercel : prod/preview/dev
  const isRailway = selectedProvider === "railway"; // Railway : projet→env→service

  // Charge les ressources distantes (plat pour Vercel/Render, arbre pour Railway).
  const loadProjects = useCallback(async () => {
    if (!connectionId) return;
    setLoadingProjects(true);
    setError(null);
    setProjects(null);
    setTree(null);
    const res = await fetch(
      `/api/projects/${slug}/${env}/sync-target/remote-projects?connectionId=${encodeURIComponent(connectionId)}`,
    );
    setLoadingProjects(false);
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      setError(data?.error ?? t("projectsError"));
      return;
    }
    const data = (await res.json()) as
      | { projects: RemoteProject[] }
      | { tree: { projects: TreeProject[] } };
    if ("tree" in data) {
      const list = data.tree.projects;
      setTree(list);
      const p0 = list[0];
      setRwProjectId(p0?.id ?? "");
      setRwEnvId(p0?.environments[0]?.id ?? "");
      setRwServiceId(p0?.services[0]?.id ?? "");
    } else {
      setProjects(data.projects);
      if (data.projects[0]) setExternalProjectId(data.projects[0].id);
    }
  }, [slug, env, connectionId, t]);

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  // Quand le projet Railway change, recaler env + service sur le 1er du projet.
  function selectRwProject(id: string) {
    setRwProjectId(id);
    const p = tree?.find((x) => x.id === id);
    setRwEnvId(p?.environments[0]?.id ?? "");
    setRwServiceId(p?.services[0]?.id ?? "");
  }

  function toggleTarget(target: string) {
    setTargets((prev) =>
      prev.includes(target) ? prev.filter((x) => x !== target) : [...prev, target],
    );
  }

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const tags = tagFilter.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);

    let payload: Record<string, unknown>;
    if (isRailway) {
      if (!rwProjectId || !rwEnvId || !rwServiceId) {
        setError(t("pickRailwayError"));
        return;
      }
      const p = tree?.find((x) => x.id === rwProjectId);
      const svcName = p?.services.find((s) => s.id === rwServiceId)?.name ?? rwServiceId;
      const envName = p?.environments.find((en) => en.id === rwEnvId)?.name ?? "";
      payload = {
        ciConnectionId: connectionId,
        externalProjectId: rwProjectId,
        externalEnvironmentId: rwEnvId,
        externalServiceId: rwServiceId,
        externalProjectName: `${p?.name ?? ""} / ${envName} / ${svcName}`,
        targets: [],
        tagFilter: tags,
      };
    } else {
      if (!externalProjectId) {
        setError(t("pickProjectError"));
        return;
      }
      if (supportsTargets && targets.length === 0) {
        setError(t("pickTargetError"));
        return;
      }
      payload = {
        ciConnectionId: connectionId,
        externalProjectId,
        externalProjectName: projects?.find((p) => p.id === externalProjectId)?.name ?? null,
        targets: supportsTargets ? targets : [],
        tagFilter: tags,
      };
    }

    startTransition(async () => {
      const res = await fetch(`/api/projects/${slug}/${env}/sync-target`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? t("saveError"));
        return;
      }
      onSaved();
    });
  }

  const rwProject = tree?.find((x) => x.id === rwProjectId);

  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      <div className="field">
        <label>{t("connectionLabel")}</label>
        <select
          value={connectionId}
          onChange={(e) => setConnectionId(e.target.value)}
          className="select"
        >
          {conns.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>

      {loadingProjects ? (
        <p className="help">{t("projectsLoading")}</p>
      ) : isRailway ? (
        tree && tree.length > 0 ? (
          <>
            <div className="field">
              <label>{t("railwayProjectLabel")}</label>
              <select value={rwProjectId} onChange={(e) => selectRwProject(e.target.value)} className="select">
                {tree.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>{t("railwayEnvLabel")}</label>
              <select value={rwEnvId} onChange={(e) => setRwEnvId(e.target.value)} className="select">
                {(rwProject?.environments ?? []).map((en) => (
                  <option key={en.id} value={en.id}>{en.name}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>{t("railwayServiceLabel")}</label>
              <select value={rwServiceId} onChange={(e) => setRwServiceId(e.target.value)} className="select">
                {(rwProject?.services ?? []).map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </div>
          </>
        ) : (
          <p className="help">{t("projectsEmpty")}</p>
        )
      ) : (
        <div className="field">
          <label>{supportsTargets ? t("projectLabel") : t("serviceLabel")}</label>
          {projects && projects.length > 0 ? (
            <select
              value={externalProjectId}
              onChange={(e) => setExternalProjectId(e.target.value)}
              className="select"
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          ) : (
            <p className="help">{t("projectsEmpty")}</p>
          )}
        </div>
      )}

      {supportsTargets && (
        <div className="field">
          <label>{t("targetsLabel")}</label>
          <div className="flex items-center gap-3">
            {ALL_TARGETS.map((target) => (
              <label key={target} className="flex items-center gap-1" style={{ fontSize: 13 }}>
                <input
                  type="checkbox"
                  checked={targets.includes(target)}
                  onChange={() => toggleTarget(target)}
                />
                {target}
              </label>
            ))}
          </div>
        </div>
      )}

      <div className="field">
        <label>{t("tagFilterLabel")}</label>
        <input
          value={tagFilter}
          onChange={(e) => setTagFilter(e.target.value)}
          placeholder={t("tagFilterPlaceholder")}
          className="input input-mono"
        />
        <p className="help">{t("tagFilterHelp")}</p>
      </div>

      <p className="help">{supportsTargets ? t("createNote") : t("createNoteRender")}</p>
      {error && <p className="error-text">{error}</p>}
      <div className="flex items-center gap-2">
        <button type="submit" disabled={pending} className="btn btn-primary btn-sm">
          {t("createBtn")}
        </button>
        <button type="button" onClick={onCancel} className="btn btn-ghost btn-sm">
          {t("cancelBtn")}
        </button>
      </div>
    </form>
  );
}
