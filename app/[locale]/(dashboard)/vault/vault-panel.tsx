"use client";

import { useCallback, useEffect, useState, useTransition, type ReactNode, type CSSProperties } from "react";
import TagsInput from "@/components/TagsInput";
import { useTranslations } from "next-intl";
import {
  RiFolderOpenLine,
  RiGridLine,
  RiInboxArchiveLine,
  RiListCheck2,
  RiShuffleLine,
  RiStarFill,
} from "@remixicon/react";
import { generatePassword } from "@/lib/generate-password";
import { estimateStrength, strengthMeta } from "@/lib/password-strength";
import { computeDuplicates, extractDomain } from "@/lib/vault-duplicates";
import { useConfirm } from "@/components/ConfirmDialog";
import ExtensionBanner from "./extension-banner";
import RenameCollectionDialog from "../rename-collection-dialog";

type VaultEntryListItem = {
  id: string;
  name: string;
  url: string | null;
  username: string | null;
  tags: string[];
  favorite: boolean;
  passwordStrength: number | null;
  hasTotpSecret: boolean;
  collectionId: string | null;
  createdAt: string;
  updatedAt: string;
};

type VaultCollection = {
  id: string;
  name: string;
  slug: string;
  entryCount: number;
};

// "all" = toutes les entries, "favorites" = favoris seulement,
// "none" = entries sans collection, "duplicates" = entries en doublon
// (même domaine + même login), "weak" = mots de passe faibles (score 0-1),
// "<id>" = entries d'une collection précise.
type CollectionFilter =
  | "all"
  | "favorites"
  | "none"
  | "duplicates"
  | "weak"
  | string;

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 0 || !parts[0]) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

// Favicon du domaine (API Google), qui remplit son conteneur (liste ou grille).
// Fallback sur les initiales si l'URL est absente/invalide ou si le favicon ne
// charge pas (onError). L'échec est mémorisé PAR domaine : éditer l'URL d'une
// entrée re-tente automatiquement le nouveau favicon.
function EntryIcon({ name, url }: { name: string; url: string | null }) {
  const domain = extractDomain(url);
  const [failedDomain, setFailedDomain] = useState<string | null>(null);
  if (domain && failedDomain !== domain) {
    return (
      // favicon externe arbitraire : next/image n'apporte rien et imposerait
      // de whitelister le domaine — <img> est volontaire ici.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`}
        alt=""
        loading="lazy"
        onError={() => setFailedDomain(domain)}
        style={{ width: "100%", height: "100%", objectFit: "contain", borderRadius: "inherit" }}
      />
    );
  }
  return <>{initials(name)}</>;
}

// Barre de force d'un score déjà stocké (0-4) — discrète (4px), couleur selon
// le niveau, tooltip "Force : <label>". Rien si pas de mot de passe (null).
function StrengthBar({ score, label }: { score: number | null; label: string }) {
  if (score === null || score === undefined) return null;
  const meta = strengthMeta(score);
  return (
    <span
      title={`${label} : ${meta.label}`}
      aria-label={`${label} : ${meta.label}`}
      style={{
        display: "inline-flex",
        gap: 2,
        height: 4,
        width: 56,
        borderRadius: 2,
        overflow: "hidden",
        verticalAlign: "middle",
      }}
    >
      {[0, 1, 2, 3, 4].map((i) => (
        <span
          key={i}
          style={{
            flex: 1,
            background:
              i <= score ? meta.color : "var(--surface-hover, rgba(255,255,255,0.08))",
          }}
        />
      ))}
    </span>
  );
}

type VaultT = ReturnType<typeof useTranslations<"vault">>;

function relativeTime(iso: string, t: VaultT): string {
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return "";
  const diff = Date.now() - ts;
  if (diff < 0) return t("relTime.justNow");
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return t("relTime.justNow");
  const min = Math.floor(sec / 60);
  if (min < 60) return t("relTime.minutesAgo", { n: min });
  const hr = Math.floor(min / 60);
  if (hr < 24) return t("relTime.hoursAgo", { n: hr });
  const day = Math.floor(hr / 24);
  if (day < 30) return t("relTime.daysAgo", { n: day });
  const month = Math.floor(day / 30);
  if (month < 12) return t("relTime.monthsAgo", { n: month });
  const year = Math.floor(day / 365);
  return t("relTime.yearsAgo", { n: year });
}

