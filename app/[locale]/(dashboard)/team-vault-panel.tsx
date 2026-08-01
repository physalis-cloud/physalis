"use client";

import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import TagsInput from "@/components/TagsInput";
import { useTranslations } from "next-intl";
import {
  RiDownload2Line,
  RiFolderOpenLine,
  RiKey2Line,
  RiShuffleLine,
} from "@remixicon/react";
import EmptyCard from "@/components/EmptyCard";
import { generatePassword } from "@/lib/generate-password";
import { maskedInputProps } from "@/lib/masked-input";
import { useConfirm } from "@/components/ConfirmDialog";
import ImmediateRotationSection from "@/components/ImmediateRotationSection";
import TeamVaultImportDialog from "./team-vault-import-dialog";
import RenameCollectionDialog from "./rename-collection-dialog";

type VaultRole = "OWNER" | "EDITOR" | "VIEWER";

const ROLE_RANK: Record<VaultRole, number> = {
  VIEWER: 1,
  EDITOR: 2,
  OWNER: 3,
};

export type TeamVaultScope =
  | { kind: "org"; orgSlug: string }
  | { kind: "project"; projectSlug: string };

type Collection = {
  id: string;
  name: string;
  slug: string;
  role: VaultRole;
  entryCount: number;
  memberCount?: number;
};

type Entry = {
  id: string;
  name: string;
  url: string | null;
  username: string | null;
  tags: string[];
  favorite: boolean;
  hasTotpSecret: boolean;
};

type Member = {
  id: string;
  userId: string;
  email: string;
  role: VaultRole;
};

function basePath(scope: TeamVaultScope): string {
  return scope.kind === "org"
    ? `/api/vault/org/${scope.orgSlug}/collections`
    : `/api/vault/project/${scope.projectSlug}/collections`;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 0 || !parts[0]) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

export default function TeamVaultPanel({
  scope,
  canCreate,
  rotationFeatureEnabled,
}: {
  scope: TeamVaultScope;
  canCreate: boolean;
  rotationFeatureEnabled: boolean;
}) {
  const t = useTranslations("vault.teamVault");
  const confirm = useConfirm();
  const [collections, setCollections] = useState<Collection[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeSlug, setActiveSlug] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const reload = useCallback(async () => {
    setError(null);
    const res = await fetch(basePath(scope));
    if (!res.ok) {
      setError(t("deleteError"));
      return;
    }
    const data = (await res.json()) as { collections: Collection[] };
    setCollections(data.collections);
  }, [scope, t]);

  useEffect(() => {
    reload();
  }, [reload]);

  async function createCollection(name: string) {
    const res = await fetch(basePath(scope), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as
        | { error?: string }
        | null;
      setError(data?.error ?? t("deleteError"));
      return false;
    }
    setCreating(false);
    reload();
    return true;
  }

  async function removeCollection(c: Collection) {
    if (!(await confirm({ message: t("deleteConfirm", { name: c.name }), danger: true })))
      return;
    const res = await fetch(`${basePath(scope)}/${c.slug}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      setError(t("deleteError"));
      return;
    }
    if (activeSlug === c.slug) setActiveSlug(null);
    reload();
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="section-header">
        <div>
          <h2 className="section-title">
            {scope.kind === "org" ? t("titleOrg") : t("titleProject")}
          </h2>
          <p className="panel-subtitle">
            {scope.kind === "org" ? t("scopeOrg") : t("scopeProject")}
          </p>
        </div>
        {canCreate && collections && collections.length > 0 && (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="btn btn-primary"
          >
            {t("newCollectionBtn")}
          </button>
        )}
      </div>

      {creating && (
        <div className="create-card">
          <CreateCollectionForm
            onCancel={() => setCreating(false)}
            onCreated={createCollection}
          />
        </div>
      )}

      {error && <p className="error-text">{error}</p>}

      {collections === null ? (
        <p className="help">{t("loading")}</p>
      ) : collections.length === 0 && !creating ? (
        <EmptyCard
          icon={<RiFolderOpenLine size={22} aria-hidden />}
          title={t("noCollections")}
          hint={canCreate ? undefined : t("noCollectionsAccess")}
          action={
            canCreate && !creating ? (
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => setCreating(true)}
              >
                {t("newCollectionBtn")}
              </button>
            ) : undefined
          }
        />
      ) : (
        <div className="row-list">
          {collections.map((c) => (
            <div
              key={c.id}
              className="card"
              style={{ padding: 0, overflow: "hidden" }}
            >
              <button
                type="button"
                onClick={() =>
                  setActiveSlug(activeSlug === c.slug ? null : c.slug)
                }
                style={{
                  width: "100%",
                  background: "transparent",
                  border: "none",
                  padding: 14,
                  textAlign: "left",
                  cursor: "pointer",
                  display: "grid",
                  gridTemplateColumns: "36px 1fr auto",
                  gap: 14,
                  alignItems: "center",
                  fontFamily: "inherit",
                  color: "inherit",
                }}
              >
                <div className="row-icon"><RiFolderOpenLine size={18} aria-hidden /></div>
                <div className="row-info">
                  <div className="row-name">{c.name}</div>
                  <div className="row-meta">
                    <span>
                      {t("entriesCount", { count: c.entryCount })}
                    </span>
                    {c.memberCount !== undefined && (
                      <span>
                        · {t("membersCount", { count: c.memberCount })}
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`role role-${c.role.toLowerCase()}`}>
                    {c.role}
                  </span>
                  <span className="text-muted">
                    {activeSlug === c.slug ? "▲" : "▼"}
                  </span>
                </div>
              </button>
              {activeSlug === c.slug && (
                <CollectionDetail
                  scope={scope}
                  collection={c}
                  allCollections={collections ?? []}
                  onDeleted={() => removeCollection(c)}
                  onChanged={reload}
                  rotationFeatureEnabled={rotationFeatureEnabled}
                />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CreateCollectionForm({
  onCancel,
  onCreated,
}: {
  onCancel: () => void;
  onCreated: (name: string) => Promise<boolean>;
}) {
  const t = useTranslations("vault.teamVault");
  const [name, setName] = useState("");
  const [pending, startTransition] = useTransition();

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!name.trim()) return;
    startTransition(async () => {
      await onCreated(name.trim());
    });
  }

  return (
    <form onSubmit={submit} className="form-row">
      <div className="field" style={{ minWidth: 240 }}>
        <label>Nom de la collection</label>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="ex. Outils internes"
          className="input"
        />
      </div>
      <button
        type="submit"
        disabled={pending || !name.trim()}
        className="btn btn-primary btn-primary-form"
      >
        {pending ? "..." : t("newCollectionBtn")}
      </button>
      <button
        type="button"
        onClick={onCancel}
        className="btn btn-ghost btn-primary-form"
      >
        {t("cancelBtn")}
      </button>
    </form>
  );
}

function CollectionDetail({
  scope,
  collection,
  allCollections,
  onDeleted,
  onChanged,
  rotationFeatureEnabled,
}: {
  scope: TeamVaultScope;
  collection: Collection;
  /** Toutes les collections du meme scope (org ou projet), pour le
   *  selecteur "deplacer vers une autre collection" dans EntryDialog. */
  allCollections: Collection[];
  onDeleted: () => void;
  onChanged: () => void;
  rotationFeatureEnabled: boolean;
}) {
  const t = useTranslations("vault.teamVault");
  const tv = useTranslations("vault");
  const confirm = useConfirm();
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [showMembers, setShowMembers] = useState(false);
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [editing, setEditing] = useState<Entry | null>(null);
  const [rotationConfigTarget, setRotationConfigTarget] = useState<{ id: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Tags déjà utilisés dans la collection → suggestions d'autocomplete dans le
  // dialog d'entrée (les entrées sont déjà chargées côté client).
  const allTags = useMemo<string[]>(() => {
    const set = new Set<string>();
    for (const e of entries ?? []) for (const tag of e.tags) set.add(tag);
    return Array.from(set).sort();
  }, [entries]);

  const canEdit = ROLE_RANK[collection.role] >= ROLE_RANK.EDITOR;
  const canManage = collection.role === "OWNER";

  const collectionBase = `${basePath(scope)}/${collection.slug}`;
  const entryBase = `${collectionBase}/entries`;

  const reload = useCallback(async () => {
    setError(null);
    const res = await fetch(entryBase);
    if (!res.ok) {
      setError(t("deleteError"));
      return;
    }
    const data = (await res.json()) as { entries: Entry[] };
    setEntries(data.entries);
  }, [entryBase, t]);

  useEffect(() => {
    reload();
  }, [reload]);

  async function reveal(id: string) {
    if (revealed[id] !== undefined) {
      setRevealed((r) => {
        const copy = { ...r };
        delete copy[id];
        return copy;
      });
      return;
    }
    const res = await fetch(`${entryBase}/${id}`);
    if (!res.ok) return setError(t("deleteError"));
    const data = (await res.json()) as { entry: { password: string | null } };
    setRevealed((r) => ({ ...r, [id]: data.entry.password ?? "" }));
  }

  async function copyToClipboard(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      setError(tv("copySuccess", { label }));
      setTimeout(() => setError(null), 1500);
    } catch {
      setError(t("deleteError"));
    }
  }

  async function copyPassword(id: string) {
    const res = await fetch(`${entryBase}/${id}`);
    if (!res.ok) return setError(t("deleteError"));
    const data = (await res.json()) as { entry: { password: string | null } };
    if (!data.entry.password) return setError(t("deleteError"));
    copyToClipboard(data.entry.password, "Mot de passe");
  }

  async function remove(e: Entry) {
    if (!(await confirm({ message: t("deleteConfirm", { name: e.name }), danger: true }))) return;
    const res = await fetch(`${entryBase}/${e.id}`, { method: "DELETE" });
    if (!res.ok) return setError(t("deleteError"));
    setRevealed((r) => {
      const copy = { ...r };
      delete copy[e.id];
      return copy;
    });
    reload();
    onChanged();
  }

  function renameCollection() {
    setRenaming(true);
  }

  return (
    <div
      style={{
        borderTop: "1px solid var(--border)",
        background: "var(--bg)",
        padding: 16,
      }}
    >
      <div className="section-header">
        <div className="flex items-center gap-2">
          {canEdit && entries && entries.length > 0 && (
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="btn btn-primary btn-sm"
            >
              {t("addEntryBtn")}
            </button>
          )}
          {canEdit && (
            <button
              type="button"
              onClick={() => setImporting(true)}
              className="btn btn-ghost btn-sm"
              title={t("importBtn")}
            >
              <RiDownload2Line size={14} aria-hidden /> {t("importBtn")}
            </button>
          )}
          {canManage && scope.kind === "org" && (
            <button
              type="button"
              onClick={() => setShowMembers((v) => !v)}
              className="btn btn-ghost btn-sm"
            >
              {showMembers ? t("hideMembersBtn") : t("membersBtn")}
            </button>
          )}
        </div>
        {canManage && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={renameCollection}
              className="btn btn-ghost btn-xs"
              title={t("renameBtn")}
            >
              {t("renameBtn")}
            </button>
            <button
              type="button"
              onClick={onDeleted}
              className="btn btn-danger btn-xs"
            >
              {t("deleteBtn")}
            </button>
          </div>
        )}
      </div>

      {error && (
        <p className="help text-accent" style={{ marginBottom: 8 }}>
          {error}
        </p>
      )}

      {showMembers && scope.kind === "org" && (
        <MembersSection
          orgSlug={scope.orgSlug}
          collectionSlug={collection.slug}
        />
      )}

      {renaming && (
        <RenameCollectionDialog
          currentName={collection.name}
          endpoint={collectionBase}
          onClose={() => setRenaming(false)}
          onRenamed={() => {
            setRenaming(false);
            // Le slug peut avoir change → le parent doit recharger la
            // liste pour mettre a jour les liens / URLs.
            onChanged();
          }}
        />
      )}

      {importing && (
        <TeamVaultImportDialog
          basePath={collectionBase}
          onClose={() => setImporting(false)}
          onImported={(count) => {
            setImporting(false);
            setError(
              count > 0
                ? tv("import.success", { count })
                : tv("import.empty"),
            );
            setTimeout(() => setError(null), 3000);
            reload();
            onChanged();
          }}
        />
      )}

      {(adding || editing) && (
        <EntryDialog
          entryBase={entryBase}
          initial={editing}
          currentCollectionId={collection.id}
          suggestions={allTags}
          movableCollections={allCollections.filter(
            (c) =>
              c.id !== collection.id &&
              (c.role === "EDITOR" || c.role === "OWNER"),
          )}
          onClose={() => {
            setAdding(false);
            setEditing(null);
          }}
          onSaved={() => {
            setAdding(false);
            setEditing(null);
            reload();
            onChanged();
          }}
        />
      )}

      {rotationConfigTarget && (
        <EntryRotationDialog
          endpoint={`${entryBase}/${rotationConfigTarget.id}/rotation`}
          name={rotationConfigTarget.name}
          onClose={() => setRotationConfigTarget(null)}
          onRotated={reload}
        />
      )}

      {entries === null ? (
        <p className="help">{t("loading")}</p>
      ) : entries.length === 0 && !adding ? (
        <EmptyCard
          icon={<RiKey2Line size={22} aria-hidden />}
          title={tv("form.emptyCategoryHint")}
          action={
            canEdit && !adding ? (
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => setAdding(true)}
              >
                {t("addEntryBtn")}
              </button>
            ) : undefined
          }
        />
      ) : (
        <div className="row-list">
          {entries.map((e) => (
            <div key={e.id} className="row">
              <div className="row-icon">{initials(e.name)}</div>
              <div className="row-info">
                <div className="flex items-center gap-2">
                  {e.favorite && <span className="star-btn active">★</span>}
                  <div className="row-name">
                    {e.name}
                    {e.hasTotpSecret && (
                      <span
                        className="chip"
                        style={{ marginLeft: 6, fontSize: 10 }}
                      >
                        {tv("form.twoFaBadge")}
                      </span>
                    )}
                  </div>
                </div>
                <div className="row-meta">
                  {e.url && (
                    <a
                      href={
                        e.url.startsWith("http") ? e.url : `https://${e.url}`
                      }
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {e.url}
                    </a>
                  )}
                  {e.username && (
                    <span className="code-mono">{e.username}</span>
                  )}
                  <span className="code-mono">
                    {revealed[e.id] !== undefined
                      ? revealed[e.id]
                      : "••••••••••••"}
                  </span>
                </div>
                {e.tags.length > 0 && (
                  <div
                    className="flex flex-wrap gap-1"
                    style={{ marginTop: 6 }}
                  >
                    {e.tags.map((tag) => (
                      <span key={tag} className="chip">
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <div className="row-actions">
                {e.username && (
                  <button
                    type="button"
                    onClick={() => copyToClipboard(e.username!, tv("copyLoginBtn"))}
                    className="btn btn-ghost btn-xs"
                  >
                    {tv("copyLoginBtn")}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => copyPassword(e.id)}
                  className="btn btn-ghost btn-xs"
                >
                  {tv("copyPasswordBtn")}
                </button>
                <button
                  type="button"
                  onClick={() => reveal(e.id)}
                  className="btn btn-ghost btn-xs"
                >
                  {revealed[e.id] !== undefined ? tv("hideBtn") : tv("revealBtn")}
                </button>
                {canEdit && (
                  <>
                    <button
                      type="button"
                      onClick={() => setEditing(e)}
                      className="btn btn-ghost btn-xs"
                    >
                      {tv("editBtn")}
                    </button>
                    {rotationFeatureEnabled && (
                      <button
                        type="button"
                        onClick={() => setRotationConfigTarget({ id: e.id, name: e.name })}
                        className="btn btn-ghost btn-xs"
                      >
                        {t("rotationBtn")}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => remove(e)}
                      className="btn btn-danger btn-xs"
                    >
                      {tv("deleteBtn")}
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function MembersSection({
  orgSlug,
  collectionSlug,
}: {
  orgSlug: string;
  collectionSlug: string;
}) {
  const t = useTranslations("vault.teamVault");
  const confirm = useConfirm();
  const [members, setMembers] = useState<Member[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const base = `/api/vault/org/${orgSlug}/collections/${collectionSlug}/members`;

  const reload = useCallback(async () => {
    setError(null);
    const res = await fetch(base);
    if (!res.ok) return setError(t("deleteError"));
    const data = (await res.json()) as { members: Member[] };
    setMembers(data.members);
  }, [base]);

  useEffect(() => {
    reload();
  }, [reload]);

  async function add(email: string, role: VaultRole) {
    const res = await fetch(base, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, role }),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as
        | { error?: string }
        | null;
      setError(data?.error ?? t("deleteError"));
      return false;
    }
    setAdding(false);
    reload();
    return true;
  }

  async function changeRole(m: Member, role: VaultRole) {
    const res = await fetch(`${base}/${m.userId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role }),
    });
    if (!res.ok) return setError(t("deleteError"));
    reload();
  }

  async function remove(m: Member) {
    if (!(await confirm({ message: `Retirer ${m.email} de cette collection ?`, danger: true }))) return;
    const res = await fetch(`${base}/${m.userId}`, { method: "DELETE" });
    if (!res.ok) return setError(t("deleteError"));
    reload();
  }

  return (
    <div className="card" style={{ padding: 14, marginBottom: 12 }}>
      <div className="section-header">
        <h4 className="cat-header" style={{ margin: 0 }}>
          {t("membersBtn")}
        </h4>
        {!adding && (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="btn btn-ghost btn-xs"
          >
            + Ajouter
          </button>
        )}
      </div>
      {error && (
        <p className="help text-accent" style={{ marginBottom: 8 }}>
          {error}
        </p>
      )}
      {adding && (
        <AddMemberForm onCancel={() => setAdding(false)} onAdded={add} />
      )}
      {members === null ? (
        <p className="help">{t("loading")}</p>
      ) : members.length === 0 ? (
        <p className="help" style={{ fontStyle: "italic" }}>
          {t("emptyMembers")}
        </p>
      ) : (
        <div className="row-list">
          {members.map((m) => (
            <div key={m.id} className="row">
              <div className="row-icon">{initials(m.email)}</div>
              <div className="row-info">
                <div className="row-name">{m.email}</div>
              </div>
              <div className="row-actions">
                <select
                  value={m.role}
                  onChange={(e) => changeRole(m, e.target.value as VaultRole)}
                  className="select"
                  style={{
                    width: "auto",
                    padding: "4px 8px",
                    fontSize: 11,
                  }}
                >
                  <option value="VIEWER">VIEWER</option>
                  <option value="EDITOR">EDITOR</option>
                  <option value="OWNER">OWNER</option>
                </select>
                <button
                  type="button"
                  onClick={() => remove(m)}
                  className="btn btn-danger btn-xs"
                >
                  Retirer
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AddMemberForm({
  onCancel,
  onAdded,
}: {
  onCancel: () => void;
  onAdded: (email: string, role: VaultRole) => Promise<boolean>;
}) {
  const t = useTranslations("vault.teamVault");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<VaultRole>("VIEWER");
  const [pending, startTransition] = useTransition();

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!email.trim()) return;
    startTransition(async () => {
      await onAdded(email.trim().toLowerCase(), role);
    });
  }

  return (
    <form onSubmit={submit} className="form-row" style={{ marginBottom: 12 }}>
      <div className="field" style={{ minWidth: 200 }}>
        <input
          type="email"
          required
          autoFocus
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="email@example.com"
          className="input"
        />
      </div>
      <select
        value={role}
        onChange={(e) => setRole(e.target.value as VaultRole)}
        className="select"
        style={{ width: "auto" }}
      >
        <option value="VIEWER">VIEWER</option>
        <option value="EDITOR">EDITOR</option>
        <option value="OWNER">OWNER</option>
      </select>
      <button
        type="submit"
        disabled={pending}
        className="btn btn-primary btn-sm"
      >
        {t("addMemberBtn")}
      </button>
      <button
        type="button"
        onClick={onCancel}
        className="btn btn-ghost btn-sm"
      >
        {t("cancelBtn")}
      </button>
    </form>
  );
}

function EntryDialog({
  entryBase,
  initial,
  currentCollectionId,
  movableCollections,
  suggestions,
  onClose,
  onSaved,
}: {
  entryBase: string;
  initial: Entry | null;
  currentCollectionId: string;
  /** Collections du meme scope ou le user a EDITOR+, hors la courante.
   *  Si vide, le selecteur "deplacer" n'est pas affiche. */
  movableCollections: Collection[];
  /** Tags déjà utilisés dans la collection → autocomplete. */
  suggestions: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = Boolean(initial);
  const [name, setName] = useState(initial?.name ?? "");
  const [url, setUrl] = useState(initial?.url ?? "");
  const [username, setUsername] = useState(initial?.username ?? "");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [totpSecret, setTotpSecret] = useState("");
  const [showTotpSecret, setShowTotpSecret] = useState(false);
  const [totpLoaded, setTotpLoaded] = useState(false);
  const [tags, setTags] = useState<string[]>(initial?.tags ?? []);
  const [favorite, setFavorite] = useState(initial?.favorite ?? false);
  // Selection de collection (move). Default = courante. Visible uniquement
  // en mode edit + si au moins une autre collection est disponible.
  const [selectedCollectionId, setSelectedCollectionId] =
    useState(currentCollectionId);
  const t = useTranslations("vault");
  const [pwdLoaded, setPwdLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  async function loadCurrentSecrets() {
    if (!initial) return;
    const res = await fetch(`${entryBase}/${initial.id}`);
    if (!res.ok) return;
    const data = (await res.json()) as {
      entry: { password: string | null; totpSecret: string | null };
    };
    setPassword(data.entry.password ?? "");
    setPwdLoaded(true);
    setShowPassword(true);
    setTotpSecret(data.entry.totpSecret ?? "");
    setTotpLoaded(true);
  }

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const body: Record<string, unknown> = {
        name,
        url: url.trim() || null,
        username: username.trim() || null,
        tags,
        favorite,
      };
      if (!isEdit || pwdLoaded) body.password = password;
      if (!isEdit || totpLoaded) body.totpSecret = totpSecret.trim() || null;
      // Move : seulement en edit, et seulement si la collection a change.
      if (isEdit && selectedCollectionId !== currentCollectionId) {
        body.targetCollectionId = selectedCollectionId;
      }

      const url2 = isEdit ? `${entryBase}/${initial!.id}` : entryBase;
      const method = isEdit ? "PATCH" : "POST";
      const res = await fetch(url2, {
        method,
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
      onSaved();
    });
  }

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-header">
          <h2 className="dialog-title">
            {isEdit ? t("form.editTitle") : t("form.createTitle")}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="dialog-close"
            aria-label={t("form.closeLabel")}
          >
            ✕
          </button>
        </div>
        {/* autoComplete=off : sans ça le navigateur prend la modale pour un
            formulaire de connexion et pré-remplit les champs. */}
        <form onSubmit={submit} autoComplete="off">
          <div className="dialog-body">
            <div className="field">
              <label>{t("form.nameLabel")} *</label>
              <input
                required
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="input"
              />
            </div>
            <div className="field">
              <label>{t("form.urlLabel")}</label>
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                className="input input-mono"
              />
            </div>
            <div className="field">
              <label>{t("form.usernameLabel")}</label>
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="input input-mono"
              />
            </div>
            <div className="field">
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                }}
              >
                <label style={{ margin: 0 }}>{t("form.passwordLabel")}</label>
                <div className="flex items-center gap-2">
                  {isEdit && !pwdLoaded && (
                    <button
                      type="button"
                      onClick={loadCurrentSecrets}
                      className="btn btn-ghost btn-xs"
                    >
                      {t("form.loadCurrentBtn")}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      setPassword(generatePassword(24));
                      setShowPassword(true);
                      setPwdLoaded(true);
                    }}
                    title={t("generator.refreshBtn")}
                    className="btn btn-ghost btn-xs"
                  >
                    <RiShuffleLine size={12} aria-hidden /> {t("generator.refreshBtn")}
                  </button>
                  {(pwdLoaded || password !== "") && (
                    <button
                      type="button"
                      onClick={() => setShowPassword((v) => !v)}
                      className="btn btn-ghost btn-xs"
                    >
                      {showPassword ? t("hideBtn") : t("revealBtn")}
                    </button>
                  )}
                </div>
              </div>
              <input
                {...maskedInputProps(showPassword)}
                name="team-vault-password"
                autoComplete="off"
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  setPwdLoaded(true);
                }}
                placeholder={
                  isEdit && !pwdLoaded ? t("form.unchanged") : "••••••••••••"
                }
              />
            </div>
            <div className="field">
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                }}
              >
                <label style={{ margin: 0 }}>{t("form.totpLabel")}</label>
                <div className="flex items-center gap-2">
                  {isEdit && !totpLoaded && (
                    <button
                      type="button"
                      onClick={loadCurrentSecrets}
                      className="btn btn-ghost btn-xs"
                    >
                      {t("form.loadCurrentBtn")}
                    </button>
                  )}
                  {(totpLoaded || totpSecret !== "") && (
                    <button
                      type="button"
                      onClick={() => setShowTotpSecret((v) => !v)}
                      className="btn btn-ghost btn-xs"
                    >
                      {showTotpSecret ? t("hideBtn") : t("revealBtn")}
                    </button>
                  )}
                </div>
              </div>
              <input
                {...maskedInputProps(showTotpSecret)}
                name="team-vault-totp"
                autoComplete="off"
                value={totpSecret}
                onChange={(e) => {
                  setTotpSecret(e.target.value);
                  setTotpLoaded(true);
                }}
                placeholder={
                  isEdit && !totpLoaded
                    ? t("form.unchanged")
                    : t("form.totpPlaceholder")
                }
              />
              <div className="help" style={{ marginTop: 4 }}>
                {t("form.totpHint")}
              </div>
            </div>
            <div className="field">
              <label>Tags</label>
              <TagsInput value={tags} onChange={setTags} suggestions={suggestions} lowercase={false} />
            </div>
            <label
              className="flex items-center gap-2"
              style={{ cursor: "pointer", fontSize: 13 }}
            >
              <input
                type="checkbox"
                checked={favorite}
                onChange={(e) => setFavorite(e.target.checked)}
                style={{ cursor: "pointer" }}
              />
              <span>{t("form.favouriteCheckLabel")}</span>
            </label>
            {isEdit && movableCollections.length > 0 && (
              <div className="field">
                <label htmlFor="entryCollection">{t("form.collectionLabel")}</label>
                <select
                  id="entryCollection"
                  value={selectedCollectionId}
                  onChange={(e) => setSelectedCollectionId(e.target.value)}
                  className="select"
                >
                  <option value={currentCollectionId}>
                    {t("form.stayInCollection")}
                  </option>
                  {movableCollections.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                <div className="help">
                  {t("form.moveCollectionHint")}
                </div>
              </div>
            )}
            {error && <p className="error-text">{error}</p>}
          </div>
          <div className="dialog-footer">
            <button
              type="button"
              onClick={onClose}
              className="btn btn-ghost btn-sm"
            >
              {t("form.cancelBtn")}
            </button>
            <button
              type="submit"
              disabled={pending || !name.trim()}
              className="btn btn-primary btn-sm"
            >
              {pending ? t("form.savingBtn") : isEdit ? t("form.updateBtn") : t("form.createEntryBtn")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// Modale rotation d'une entrée de coffre : config du rappel (activer + intervalle)
// + section « Rotation immédiate » (assistée) dans la même modale.
function EntryRotationDialog({
  endpoint,
  name,
  onClose,
  onRotated,
}: {
  endpoint: string;
  name: string;
  onClose: () => void;
  onRotated?: () => void;
}) {
  const t = useTranslations("vault.teamVault");
  const [loaded, setLoaded] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [intervalDays, setIntervalDays] = useState("30");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    fetch(endpoint)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d: { rotation: { rotationEnabled: boolean; rotationIntervalDays: number | null } }) => {
        setEnabled(d.rotation.rotationEnabled);
        if (d.rotation.rotationIntervalDays) setIntervalDays(String(d.rotation.rotationIntervalDays));
      })
      .catch(() => null)
      .finally(() => setLoaded(true));
  }, [endpoint]);

  function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const res = await fetch(endpoint, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          rotationEnabled: enabled,
          rotationIntervalDays: enabled && intervalDays ? Number(intervalDays) : null,
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? t("rotationSaveError"));
        return;
      }
      onClose();
    });
  }

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-header">
          <h2 className="dialog-title">{t("rotationTitle", { name })}</h2>
          <button type="button" onClick={onClose} className="dialog-close" aria-label={t("rotationCancelBtn")}>✕</button>
        </div>
        <div className="dialog-body">
          {!loaded ? (
            <p className="help">{t("rotationLoading")}</p>
          ) : (
            <form onSubmit={save} className="flex flex-col gap-4">
              <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} disabled={pending} />
                <span>{t("rotationEnable")}</span>
              </label>
              {enabled && (
                <div className="field">
                  <label>{t("rotationInterval")}</label>
                  <input type="number" value={intervalDays} onChange={(e) => setIntervalDays(e.target.value)} min={1} max={3650} className="input" style={{ maxWidth: 120 }} disabled={pending} />
                </div>
              )}
              <p className="help" style={{ fontSize: 12 }}>{t("rotationHelp")}</p>
              {error && <p className="error-text">{error}</p>}
              <ImmediateRotationSection endpoint={endpoint} payloadKey="newPassword" onDone={onRotated} />
              <div className="flex items-center gap-2">
                <button type="submit" disabled={pending} className="btn btn-primary btn-sm">
                  {pending ? t("rotationSavingBtn") : t("rotationSaveBtn")}
                </button>
                <button type="button" onClick={onClose} className="btn btn-ghost btn-sm" disabled={pending}>
                  {t("rotationCancelBtn")}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