export default function VaultPanel({ children }: { children?: ReactNode }) {
  const t = useTranslations("vault");
  const confirm = useConfirm();
  const [entries, setEntries] = useState<VaultEntryListItem[] | null>(null);
  const [collections, setCollections] = useState<VaultCollection[]>([]);
  const [allTagsList, setAllTagsList] = useState<string[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [favoritesCount, setFavoritesCount] = useState(0);
  const [uncategorizedCount, setUncategorizedCount] = useState(0);
  const [duplicateIds, setDuplicateIds] = useState<Set<string>>(new Set());
  const [weakCount, setWeakCount] = useState(0);
  const [filter, setFilter] = useState<CollectionFilter>("all");
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [search, setSearch] = useState("");
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [editing, setEditing] = useState<VaultEntryListItem | null>(null);
  const [adding, setAdding] = useState(false);
  const [renamingCollection, setRenamingCollection] =
    useState<VaultCollection | null>(null);
  const [moving, setMoving] = useState<VaultEntryListItem | null>(null);
  const [creatingCollection, setCreatingCollection] = useState(false);
  const [importing, setImporting] = useState(false);
  const [exportPending, setExportPending] = useState(false);

  // Export du coffre personnel (JSON déchiffré) — réutilise l'endpoint RGPD
  // existant. Le serveur pose Content-Disposition: attachment → download natif.
  function downloadExport() {
    setExportPending(true);
    window.location.href = "/api/me/export?scope=personal";
    // Latence pour laisser le navigateur démarrer le download avant reset.
    setTimeout(() => setExportPending(false), 800);
  }
  const [sort, setSort] = useState<
    "name" | "recent" | "favorite_first" | "strength"
  >("name");
  // Vue liste / grille — préférence persistée dans localStorage. SSR-safe :
  // l'init renvoie "list" (default) puis on se synchronise dans un effect.
  const [viewMode, setViewMode] = useState<"list" | "grid">("list");
  useEffect(() => {
    if (typeof window === "undefined") return;
    const saved = window.localStorage.getItem("physalis-vault-view-mode");
    if (saved === "grid" || saved === "list") setViewMode(saved);
  }, []);
  function toggleViewMode(next: "list" | "grid") {
    setViewMode(next);
    if (typeof window !== "undefined") {
      window.localStorage.setItem("physalis-vault-view-mode", next);
    }
  }

  // Liste complete des tags + counts globaux : recalculee uniquement quand
  // le contenu de fond change (ajout/suppression/edition), pas quand l'user
  // toggle un filtre. Sinon allTagsList n'aurait que le tag courant et les
  // autres tags disparaitraient de l'UI.
  const reloadAllTags = useCallback(async () => {
    const res = await fetch("/api/vault/entries");
    if (!res.ok) return;
    const data = (await res.json()) as { entries: VaultEntryListItem[] };
    const set = new Set<string>();
    let favCount = 0;
    let uncatCount = 0;
    let weak = 0;
    for (const e of data.entries) {
      for (const tag of e.tags) set.add(tag);
      if (e.favorite) favCount++;
      if (e.collectionId === null) uncatCount++;
      // Faible = score 0 ou 1 (entries sans mot de passe exclues).
      if (e.passwordStrength !== null && e.passwordStrength <= 1) weak++;
    }
    setAllTagsList(Array.from(set).sort());
    setTotalCount(data.entries.length);
    setFavoritesCount(favCount);
    setUncategorizedCount(uncatCount);
    setWeakCount(weak);
    setDuplicateIds(computeDuplicates(data.entries));
  }, []);

  const reloadCollections = useCallback(async () => {
    const res = await fetch("/api/vault/collections");
    if (!res.ok) return;
    const data = (await res.json()) as { collections: VaultCollection[] };
    setCollections(data.collections);
  }, []);

  const reload = useCallback(async () => {
    setError(null);
    const params = new URLSearchParams();
    if (filter === "favorites") params.set("favorite", "true");
    else if (filter === "none") params.set("collectionId", "none");
    else if (
      filter !== "all" &&
      filter !== "duplicates" &&
      filter !== "weak"
    ) {
      params.set("collectionId", filter);
    }
    if (activeTag) params.set("tag", activeTag);
    if (search.trim()) params.set("search", search.trim());
    if (sort !== "name") params.set("sort", sort);
    const qs = params.toString();
    const res = await fetch(`/api/vault/entries${qs ? `?${qs}` : ""}`);
    if (!res.ok) {
      setError("Erreur de chargement.");
      return;
    }
    const data = (await res.json()) as { entries: VaultEntryListItem[] };
    // Filtres "doublons" et "faibles" appliqués client-side (notions non
    // connues du serveur ; le score faible = 0-1).
    const filtered =
      filter === "duplicates"
        ? data.entries.filter((e) => duplicateIds.has(e.id))
        : filter === "weak"
          ? data.entries.filter(
              (e) => e.passwordStrength !== null && e.passwordStrength <= 1,
            )
          : data.entries;
    setEntries(filtered);
  }, [filter, activeTag, search, sort, duplicateIds]);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(() => {
    reloadAllTags();
    reloadCollections();
  }, [reloadAllTags, reloadCollections]);

  async function createCollection(name: string): Promise<boolean> {
    const res = await fetch("/api/vault/collections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as
        | { error?: string }
        | null;
      setError(data?.error ?? t("createCollection.error"));
      return false;
    }
    setCreatingCollection(false);
    reloadCollections();
    return true;
  }

  async function removeCollection(c: VaultCollection) {
    if (
      !(await confirm({
        message: t("deleteCollection.confirm", {
          name: c.name,
          count: c.entryCount,
        }),
        danger: true,
      }))
    ) {
      return;
    }
    const res = await fetch(`/api/vault/collections/${c.id}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      setError(t("deleteCollection.error"));
      return;
    }
    if (filter === c.id) setFilter("all");
    reloadCollections();
    reloadAllTags();
    reload();
  }

  function renameCollection(c: VaultCollection) {
    setRenamingCollection(c);
  }

  async function reveal(id: string) {
    if (revealed[id] !== undefined) {
      setRevealed((r) => {
        const copy = { ...r };
        delete copy[id];
        return copy;
      });
      return;
    }
    const res = await fetch(`/api/vault/entries/${id}`);
    if (!res.ok) {
      setError(t("revealError"));
      return;
    }
    const data = (await res.json()) as { entry: { password: string | null } };
    setRevealed((r) => ({ ...r, [id]: data.entry.password ?? "" }));
  }

  async function copyToClipboard(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      setError(t("copySuccess", { label }));
      setTimeout(() => setError(null), 1500);
    } catch {
      setError(t("copyError"));
    }
  }

  async function copyPassword(id: string) {
    const res = await fetch(`/api/vault/entries/${id}`);
    if (!res.ok) {
      setError(t("revealError"));
      return;
    }
    const data = (await res.json()) as { entry: { password: string | null } };
    if (!data.entry.password) {
      setError(t("copyPasswordEmpty"));
      return;
    }
    copyToClipboard(data.entry.password, t("copyPasswordBtn"));
  }

  async function toggleFavorite(entry: VaultEntryListItem) {
    const res = await fetch(`/api/vault/entries/${entry.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ favorite: !entry.favorite }),
    });
    if (!res.ok) {
      setError(t("updateError"));
      return;
    }
    reload();
  }

  async function remove(entry: VaultEntryListItem) {
    if (!(await confirm({ message: t("deleteConfirm", { name: entry.name }), danger: true })))
      return;
    const res = await fetch(`/api/vault/entries/${entry.id}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      setError(t("deleteError"));
      return;
    }
    setRevealed((r) => {
      const copy = { ...r };
      delete copy[entry.id];
      return copy;
    });
    reload();
    reloadAllTags();
  }

  return (
    <div className="side-shell">
      {/* Menu — collections perso, à gauche du contenu (hors du bloc) */}
      <aside className="side-nav-col" style={{ "--rail-top": "138px" } as CSSProperties}>
        <div className="side-nav">
        <SidebarItem
          active={filter === "all"}
          onClick={() => setFilter("all")}
          icon={<RiInboxArchiveLine size={16} aria-hidden />}
          label={t("allEntries")}
          count={totalCount}
        />
        <SidebarItem
          active={filter === "favorites"}
          onClick={() => setFilter("favorites")}
          icon={<RiStarFill size={16} aria-hidden style={{ color: "var(--accent, #f59e0b)" }} />}
          label={t("favorites")}
          count={favoritesCount}
        />

        <div className="side-nav-section">
          <span>{t("collectionsTitle")}</span>
          <button
            type="button"
            onClick={() => setCreatingCollection(true)}
            className="btn btn-ghost btn-xs"
            title={t("createCollectionBtn")}
            style={{ padding: "2px 6px" }}
          >
            +
          </button>
        </div>

        {creatingCollection && (
          <div style={{ padding: "4px 0" }}>
            <CreateCollectionInline
              onCancel={() => setCreatingCollection(false)}
              onCreated={createCollection}
            />
          </div>
        )}

        {collections.length === 0 && !creatingCollection ? (
          <p className="help" style={{ padding: "4px 8px", fontSize: 11 }}>
            {t("noCollections")}
          </p>
        ) : (
          collections.map((c) => (
            <SidebarItem
              key={c.id}
              active={filter === c.id}
              onClick={() => setFilter(c.id)}
              icon={<RiFolderOpenLine size={16} aria-hidden />}
              label={c.name}
              count={c.entryCount}
              onRename={() => renameCollection(c)}
              onDelete={() => removeCollection(c)}
            />
          ))
        )}

        {uncategorizedCount > 0 && (
          <SidebarItem
            active={filter === "none"}
            onClick={() => setFilter("none")}
            icon={<RiInboxArchiveLine size={16} aria-hidden style={{ opacity: 0.5 }} />}
            label={t("noCategory")}
            count={uncategorizedCount}
            muted
          />
        )}

        {duplicateIds.size > 0 && (
          <SidebarItem
            active={filter === "duplicates"}
            onClick={() => setFilter("duplicates")}
            icon={<span style={{ fontSize: 14, lineHeight: 1 }}>⚠</span>}
            label={t("duplicates")}
            count={duplicateIds.size}
            warning
          />
        )}

        {weakCount > 0 && (
          <SidebarItem
            active={filter === "weak"}
            onClick={() => setFilter("weak")}
            icon={<span style={{ fontSize: 13, lineHeight: 1 }}>🔓</span>}
            label={t("weakPasswords")}
            count={weakCount}
            warning
          />
        )}
        </div>
      </aside>

      {/* Contenu — titre + entries, dans le bloc centré */}
      <div className="side-content">
        <div className="page">
          <div className="page-content">
            {children}
            <div className="flex flex-col gap-4">
        <ExtensionBanner totalCount={totalCount} />
        {/* Toolbar */}
        <div className="form-row" style={{ alignItems: "center" }}>
          <div className="field" style={{ minWidth: 220, flex: 1 }}>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("searchPlaceholder")}
              className="input"
            />
          </div>
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as typeof sort)}
            className="select"
            title={t("sortTitle")}
            style={{ width: "auto", minWidth: 140 }}
          >
            <option value="name">{t("sortByName")}</option>
            <option value="recent">{t("sortByRecent")}</option>
            <option value="favorite_first">{t("sortByFavorite")}</option>
            <option value="strength">{t("sortByStrength")}</option>
          </select>
          <div
            role="group"
            aria-label={t("viewModeList")}
            style={{ display: "inline-flex", border: "1px solid var(--border)", borderRadius: 6, overflow: "hidden" }}
          >
            <button
              type="button"
              onClick={() => toggleViewMode("list")}
              title={t("viewModeList")}
              aria-pressed={viewMode === "list"}
              className="btn btn-ghost"
              style={{
                padding: "6px 8px",
                borderRadius: 0,
                background: viewMode === "list" ? "var(--surface-hover, rgba(255,255,255,0.06))" : "transparent",
              }}
            >
              <RiListCheck2 size={16} aria-hidden />
            </button>
            <button
              type="button"
              onClick={() => toggleViewMode("grid")}
              title={t("viewModeGrid")}
              aria-pressed={viewMode === "grid"}
              className="btn btn-ghost"
              style={{
                padding: "6px 8px",
                borderRadius: 0,
                background: viewMode === "grid" ? "var(--surface-hover, rgba(255,255,255,0.06))" : "transparent",
              }}
            >
              <RiGridLine size={16} aria-hidden />
            </button>
          </div>
          <button
            type="button"
            onClick={() => setImporting(true)}
            className="btn btn-ghost"
            title={t("importBtn")}
          >
            {t("importBtn")}
          </button>
          <button
            type="button"
            onClick={downloadExport}
            disabled={exportPending}
            className="btn btn-ghost"
            title={t("exportBtn")}
          >
            {t("exportBtn")}
          </button>
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="btn btn-primary"
          >
            {t("addBtn")}
          </button>
        </div>

        {allTagsList.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => setActiveTag(null)}
              className={`chip chip-button ${
                activeTag === null ? "active chip-active" : ""
              }`}
            >
              tous
            </button>
            {allTagsList.map((tag) => (
              <button
                key={tag}
                type="button"
                onClick={() => setActiveTag(tag === activeTag ? null : tag)}
                className={`chip chip-button ${
                  activeTag === tag ? "active chip-active" : ""
                }`}
              >
                {tag}
              </button>
            ))}
          </div>
        )}

        {error && <p className="help text-accent">{error}</p>}

        {(adding || editing) && (
          <EntryDialog
            initial={editing}
            collections={collections}
            suggestions={allTagsList}
            defaultCollectionId={
              !editing && filter !== "all" && filter !== "favorites" && filter !== "none"
                ? filter
                : null
            }
            onClose={() => {
              setAdding(false);
              setEditing(null);
            }}
            onSaved={() => {
              setAdding(false);
              setEditing(null);
              reload();
              reloadAllTags();
              reloadCollections();
            }}
          />
        )}

        {moving && (
          <MoveDialog
            entry={moving}
            onClose={() => setMoving(null)}
            onMoved={(target) => {
              setMoving(null);
              setRevealed((r) => {
                const copy = { ...r };
                delete copy[moving.id];
                return copy;
              });
              setError(t("moveSuccess", { target }));
              setTimeout(() => setError(null), 2500);
              reload();
              reloadAllTags();
              reloadCollections();
            }}
          />
        )}

        {importing && (
          <ImportDialog
            onClose={() => setImporting(false)}
            onImported={(count) => {
              setImporting(false);
              setError(t("import.success", { count }));
              setTimeout(() => setError(null), 3000);
              reload();
              reloadAllTags();
              reloadCollections();
            }}
          />
        )}

        {renamingCollection && (
          <RenameCollectionDialog
            currentName={renamingCollection.name}
            endpoint={`/api/vault/collections/${renamingCollection.id}`}
            onClose={() => setRenamingCollection(null)}
            onRenamed={() => {
              setRenamingCollection(null);
              reloadCollections();
            }}
          />
        )}

        {entries === null ? (
          <p className="help">Chargement…</p>
        ) : entries.length === 0 ? (
          <EmptyEntries
            filter={filter}
            collections={collections}
            totalCount={totalCount}
            onAdd={() => setAdding(true)}
            onImport={() => setImporting(true)}
          />
        ) : viewMode === "grid" ? (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
              gap: 12,
            }}
          >
            {entries.map((e) => {
              const collection = collections.find((c) => c.id === e.collectionId);
              const domain = e.url
                ? e.url.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0]
                : null;
              return (
                <div
                  key={e.id}
                  className="card vault-grid-card"
                  style={{
                    padding: 14,
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "stretch",
                    gap: 10,
                    position: "relative",
                  }}
                >
                  {/* Star top-left + collection chip top-right */}
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      minHeight: 22,
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => toggleFavorite(e)}
                      title={e.favorite ? t("form.removeFavorite") : t("form.addFavorite")}
                      className={`star-btn ${e.favorite ? "active" : ""}`}
                    >
                      ★
                    </button>
                    {collection && (
                      <span
                        className="chip"
                        style={{ fontSize: 10, maxWidth: 100, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                        title={collection.name}
                      >
                        {collection.name}
                      </span>
                    )}
                  </div>

                  {/* 48x48 favicon (fallback initiales) centré */}
                  <div
                    aria-hidden
                    style={{
                      width: 48,
                      height: 48,
                      borderRadius: "50%",
                      background: "var(--surface-hover, rgba(99, 102, 241, 0.15))",
                      color: "var(--text-strong, #fff)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 16,
                      fontWeight: 600,
                      alignSelf: "center",
                      overflow: "hidden",
                    }}
                  >
                    <EntryIcon name={e.name} url={e.url} />
                  </div>

                  {/* Name + domain */}
                  <div style={{ textAlign: "center", overflow: "hidden" }}>
                    <div
                      className="row-name"
                      title={e.name}
                      style={{
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {e.name}
                    </div>
                    {domain && (
                      <div
                        className="text-muted"
                        title={e.url ?? undefined}
                        style={{
                          fontSize: 11,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {domain}
                      </div>
                    )}
                  </div>

                  {e.passwordStrength !== null && (
                    <div style={{ display: "flex", justifyContent: "center" }}>
                      <StrengthBar score={e.passwordStrength} label={t("strength")} />
                    </div>
                  )}

                  {/* Badges 2FA + doublon */}
                  {(e.hasTotpSecret || duplicateIds.has(e.id)) && (
                    <div className="flex items-center gap-1 justify-center" style={{ flexWrap: "wrap" }}>
                      {e.hasTotpSecret && (
                        <span className="chip" style={{ fontSize: 10 }}>{t("form.twoFaBadge")}</span>
                      )}
                      {duplicateIds.has(e.id) && (
                        <button
                          type="button"
                          onClick={() => setFilter("duplicates")}
                          className="chip"
                          style={{
                            fontSize: 10,
                            background: "rgba(249, 115, 22, 0.15)",
                            color: "#f97316",
                            border: "1px solid rgba(249, 115, 22, 0.3)",
                            cursor: "pointer",
                            fontFamily: "inherit",
                          }}
                        >
                          {t("form.duplicateBadge")}
                        </button>
                      )}
                    </div>
                  )}

                  {/* Hover actions */}
                  <div
                    className="vault-grid-actions"
                    style={{
                      display: "flex",
                      justifyContent: "center",
                      gap: 4,
                      marginTop: "auto",
                      paddingTop: 8,
                      borderTop: "1px solid var(--border, rgba(255,255,255,0.08))",
                    }}
                  >
                    {e.username && (
                      <button
                        type="button"
                        onClick={() => copyToClipboard(e.username!, t("copyLoginBtn"))}
                        title={t("copyLoginBtn")}
                        className="btn btn-ghost btn-xs"
                        style={{ padding: "4px 8px" }}
                      >
                        👤
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => copyPassword(e.id)}
                      title={t("copyPasswordBtn")}
                      className="btn btn-ghost btn-xs"
                      style={{ padding: "4px 8px" }}
                    >
                      🔑
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditing(e)}
                      title={t("editBtn")}
                      className="btn btn-ghost btn-xs"
                      style={{ padding: "4px 8px" }}
                    >
                      ✎
                    </button>
                    <GridMoreMenu
                      onMove={() => setMoving(e)}
                      onDelete={() => remove(e)}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="row-list">
            {entries.map((e) => (
              <div key={e.id} className="row">
                <div className="row-icon"><EntryIcon name={e.name} url={e.url} /></div>
                <div className="row-info">
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => toggleFavorite(e)}
                      title={
                        e.favorite ? t("form.removeFavorite") : t("form.addFavorite")
                      }
                      className={`star-btn ${e.favorite ? "active" : ""}`}
                    >
                      ★
                    </button>
                    <div className="row-name">
                      {e.name}
                      {e.hasTotpSecret && (
                        <span
                          className="chip"
                          style={{ marginLeft: 6, fontSize: 10 }}
                        >
                          {t("form.twoFaBadge")}
                        </span>
                      )}
                      {duplicateIds.has(e.id) && (
                        <button
                          type="button"
                          onClick={() => setFilter("duplicates")}
                          className="chip"
                          style={{
                            marginLeft: 6,
                            fontSize: 10,
                            background: "rgba(249, 115, 22, 0.15)",
                            color: "#f97316",
                            border: "1px solid rgba(249, 115, 22, 0.3)",
                            cursor: "pointer",
                            fontFamily: "inherit",
                          }}
                        >
                          {t("form.duplicateBadge")}
                        </button>
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
                    <span className="text-muted" title={new Date(e.updatedAt).toLocaleString()}>
                      {relativeTime(e.updatedAt, t)}
                    </span>
                    <StrengthBar score={e.passwordStrength} label={t("strength")} />
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
                      onClick={() => copyToClipboard(e.username!, t("copyLoginBtn"))}
                      className="btn btn-ghost btn-xs"
                    >
                      {t("copyLoginBtn")}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => copyPassword(e.id)}
                    className="btn btn-ghost btn-xs"
                  >
                    {t("copyPasswordBtn")}
                  </button>
                  <button
                    type="button"
                    onClick={() => reveal(e.id)}
                    className="btn btn-ghost btn-xs"
                  >
                    {revealed[e.id] !== undefined ? t("hideBtn") : t("revealBtn")}
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditing(e)}
                    className="btn btn-ghost btn-xs"
                  >
                    {t("editBtn")}
                  </button>
                  <button
                    type="button"
                    onClick={() => setMoving(e)}
                    className="btn btn-ghost btn-xs"
                    title={t("moveBtn")}
                  >
                    {t("moveBtn")}
                  </button>
                  <button
                    type="button"
                    onClick={() => remove(e)}
                    className="btn btn-danger btn-xs"
                  >
                    {t("deleteBtn")}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Sidebar helpers ──────────────────────────────────────────────────

function SidebarItem({
  active,
  onClick,
  icon,
  label,
  count,
  muted,
  warning,
  onRename,
  onDelete,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  count: number;
  muted?: boolean;
  warning?: boolean;
  onRename?: () => void;
  onDelete?: () => void;
}) {
  const showActions = Boolean(onRename || onDelete);
  const cls = ["side-nav-item"];
  if (active) cls.push("active");
  if (warning) cls.push("is-warning");
  else if (muted) cls.push("is-muted");
  if (showActions) cls.push("vault-sidebar-item");
  return (
    <div className={cls.join(" ")}>
      <button type="button" onClick={onClick} className="side-nav-hit">
        <span className="side-nav-icon">{icon}</span>
        <span className="side-nav-label">{label}</span>
        <span className="side-nav-count">{count}</span>
      </button>
      {onRename && (
        <button
          type="button"
          onClick={onRename}
          title="Renommer la collection"
          aria-label={`Renommer ${label}`}
          className="vault-sidebar-action"
        >
          ✏️
        </button>
      )}
      {onDelete && (
        <button
          type="button"
          onClick={onDelete}
          title="Supprimer la collection"
          aria-label={`Supprimer ${label}`}
          className="vault-sidebar-action"
        >
          ✕
        </button>
      )}
    </div>
  );
}

function CreateCollectionInline({
  onCancel,
  onCreated,
}: {
  onCancel: () => void;
  onCreated: (name: string) => Promise<boolean>;
}) {
  const t = useTranslations("vault");
  const [name, setName] = useState("");
  const [pending, startTransition] = useTransition();

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!name.trim()) return;
    startTransition(async () => {
      const ok = await onCreated(name.trim());
      if (ok) setName("");
    });
  }

  return (
    <form onSubmit={submit} style={{ padding: "0 6px" }}>
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        placeholder={t("createCollection.nameLabel")}
        className="input"
        style={{ fontSize: 12, padding: "4px 8px" }}
        disabled={pending}
      />
    </form>
  );
}

function GridMoreMenu({
  onMove,
  onDelete,
}: {
  onMove: () => void;
  onDelete: () => void;
}) {
  const t = useTranslations("vault");
  const [open, setOpen] = useState(false);

  // Click outside → close. Garde une dépendance simple (pas de ref complexe).
  useEffect(() => {
    if (!open) return;
    function handler(ev: MouseEvent) {
      const target = ev.target as HTMLElement | null;
      if (target?.closest("[data-grid-more-root]")) return;
      setOpen(false);
    }
    document.addEventListener("click", handler);
    return () => document.removeEventListener("click", handler);
  }, [open]);

  return (
    <div data-grid-more-root style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={t("moveBtn")}
        aria-haspopup="menu"
        aria-expanded={open}
        className="btn btn-ghost btn-xs"
        style={{ padding: "4px 8px" }}
      >
        ⋯
      </button>
      {open && (
        <div
          role="menu"
          style={{
            position: "absolute",
            right: 0,
            bottom: "100%",
            marginBottom: 4,
            minWidth: 140,
            background: "var(--surface, #1a1a1a)",
            border: "1px solid var(--border, rgba(255,255,255,0.1))",
            borderRadius: 6,
            padding: 4,
            zIndex: 10,
            boxShadow: "0 4px 16px rgba(0,0,0,0.3)",
          }}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onMove();
            }}
            className="btn btn-ghost btn-sm"
            style={{ width: "100%", justifyContent: "flex-start", padding: "6px 10px" }}
          >
            {t("moveBtn")}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onDelete();
            }}
            className="btn btn-ghost btn-sm"
            style={{
              width: "100%",
              justifyContent: "flex-start",
              padding: "6px 10px",
              color: "var(--danger, #ef4444)",
            }}
          >
            {t("deleteBtn")}
          </button>
        </div>
      )}
    </div>
  );
}

function PasswordStrengthMeter({ password }: { password: string }) {
  const { score, label, color, hint } = estimateStrength(password);
  const segments = [0, 1, 2, 3, 4];
  return (
    <div style={{ marginTop: 6 }}>
      <div
        style={{
          display: "flex",
          gap: 3,
          height: 4,
          borderRadius: 2,
          overflow: "hidden",
        }}
        aria-hidden
      >
        {segments.map((i) => (
          <div
            key={i}
            style={{
              flex: 1,
              background: i <= score ? color : "var(--surface-hover, rgba(255,255,255,0.06))",
              transition: "background .2s",
            }}
          />
        ))}
      </div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginTop: 4,
          fontSize: 11,
        }}
      >
        <span style={{ color, fontWeight: 600 }}>{label}</span>
        {hint && <span className="text-muted">{hint}</span>}
      </div>
    </div>
  );
}

function EmptyEntries({
  filter,
  collections,
  totalCount,
  onAdd,
  onImport,
}: {
  filter: CollectionFilter;
  collections: VaultCollection[];
  totalCount: number;
  onAdd: () => void;
  onImport: () => void;
}) {
  const t = useTranslations("vault");
  // Coffre 100% vide → onboarding 3 cards (créer, importer, extension).
  if (totalCount === 0) {
    return (
      <div className="flex flex-col gap-3">
        <div className="empty-state" style={{ paddingBottom: 18 }}>
          <div className="empty-state-title">{t("onboarding.welcomeTitle")}</div>
          <div style={{ marginTop: 6 }}>
            {t("onboarding.welcomeDesc")}
          </div>
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
            gap: 12,
          }}
        >
          <OnboardingCard
            title={t("onboarding.createTitle")}
            description={t("onboarding.createDesc")}
            ctaLabel={t("addBtn")}
            onClick={onAdd}
            primary
          />
          <OnboardingCard
            title={t("onboarding.importTitle")}
            description={t("onboarding.importDesc")}
            ctaLabel={t("importBtn")}
            onClick={onImport}
          />
          <OnboardingCard
            title={t("onboarding.extensionTitle")}
            description={t("onboarding.extensionDesc")}
            ctaLabel={t("onboarding.extensionBtn")}
            onClick={() => window.open("/docs/extension", "_blank")}
          />
        </div>
      </div>
    );
  }

  let label = t("emptyNoFilter");
  if (filter === "favorites") label = t("emptyNoFavorites");
  else if (filter === "none") label = t("emptyNoUncategorized");
  else if (filter === "duplicates") label = t("emptyNoDuplicates");
  else if (filter !== "all") {
    const c = collections.find((c) => c.id === filter);
    label = c ? t("emptyCollection", { name: c.name }) : t("form.emptyCategoryHint");
  }

  return (
    <div className="empty-state">
      <div className="empty-state-title">{label}</div>
    </div>
  );
}

function OnboardingCard({
  title,
  description,
  ctaLabel,
  onClick,
  primary,
}: {
  title: string;
  description: string;
  ctaLabel: string;
  onClick: () => void;
  primary?: boolean;
}) {
  return (
    <div
      className="card"
      style={{
        padding: 14,
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        gap: 10,
      }}
    >
      <div>
        <div className="row-name" style={{ marginBottom: 4 }}>{title}</div>
        <div className="help">{description}</div>
      </div>
      <button
        type="button"
        onClick={onClick}
        className={`btn btn-sm ${primary ? "btn-primary" : "btn-ghost"}`}
        style={{ alignSelf: "flex-start" }}
      >
        {ctaLabel}
      </button>
    </div>
  );
}

function EntryDialog({
  initial,
  collections,
  suggestions,
  defaultCollectionId,
  onClose,
  onSaved,
}: {
  initial: VaultEntryListItem | null;
  collections: VaultCollection[];
  /** Tags déjà utilisés → autocomplete. */
  suggestions: string[];
  defaultCollectionId: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useTranslations("vault");
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
  const [collectionId, setCollectionId] = useState<string | "">(
    initial?.collectionId ?? defaultCollectionId ?? "",
  );
  const [pwdLoaded, setPwdLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  async function loadCurrentSecrets() {
    if (!initial) return;
    const res = await fetch(`/api/vault/entries/${initial.id}`);
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

  function generate() {
    setPassword(generatePassword(24));
    setShowPassword(true);
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
        collectionId: collectionId === "" ? null : collectionId,
      };
      if (!isEdit || pwdLoaded) {
        body.password = password;
      }
      if (!isEdit || totpLoaded) {
        body.totpSecret = totpSecret.trim() || null;
      }

      const url2 = isEdit
        ? `/api/vault/entries/${initial!.id}`
        : "/api/vault/entries";
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

        <form onSubmit={submit}>
          <div className="dialog-body">
            <div className="field">
              <label>{t("form.nameLabel")} *</label>
              <input
                required
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Gmail perso"
                className="input"
              />
            </div>
            <div className="field">
              <label>{t("form.urlLabel")}</label>
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://gmail.com"
                className="input input-mono"
              />
            </div>
            <div className="field">
              <label>{t("form.usernameLabel")}</label>
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="gael@gmail.com"
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
                    onClick={generate}
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
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  setPwdLoaded(true);
                }}
                placeholder={
                  isEdit && !pwdLoaded ? t("form.unchanged") : "••••••••••••"
                }
                className="input input-mono"
              />
              {(pwdLoaded || !isEdit) && password.length > 0 && (
                <PasswordStrengthMeter password={password} />
              )}
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
                type={showTotpSecret ? "text" : "password"}
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
                className="input input-mono"
              />
              <div className="help" style={{ marginTop: 4 }}>
                {t("form.totpHint")}
              </div>
            </div>

            <div className="field">
              <label>{t("form.collectionLabel")}</label>
              <select
                value={collectionId}
                onChange={(e) => setCollectionId(e.target.value)}
                className="select"
              >
                <option value="">{t("form.noneCollection")}</option>
                {collections.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
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
              <span>{t("form.favoriteLabel")} Favori</span>
            </label>

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

// ─── MoveDialog ──────────────────────────────────────────────────────────
// Dialog pour deplacer une entree perso vers une collection d'equipe (org
// ou projet). Charge l'arborescence via /api/vault/destinations a
// l'ouverture, propose deux selecteurs en cascade : scope (org | projet) →
// collection. Seules les collections EDITOR+ apparaissent.

type Destination = {
  slug: string;
  name: string;
  collections: Array<{ slug: string; name: string; role: string }>;
};

type Destinations = {
  orgs: Destination[];
  projects: Array<Destination & { orgSlug: string }>;
};

function MoveDialog({
  entry,
  onClose,
  onMoved,
}: {
  entry: VaultEntryListItem;
  onClose: () => void;
  onMoved: (targetLabel: string) => void;
}) {
  const t = useTranslations("vault");
  const [destinations, setDestinations] = useState<Destinations | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [scope, setScope] = useState<"team_org" | "team_project" | "project_account">("team_org");
  const [parentSlug, setParentSlug] = useState<string>("");
  const [collectionSlug, setCollectionSlug] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch("/api/vault/destinations");
      if (cancelled) return;
      if (!res.ok) {
        setLoadError("Impossible de charger les destinations.");
        return;
      }
      const data = (await res.json()) as Destinations;
      setDestinations(data);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const orgs = destinations?.orgs ?? [];
  const projects = destinations?.projects ?? [];

  const parentOptions = scope === "team_org" ? orgs : projects;
  const selectedParent = parentOptions.find((p) => p.slug === parentSlug);
  const collections = selectedParent?.collections ?? [];
  // Cible « compte de projet » (AppAccount) : pas de collection ; url + 2FA perdus.
  const isAccountTarget = scope === "project_account";

  // Reset cascade quand l'utilisateur change de scope.
  function changeScope(next: "team_org" | "team_project" | "project_account") {
    setScope(next);
    setParentSlug("");
    setCollectionSlug("");
    setError(null);
  }

  function changeParent(slug: string) {
    setParentSlug(slug);
    setCollectionSlug("");
    setError(null);
  }

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!parentSlug || (!isAccountTarget && !collectionSlug)) {
      setError(t("move.noDestError"));
      return;
    }
    setError(null);
    startTransition(async () => {
      const body: Record<string, string> = { target: scope };
      if (scope === "team_org") {
        body.orgSlug = parentSlug;
        body.collectionSlug = collectionSlug;
      } else if (scope === "team_project") {
        body.projectSlug = parentSlug;
        body.collectionSlug = collectionSlug;
      } else {
        // project_account : pas de collection
        body.projectSlug = parentSlug;
      }

      const res = await fetch(`/api/vault/entries/${entry.id}/move`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        setError(data?.error ?? t("deleteError"));
        return;
      }
      const parentName = selectedParent?.name ?? parentSlug;
      const label = isAccountTarget
        ? `${parentName} / ${t("move.scopeAccount")}`
        : `${parentName} / ${collections.find((c) => c.slug === collectionSlug)?.name ?? collectionSlug}`;
      onMoved(label);
    });
  }

  const noTargets = parentOptions.length === 0;

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-header">
          <h2 className="dialog-title">{t("moveBtn")} « {entry.name} »</h2>
          <button
            type="button"
            onClick={onClose}
            className="dialog-close"
            aria-label={t("form.closeLabel")}
          >
            ✕
          </button>
        </div>

        {loadError ? (
          <div className="dialog-body">
            <p className="error-text">{loadError}</p>
          </div>
        ) : !destinations ? (
          <div className="dialog-body">
            <p className="help">{t("move.loadingDest")}</p>
          </div>
        ) : (
          <form onSubmit={submit}>
            <div className="dialog-body">
              <p className="help">
                {t("move.teamVaultNote")}
              </p>

              <div className="field">
                <label>{t("move.destTypeLabel")}</label>
                <div className="flex items-center gap-3">
                  <label
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      cursor: "pointer",
                      fontSize: 13,
                    }}
                  >
                    <input
                      type="radio"
                      name="scope"
                      value="team_org"
                      checked={scope === "team_org"}
                      onChange={() => changeScope("team_org")}
                    />
                    {t("move.scopeOrg")}
                  </label>
                  <label
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      cursor: "pointer",
                      fontSize: 13,
                    }}
                  >
                    <input
                      type="radio"
                      name="scope"
                      value="team_project"
                      checked={scope === "team_project"}
                      onChange={() => changeScope("team_project")}
                    />
                    {t("move.scopeProject")}
                  </label>
                  <label
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      cursor: "pointer",
                      fontSize: 13,
                    }}
                  >
                    <input
                      type="radio"
                      name="scope"
                      value="project_account"
                      checked={scope === "project_account"}
                      onChange={() => changeScope("project_account")}
                    />
                    {t("move.scopeAccount")}
                  </label>
                </div>
              </div>

              <div className="field">
                <label>{scope === "team_org" ? t("move.orgLabel") : t("move.projectLabel")}</label>
                <select
                  value={parentSlug}
                  onChange={(e) => changeParent(e.target.value)}
                  className="select"
                  required
                  disabled={noTargets}
                >
                  <option value="">{t("move.selectPlaceholder")}</option>
                  {parentOptions.map((p) => (
                    <option key={p.slug} value={p.slug}>
                      {p.name}
                      {!isAccountTarget && p.collections.length === 0 ? t("move.noCollectionSuffix") : ""}
                    </option>
                  ))}
                </select>
                {noTargets && (
                  <div className="help" style={{ marginTop: 6 }}>
                    {scope === "team_org"
                      ? t("move.noOrgs")
                      : t("move.noProjects")}
                  </div>
                )}
              </div>

              {isAccountTarget ? (
                <div
                  style={{
                    background: "rgba(234,179,8,0.08)",
                    border: "1px solid rgba(234,179,8,0.3)",
                    borderRadius: 6,
                    padding: "8px 12px",
                    fontSize: 12,
                    lineHeight: 1.6,
                  }}
                >
                  {t("move.accountWarning")}
                </div>
              ) : (
                <div className="field">
                  <label>{t("move.collectionLabel")}</label>
                  <select
                    value={collectionSlug}
                    onChange={(e) => setCollectionSlug(e.target.value)}
                    className="select"
                    required
                    disabled={!parentSlug || collections.length === 0}
                  >
                    <option value="">{t("move.selectPlaceholder")}</option>
                    {collections.map((c) => (
                      <option key={c.slug} value={c.slug}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                  {parentSlug && collections.length === 0 && (
                    <div className="help" style={{ marginTop: 6 }}>
                      {t("move.noEditorCollections")}
                    </div>
                  )}
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
                {t("move.cancelBtn")}
              </button>
              <button
                type="submit"
                disabled={pending || !parentSlug || (!isAccountTarget && !collectionSlug)}
                className="btn btn-primary btn-sm"
              >
                {pending ? t("move.movingBtn") : t("move.moveBtn")}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

// ─── ImportDialog ───────────────────────────────────────────────────────
// Importe un CSV (Bitwarden / Chrome / générique). Workflow :
// 1. Drop / pick fichier → lit en text → POST dryRun pour preview format
// 2. Confirm → POST sans dryRun → crée collections (si folder rempli) +
//    entries chiffrées côté serveur
//
// Parsing fait côté serveur (lib/csv-import.ts) — code DRY, validable.

type ImportPreview = {
  ok: true;
  format: "bitwarden" | "chrome" | "generic";
  imported: number;
  collectionsCreated: number;
  dryRun: boolean;
  sample: Array<{
    name: string;
    url: string | null;
    username: string | null;
    collectionName: string | null;
  }>;
};

function ImportDialog({
  onClose,
  onImported,
}: {
  onClose: () => void;
  onImported: (count: number) => void;
}) {
  const t = useTranslations("vault");
  const [csv, setCsv] = useState<string>("");
  const [fileName, setFileName] = useState<string>("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setPreview(null);
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result ?? "");
      setCsv(text);
      doPreview(text);
    };
    reader.onerror = () => setError("Lecture du fichier impossible.");
    reader.readAsText(file);
  }

  function doPreview(text: string) {
    startTransition(async () => {
      const res = await fetch("/api/vault/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ csv: text, dryRun: true }),
      });
      const data = (await res.json().catch(() => null)) as
        | ImportPreview
        | { error?: string }
        | null;
      if (!res.ok || !data || !("ok" in data)) {
        setError(
          data && "error" in data && data.error
            ? data.error
            : t("import.error"),
        );
        return;
      }
      setPreview(data);
    });
  }

  function confirmImport() {
    if (!csv) return;
    startTransition(async () => {
      const res = await fetch("/api/vault/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ csv, dryRun: false }),
      });
      const data = (await res.json().catch(() => null)) as
        | { ok?: true; imported?: number }
        | { error?: string }
        | null;
      if (!res.ok || !data || !("ok" in data)) {
        setError(
          data && "error" in data && data.error
            ? data.error
            : "Import impossible.",
        );
        return;
      }
      onImported(data.imported ?? 0);
    });
  }

  const formatLabel = preview
    ? { bitwarden: "Bitwarden", chrome: "Chrome", generic: t("import.formatGeneric") }[preview.format]
    : null;

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-header">
          <h2 className="dialog-title">{t("import.title")}</h2>
          <button
            type="button"
            onClick={onClose}
            className="dialog-close"
            aria-label={t("import.closeLabel")}
          >
            ✕
          </button>
        </div>

        <div className="dialog-body">
          <p className="help">
            {t("import.formats")}
          </p>

          {!preview && (
            <div className="field" style={{ marginTop: 12 }}>
              <label>{t("import.fileLabel")}</label>
              <input
                type="file"
                accept=".csv,text/csv"
                onChange={onFile}
                disabled={pending}
                className="input"
              />
            </div>
          )}

          {preview && (
            <div className="card" style={{ marginTop: 12, padding: 12 }}>
              <div className="row-name" style={{ marginBottom: 8 }}>
                {fileName} <span className="chip" style={{ marginLeft: 6 }}>{formatLabel}</span>
              </div>
              <p className="help">
                {t("import.preview", { count: preview.imported })}
              </p>
              <div className="row-meta" style={{ marginTop: 8 }}>
                {t("import.sampleTitle")}
              </div>
              <ul className="help" style={{ paddingLeft: 18, marginTop: 6 }}>
                {preview.sample.map((e, i) => (
                  <li key={i}>
                    <strong>{e.name}</strong>
                    {e.username && <> · <span className="code-mono">{e.username}</span></>}
                    {e.collectionName && <> · <span className="chip">{e.collectionName}</span></>}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {error && <p className="error-text" style={{ marginTop: 10 }}>{error}</p>}
        </div>

        <div className="dialog-footer">
          <button
            type="button"
            onClick={onClose}
            className="btn btn-ghost btn-sm"
          >
            {t("import.cancelBtn")}
          </button>
          {preview && (
            <button
              type="button"
              onClick={confirmImport}
              disabled={pending}
              className="btn btn-primary btn-sm"
            >
              {pending ? t("import.importingBtn") : t("import.submitBtn", { count: preview.imported })}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
