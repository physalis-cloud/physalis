"use client";

import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import type { ProjectRole } from "@prisma/client";
import { useTranslations } from "next-intl";
import { RiServerLine } from "@remixicon/react";
import EmptyCard from "@/components/EmptyCard";
import { useConfirm } from "@/components/ConfirmDialog";
import ImmediateRotationSection from "@/components/ImmediateRotationSection";
import { generatePassword } from "@/lib/generate-password";
import TagsInput from "@/components/TagsInput";

const ROLE_RANK: Record<ProjectRole, number> = {
  VIEWER: 1,
  EDITOR: 2,
  OWNER: 3,
};

const ENV_DISPLAY_NAMES: Record<string, string> = {};

function envDisplay(name: string): string {
  return ENV_DISPLAY_NAMES[name] ?? name;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 0 || !parts[0]) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

type EnvSummary = { id: string; name: string; url: string | null };

// Extrait l'en-tete du README (titre + description) : tout le HTML AVANT le
// premier <h2> (= premiere section « ## »). Le HTML est deja sanitize cote
// serveur et les badges GitHub deja retires (cf. renderMarkdownSafe). Regex
// volontaire (pas de DOMParser) pour rester SSR-safe. Retourne null si vide.
function readmeHeaderHtml(html: string | null | undefined): string | null {
  if (!html) return null;
  const h2 = html.search(/<h2\b/i);
  let header = h2 === -1 ? html : html.slice(0, h2);
  header = header
    // Pas d'image dans l'encart (logo/banniere de README) + liens/paragraphes
    // devenus vides apres suppression.
    .replace(/<img\b[^>]*>/gi, "")
    .replace(/<a\b[^>]*>\s*<\/a>/gi, "")
    .replace(/<p\b[^>]*>\s*<\/p>/gi, "")
    // Pas de <hr> en fin de texte (separateur avant la 1re section).
    .replace(/(?:\s*<hr\b[^>]*?\/?>\s*)+$/i, "")
    .trim();
  // Au moins un peu de texte exploitable (evite un en-tete vide / image seule).
  if (header.replace(/<[^>]*>/g, "").trim().length === 0) return null;
  return header;
}

type ServiceListItem = {
  id: string;
  name: string;
  url: string | null;
  tags: string[];
  updatedAt: string;
  rotationWebhookUrl: string | null;
  rotationExecMode: string | null;
  dbType: string | null;
  dbHost: string | null;
  dbPort: number | null;
  dbName: string | null;
  dbUser: string | null;
};

type AccountListItem = {
  id: string;
  name: string;
  tags: string[];
  updatedAt: string;
  url: string | null;
  linkType: "environment" | "service" | null;
  linkName: string | null;
  environmentId: string | null;
  serviceId: string | null;
};

export default function AccessPanel({
  slug,
  role,
  environments,
  readmeHtml,
  addingService,
  setAddingService,
  addingAccount,
  setAddingAccount,
  onServicesEmptyChange,
  onAccountsEmptyChange,
  rotationFeatureEnabled,
}: {
  slug: string;
  role: ProjectRole;
  environments: EnvSummary[];
  /** Feature rotation activée au niveau org → affiche la config rotation par item. */
  rotationFeatureEnabled: boolean;
  /** HTML du README (deja rendu/sanitize). Si fourni, on en extrait l'en-tete
   *  (titre + description) pour un encart de presentation en tete d'onglet. */
  readmeHtml?: string | null;
  // Etat « ajout » pilote par InfosPanel : quand une section est vide, son
  // bouton d'ajout est rendu dans la barre d'onglets (parent), pas ici.
  addingService: boolean;
  setAddingService: (v: boolean) => void;
  addingAccount: boolean;
  setAddingAccount: (v: boolean) => void;
  onServicesEmptyChange: (empty: boolean | null) => void;
  onAccountsEmptyChange: (empty: boolean | null) => void;
}) {
  const t = useTranslations("projects");
  const canEdit = ROLE_RANK[role] >= ROLE_RANK.EDITOR;

  const intro = useMemo(() => readmeHeaderHtml(readmeHtml), [readmeHtml]);

  // On n'affiche que les environnements ayant une URL configuree. Ceux
  // sans URL (env "interne", config en cours) ne sont pas pertinents
  // dans l'onglet Acces qui sert a ouvrir les apps deployees.
  const visibleEnvs = environments.filter((e) => Boolean(e.url));

  // Suit l'état vide des 2 sections pour afficher une EmptyCard unique après
  // « Environnements » quand il n'y a NI service NI compte. useCallback pour
  // garder une identité stable (les sections ont onEmptyChange en dép d'effet).
  const [svcEmpty, setSvcEmpty] = useState<boolean | null>(null);
  const [accEmpty, setAccEmpty] = useState<boolean | null>(null);
  const handleSvcEmpty = useCallback(
    (e: boolean | null) => {
      setSvcEmpty(e);
      onServicesEmptyChange(e);
    },
    [onServicesEmptyChange],
  );
  const handleAccEmpty = useCallback(
    (e: boolean | null) => {
      setAccEmpty(e);
      onAccountsEmptyChange(e);
    },
    [onAccountsEmptyChange],
  );
  const bothEmpty =
    svcEmpty === true && accEmpty === true && !addingService && !addingAccount;

  return (
    <div className="flex flex-col gap-8">
      {intro && (
        <article
          className="card docs-prose"
          dangerouslySetInnerHTML={{ __html: intro }}
        />
      )}

      {visibleEnvs.length > 0 && (
        <section>
          <div className="section-header">
            <h2 className="section-title">{t("access.envTitle")}</h2>
          </div>
          <div className="env-grid">
            {visibleEnvs.map((env) => (
              <a
                key={env.id}
                href={env.url ?? "#"}
                target="_blank"
                rel="noreferrer noopener"
                className="card card-link env-card"
              >
                <div className="env-name">{envDisplay(env.name)}</div>
                <div className="env-url">{env.url}</div>
              </a>
            ))}
          </div>
        </section>
      )}

      {bothEmpty && (
        <EmptyCard
          icon={<RiServerLine size={22} aria-hidden />}
          title={t("access.emptyTitle")}
          hint={t("access.emptyHint")}
          action={
            canEdit ? (
              <div
                style={{
                  display: "flex",
                  gap: 8,
                  flexWrap: "wrap",
                  justifyContent: "center",
                }}
              >
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => setAddingService(true)}
                >
                  {t("access.addService")}
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => setAddingAccount(true)}
                >
                  {t("access.addAccount")}
                </button>
              </div>
            ) : undefined
          }
        />
      )}

      <ServicesSection
        slug={slug}
        canEdit={canEdit}
        adding={addingService}
        setAdding={setAddingService}
        onEmptyChange={handleSvcEmpty}
        rotationFeatureEnabled={rotationFeatureEnabled}
      />
      <AccountsSection
        slug={slug}
        canEdit={canEdit}
        adding={addingAccount}
        setAdding={setAddingAccount}
        onEmptyChange={handleAccEmpty}
        rotationFeatureEnabled={rotationFeatureEnabled}
        environments={environments}
      />
    </div>
  );
}

function ServicesSection({
  slug,
  canEdit,
  adding,
  setAdding,
  onEmptyChange,
  rotationFeatureEnabled,
}: {
  slug: string;
  canEdit: boolean;
  adding: boolean;
  setAdding: (v: boolean) => void;
  onEmptyChange: (empty: boolean | null) => void;
  rotationFeatureEnabled: boolean;
}) {
  const t = useTranslations("projects");
  const confirm = useConfirm();
  const [rotationTarget, setRotationTarget] = useState<{ id: string; name: string } | null>(null);
  const [items, setItems] = useState<ServiceListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<
    Record<string, { user: string; password: string }>
  >({});
  const [editId, setEditId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setError(null);
    const res = await fetch(`/api/projects/${slug}/services`);
    if (!res.ok) {
      setError(t("access.loadError"));
      return;
    }
    const data = (await res.json()) as { services: ServiceListItem[] };
    setItems(data.services);
  }, [slug]);

  useEffect(() => {
    reload();
  }, [reload]);

  async function reveal(id: string) {
    if (revealed[id]) {
      setRevealed((r) => {
        const copy = { ...r };
        delete copy[id];
        return copy;
      });
      return;
    }
    const res = await fetch(`/api/projects/${slug}/services/${id}`);
    if (!res.ok) {
      setError(t("access.revealError"));
      return;
    }
    const data = (await res.json()) as {
      service: { user: string; password: string };
    };
    setRevealed((r) => ({
      ...r,
      [id]: { user: data.service.user, password: data.service.password },
    }));
  }

  async function remove(id: string, name: string) {
    if (!(await confirm({ message: t("access.serviceDeleteConfirm", { name }), danger: true }))) return;
    const res = await fetch(`/api/projects/${slug}/services/${id}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      setError(t("access.deleteError"));
      return;
    }
    reload();
  }

  const isEmpty = items !== null && items.length === 0;

  // Remonte l'etat vide au parent : il affiche le bouton d'ajout rapide dans
  // l'en-tete « Environnements » quand la section est vide.
  useEffect(() => {
    onEmptyChange(items === null ? null : items.length === 0);
  }, [items, onEmptyChange]);

  const allTags = useMemo<string[]>(() => {
    if (!items) return [];
    const set = new Set<string>();
    for (const s of items) for (const tag of s.tags) set.add(tag);
    return Array.from(set).sort();
  }, [items]);

  // Section vide sans formulaire ouvert : on n'affiche rien (titre masque,
  // bouton d'ajout remonte dans l'en-tete des environnements).
  if (isEmpty && !adding && !error) return null;

  return (
    <section>
      {!isEmpty && (
        <div className="section-header">
          <div>
            <h2 className="section-title">{t("access.servicesTitle")}</h2>
            <p className="help" style={{ marginTop: 4 }}>
              {t("access.servicesHelp")}
            </p>
          </div>
          {canEdit && !adding && (
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="btn btn-primary btn-sm"
            >
              {t("access.addBtn")}
            </button>
          )}
        </div>
      )}

      {adding && canEdit && (
        <div className="create-card">
          <ServiceForm
            slug={slug}
            allTags={allTags}
            onCancel={() => setAdding(false)}
            onSaved={() => {
              setAdding(false);
              reload();
            }}
          />
        </div>
      )}

      {error && <p className="error-text">{error}</p>}

      {items === null ? (
        <p className="help">{t("access.loading")}</p>
      ) : items.length === 0 ? null : (
        <div className="row-list">
          {items.map((s) =>
            editId === s.id && canEdit ? (
              <div key={s.id} className="card">
                <ServiceForm
                  slug={slug}
                  initialId={s.id}
                  initialName={s.name}
                  initialUrl={s.url}
                  initialTags={s.tags}
                  allTags={allTags}
                  initialHookUrl={s.rotationWebhookUrl}
                  initialExecMode={s.rotationExecMode}
                  initialDbType={s.dbType}
                  initialDbHost={s.dbHost}
                  initialDbPort={s.dbPort}
                  initialDbName={s.dbName}
                  initialDbUser={s.dbUser}
                  onCancel={() => setEditId(null)}
                  onSaved={() => {
                    setEditId(null);
                    setRevealed((r) => {
                      const copy = { ...r };
                      delete copy[s.id];
                      return copy;
                    });
                    reload();
                  }}
                />
              </div>
            ) : (
              <CredentialsRow
                key={s.id}
                name={s.name}
                url={s.url}
                revealed={revealed[s.id]}
                onReveal={() => reveal(s.id)}
                onEdit={canEdit ? () => setEditId(s.id) : null}
                onRemove={canEdit ? () => remove(s.id, s.name) : null}
                onRotation={canEdit && rotationFeatureEnabled ? () => setRotationTarget({ id: s.id, name: s.name }) : null}
              />
            ),
          )}
        </div>
      )}

      {rotationTarget && (
        <CredentialRotationDialog
          slug={slug}
          kind="services"
          id={rotationTarget.id}
          name={rotationTarget.name}
          onClose={() => setRotationTarget(null)}
        />
      )}
    </section>
  );
}

function ServiceForm({
  slug,
  initialId,
  initialName,
  initialUrl,
  initialTags,
  allTags,
  initialHookUrl,
  initialExecMode,
  initialDbType,
  initialDbHost,
  initialDbPort,
  initialDbName,
  initialDbUser,
  onCancel,
  onSaved,
}: {
  slug: string;
  initialId?: string;
  initialName?: string;
  initialUrl?: string | null;
  initialTags?: string[];
  allTags?: string[];
  initialHookUrl?: string | null;
  initialExecMode?: string | null;
  initialDbType?: string | null;
  initialDbHost?: string | null;
  initialDbPort?: number | null;
  initialDbName?: string | null;
  initialDbUser?: string | null;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const t = useTranslations("projects");
  const isEdit = Boolean(initialId);
  const [name, setName] = useState(initialName ?? "");
  const [url, setUrl] = useState(initialUrl ?? "");
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  const [tags, setTags] = useState<string[]>(initialTags ?? []);
  // Hook de rotation des comptes (service backend). URL/execMode pré-remplis ;
  // token laissé vide en édition (= inchangé), comme un mot de passe.
  const [showHook, setShowHook] = useState(Boolean(initialHookUrl));
  const [hookUrl, setHookUrl] = useState(initialHookUrl ?? "");
  const [hookToken, setHookToken] = useState("");
  const [hookExecMode, setHookExecMode] = useState<"AGENT" | "DIRECT">(initialExecMode === "DIRECT" ? "DIRECT" : "AGENT");
  // Cible DB de rotation des comptes (service base de données managée, ex.
  // Supabase). Les identifiants admin = les champs user/password ci-dessus.
  const [showDb, setShowDb] = useState(Boolean(initialDbType));
  const [dbType, setDbType] = useState(initialDbType ?? "POSTGRESQL");
  const [dbHost, setDbHost] = useState(initialDbHost ?? "");
  const [dbPort, setDbPort] = useState(initialDbPort != null ? String(initialDbPort) : "5432");
  const [dbName, setDbName] = useState(initialDbName ?? "");
  // Identifiants admin DB DÉDIÉS (distincts des creds dashboard ci-dessus).
  // Mot de passe laissé vide en édition (= inchangé).
  const [dbUser, setDbUser] = useState(initialDbUser ?? "");
  const [dbPassword, setDbPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const body: Record<string, unknown> = { name, tags };
      if (url.trim()) body.url = url.trim();
      if (!isEdit || user) body.user = user;
      if (!isEdit || password) body.password = password;
      // Hook : URL/execMode toujours envoyés (null si désactivé) ; token seulement
      // si saisi (en édition, vide = on conserve l'existant).
      body.rotationWebhookUrl = showHook ? (hookUrl.trim() || null) : null;
      body.rotationExecMode = showHook ? hookExecMode : null;
      if (hookToken.trim()) body.rotationHookToken = hookToken.trim();
      else if (!showHook) body.rotationHookToken = null;
      // Cible DB : toujours envoyée (null si désactivée).
      body.dbType = showDb ? dbType : null;
      body.dbHost = showDb ? (dbHost.trim() || null) : null;
      body.dbName = showDb ? (dbName.trim() || null) : null;
      body.dbPort = showDb && dbPort.trim() ? Number(dbPort) : null;
      body.dbUser = showDb ? (dbUser.trim() || null) : null;
      if (showDb && dbPassword.trim()) body.dbPassword = dbPassword.trim();

      const res = await fetch(
        isEdit
          ? `/api/projects/${slug}/services/${initialId}`
          : `/api/projects/${slug}/services`,
        {
          method: isEdit ? "PATCH" : "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        setError(data?.error ?? t("access.saveError"));
        return;
      }
      onSaved();
    });
  }

  return (
    <form onSubmit={submit}>
      <div className="form-row">
        <div className="field">
          <label>{t("access.nameLabel")}</label>
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="ex: Stripe"
            className="input"
          />
        </div>
        <div className="field">
          <label>{t("access.urlLabel")}</label>
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://dashboard.stripe.com (optionnel)"
            className="input input-mono"
          />
        </div>
      </div>
      <div className="form-row" style={{ marginTop: 8 }}>
        <div className="field">
          <label>{t("access.userLabel")}</label>
          <input
            value={user}
            onChange={(e) => setUser(e.target.value)}
            placeholder={
              isEdit ? t("access.leaveBlankHint") : t("access.optionalHint")
            }
            autoComplete="off"
            className="input input-mono"
          />
        </div>
        <div className="field">
          <label>{t("access.passwordLabel")}</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={
              isEdit ? t("access.leaveBlankHint") : t("access.optionalHint")
            }
            autoComplete="new-password"
            className="input input-mono"
          />
        </div>
      </div>
      <div className="field" style={{ marginTop: 8 }}>
        <label>
          {t("access.tagsLabel")}{" "}
          <span className="text-muted" style={{ fontSize: 11 }}>
            {t("access.tagsHint")}
          </span>
        </label>
        <TagsInput value={tags} onChange={setTags} suggestions={allTags ?? []} />
      </div>

      {/* Hook de rotation des comptes (service backend) — optionnel. */}
      <div className="field" style={{ marginTop: 8 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", userSelect: "none" }}>
          <input type="checkbox" checked={showHook} onChange={(e) => setShowHook(e.target.checked)} disabled={pending} />
          <span>{t("access.serviceHookLabel")}</span>
        </label>
        <p className="help" style={{ fontSize: 11, marginTop: 2 }}>{t("access.serviceHookHint")}</p>
      </div>
      {showHook && (
        <div className="form-row">
          <div className="field" style={{ flex: 2 }}>
            <label>{t("access.webhookUrlLabel")}</label>
            <input value={hookUrl} onChange={(e) => setHookUrl(e.target.value)} placeholder="http://app:3000/internal/rotate" className="input input-mono" disabled={pending} autoComplete="off" name="svc-hook-url" />
          </div>
          <div className="field" style={{ flex: 2 }}>
            <label>{t("access.hookTokenLabel")}</label>
            <div style={{ display: "flex", gap: 6 }}>
              <input value={hookToken} onChange={(e) => setHookToken(e.target.value)} type="password" autoComplete="new-password" name="svc-hook-token" placeholder={isEdit ? t("access.leaveBlankHint") : t("access.hookTokenPlaceholder")} className="input input-mono" disabled={pending} style={{ flex: 1 }} />
              <button type="button" onClick={() => setHookToken(generatePassword(24))} className="btn btn-ghost btn-xs" disabled={pending}>{t("access.generateBtn")}</button>
            </div>
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label>{t("access.hookExecLabel")}</label>
            <select value={hookExecMode} onChange={(e) => setHookExecMode(e.target.value as "AGENT" | "DIRECT")} className="select" disabled={pending}>
              <option value="AGENT">{t("access.hookExecAgent")}</option>
              <option value="DIRECT">{t("access.hookExecDirect")}</option>
            </select>
          </div>
        </div>
      )}

      {/* Cible DB de rotation des comptes (service base de données managée). */}
      <div className="field" style={{ marginTop: 8 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", userSelect: "none" }}>
          <input type="checkbox" checked={showDb} onChange={(e) => setShowDb(e.target.checked)} disabled={pending} />
          <span>{t("access.serviceDbLabel")}</span>
        </label>
        <p className="help" style={{ fontSize: 11, marginTop: 2 }}>{t("access.serviceDbHint")}</p>
      </div>
      {showDb && (
        <div className="form-row">
          <div className="field" style={{ flex: 1 }}>
            <label>{t("access.dbTypeLabel")}</label>
            <select value={dbType} onChange={(e) => setDbType(e.target.value)} className="select" disabled={pending}>
              <option value="POSTGRESQL">PostgreSQL</option>
            </select>
          </div>
          <div className="field" style={{ flex: 2 }}>
            <label>{t("access.dbHostLabel")}</label>
            <input value={dbHost} onChange={(e) => setDbHost(e.target.value)} placeholder="db.xxxx.supabase.co" className="input input-mono" disabled={pending} autoComplete="off" name="svc-db-host" />
          </div>
          <div className="field" style={{ flex: "0 0 90px" }}>
            <label>{t("access.dbPortLabel")}</label>
            <input value={dbPort} onChange={(e) => setDbPort(e.target.value)} placeholder="5432" className="input input-mono" disabled={pending} inputMode="numeric" />
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label>{t("access.dbNameLabel")}</label>
            <input value={dbName} onChange={(e) => setDbName(e.target.value)} placeholder="postgres" className="input input-mono" disabled={pending} autoComplete="off" name="svc-db-name" />
          </div>
        </div>
      )}
      {showDb && (
        <>
          <p className="help" style={{ fontSize: 11, marginTop: 2 }}>{t("access.dbCredsHint")}</p>
          <div className="form-row">
            <div className="field" style={{ flex: 1 }}>
              <label>{t("access.dbUserLabel")}</label>
              <input value={dbUser} onChange={(e) => setDbUser(e.target.value)} placeholder="postgres.<ref>" className="input input-mono" disabled={pending} autoComplete="off" name="svc-db-user" />
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label>{t("access.dbPasswordLabel")}</label>
              <input value={dbPassword} onChange={(e) => setDbPassword(e.target.value)} type="password" autoComplete="new-password" name="svc-db-pw" placeholder={isEdit ? t("access.leaveBlankHint") : ""} className="input input-mono" disabled={pending} />
            </div>
          </div>
        </>
      )}

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
          {pending ? "..." : isEdit ? t("access.updateBtn") : t("access.createBtn")}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="btn btn-ghost btn-sm"
        >
          {t("access.cancelBtn")}
        </button>
      </div>
    </form>
  );
}

function AccountsSection({
  slug,
  canEdit,
  adding,
  setAdding,
  onEmptyChange,
  rotationFeatureEnabled,
  environments,
}: {
  slug: string;
  canEdit: boolean;
  adding: boolean;
  setAdding: (v: boolean) => void;
  onEmptyChange: (empty: boolean | null) => void;
  rotationFeatureEnabled: boolean;
  environments: EnvSummary[];
}) {
  const t = useTranslations("projects");
  const confirm = useConfirm();
  const [rotationTarget, setRotationTarget] = useState<{ id: string; name: string } | null>(null);
  const [items, setItems] = useState<AccountListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<
    Record<string, { user: string; password: string }>
  >({});
  const [editId, setEditId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setError(null);
    const res = await fetch(`/api/projects/${slug}/accounts`);
    if (!res.ok) {
      setError(t("access.loadError"));
      return;
    }
    const data = (await res.json()) as { accounts: AccountListItem[] };
    setItems(data.accounts);
  }, [slug]);

  useEffect(() => {
    reload();
  }, [reload]);

  async function reveal(id: string) {
    if (revealed[id]) {
      setRevealed((r) => {
        const copy = { ...r };
        delete copy[id];
        return copy;
      });
      return;
    }
    const res = await fetch(`/api/projects/${slug}/accounts/${id}`);
    if (!res.ok) {
      setError(t("access.revealError"));
      return;
    }
    const data = (await res.json()) as {
      account: { user: string; password: string };
    };
    setRevealed((r) => ({
      ...r,
      [id]: { user: data.account.user, password: data.account.password },
    }));
  }

  async function remove(id: string, name: string) {
    if (!(await confirm({ message: t("access.accountDeleteConfirm", { name }), danger: true }))) return;
    const res = await fetch(`/api/projects/${slug}/accounts/${id}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      setError(t("access.deleteError"));
      return;
    }
    reload();
  }

  const isEmpty = items !== null && items.length === 0;

  // Remonte l'etat vide au parent : il affiche le bouton d'ajout rapide dans
  // l'en-tete « Environnements » quand la section est vide.
  useEffect(() => {
    onEmptyChange(items === null ? null : items.length === 0);
  }, [items, onEmptyChange]);

  const allTags = useMemo<string[]>(() => {
    if (!items) return [];
    const set = new Set<string>();
    for (const a of items) for (const tag of a.tags) set.add(tag);
    return Array.from(set).sort();
  }, [items]);

  // Section vide sans formulaire ouvert : on n'affiche rien (titre masque,
  // bouton d'ajout remonte dans l'en-tete des environnements).
  if (isEmpty && !adding && !error) return null;

  return (
    <section>
      {!isEmpty && (
        <div className="section-header">
          <div>
            <h2 className="section-title">{t("access.accountsTitle")}</h2>
            <p className="help" style={{ marginTop: 4 }}>
              {t("access.accountsHelp")}
            </p>
          </div>
          {canEdit && !adding && (
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="btn btn-primary btn-sm"
            >
              {t("access.addBtn")}
            </button>
          )}
        </div>
      )}

      {adding && canEdit && (
        <div className="create-card">
          <AccountForm
            slug={slug}
            allTags={allTags}
            environments={environments}
            onCancel={() => setAdding(false)}
            onSaved={() => {
              setAdding(false);
              reload();
            }}
          />
        </div>
      )}

      {error && <p className="error-text">{error}</p>}

      {items === null ? (
        <p className="help">{t("access.loading")}</p>
      ) : items.length === 0 ? null : (
        <div className="row-list">
          {items.map((a) =>
            editId === a.id && canEdit ? (
              <div key={a.id} className="card">
                <AccountForm
                  slug={slug}
                  initialId={a.id}
                  initialTags={a.tags}
                  allTags={allTags}
                  initialName={a.name}
                  environments={environments}
                  initialEnvironmentId={a.environmentId}
                  initialServiceId={a.serviceId}
                  onCancel={() => setEditId(null)}
                  onSaved={() => {
                    setEditId(null);
                    setRevealed((r) => {
                      const copy = { ...r };
                      delete copy[a.id];
                      return copy;
                    });
                    reload();
                  }}
                />
              </div>
            ) : (
              <CredentialsRow
                key={a.id}
                name={a.name}
                url={a.url}
                revealed={revealed[a.id]}
                onReveal={() => reveal(a.id)}
                onEdit={canEdit ? () => setEditId(a.id) : null}
                onRemove={canEdit ? () => remove(a.id, a.name) : null}
                onRotation={canEdit && rotationFeatureEnabled ? () => setRotationTarget({ id: a.id, name: a.name }) : null}
              />
            ),
          )}
        </div>
      )}

      {rotationTarget && (
        <CredentialRotationDialog
          slug={slug}
          kind="accounts"
          id={rotationTarget.id}
          name={rotationTarget.name}
          onClose={() => setRotationTarget(null)}
        />
      )}
    </section>
  );
}

function AccountForm({
  slug,
  initialId,
  initialName,
  initialTags,
  allTags,
  environments,
  initialEnvironmentId,
  initialServiceId,
  onCancel,
  onSaved,
}: {
  slug: string;
  initialId?: string;
  initialName?: string;
  initialTags?: string[];
  allTags?: string[];
  environments: EnvSummary[];
  initialEnvironmentId?: string | null;
  initialServiceId?: string | null;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const t = useTranslations("projects");
  const isEdit = Boolean(initialId);
  const [name, setName] = useState(initialName ?? "");
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  const [tags, setTags] = useState<string[]>(initialTags ?? []);
  // Lien URL : "none" | "environment" | "service" + l'id de la cible.
  const [linkType, setLinkType] = useState<"none" | "environment" | "service">(
    initialEnvironmentId ? "environment" : initialServiceId ? "service" : "none",
  );
  const [linkId, setLinkId] = useState<string>(initialEnvironmentId ?? initialServiceId ?? "");
  const [services, setServices] = useState<{ id: string; name: string; url: string | null }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    fetch(`/api/projects/${slug}/services`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d: { services: { id: string; name: string; url: string | null }[] }) => setServices(d.services ?? []))
      .catch(() => null);
  }, [slug]);

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const body: Record<string, unknown> = { name, tags };
      if (!isEdit || user) body.user = user;
      if (!isEdit || password) body.password = password;
      // Lien (toujours envoyé : permet de modifier/retirer en édition).
      body.environmentId = linkType === "environment" ? (linkId || null) : null;
      body.serviceId = linkType === "service" ? (linkId || null) : null;

      const res = await fetch(
        isEdit
          ? `/api/projects/${slug}/accounts/${initialId}`
          : `/api/projects/${slug}/accounts`,
        {
          method: isEdit ? "PATCH" : "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        setError(data?.error ?? t("access.saveError"));
        return;
      }
      onSaved();
    });
  }

  return (
    <form onSubmit={submit}>
      <div className="form-row">
        <div className="field">
          <label>{t("access.nameLabel")}</label>
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="ex: Admin demo"
            className="input"
          />
        </div>
        <div className="field">
          <label>{t("access.userLabel")}</label>
          <input
            required={!isEdit}
            value={user}
            onChange={(e) => setUser(e.target.value)}
            placeholder={
              isEdit ? t("access.leaveBlankHint") : t("access.userLabel")
            }
            autoComplete="off"
            className="input input-mono"
          />
        </div>
        <div className="field">
          <label>{t("access.passwordLabel")}</label>
          <input
            required={!isEdit}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={
              isEdit ? t("access.leaveBlankHint") : t("access.passwordLabel")
            }
            autoComplete="new-password"
            className="input input-mono"
          />
        </div>
      </div>
      <div className="form-row" style={{ marginTop: 8 }}>
        <div className="field">
          <label>{t("access.linkLabel")}</label>
          <select
            value={linkType}
            onChange={(e) => {
              setLinkType(e.target.value as "none" | "environment" | "service");
              setLinkId("");
            }}
            className="select"
          >
            <option value="none">{t("access.linkNone")}</option>
            <option value="environment">{t("access.linkEnvironment")}</option>
            <option value="service">{t("access.linkService")}</option>
          </select>
        </div>
        {linkType !== "none" && (
          <div className="field">
            <label>{linkType === "environment" ? t("access.linkEnvironment") : t("access.linkService")}</label>
            <select value={linkId} onChange={(e) => setLinkId(e.target.value)} className="select" required>
              <option value="">{t("access.linkSelectPlaceholder")}</option>
              {(linkType === "environment" ? environments : services).map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}{o.url ? ` — ${o.url}` : ""}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
      <div className="field" style={{ marginTop: 8 }}>
        <label>
          {t("access.tagsLabel")}{" "}
          <span className="text-muted" style={{ fontSize: 11 }}>
            {t("access.tagsHint")}
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
          {pending ? "..." : isEdit ? t("access.updateBtn") : t("access.createBtn")}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="btn btn-ghost btn-sm"
        >
          {t("access.cancelBtn")}
        </button>
      </div>
    </form>
  );
}

function CredentialsRow({
  name,
  url,
  revealed,
  onReveal,
  onEdit,
  onRemove,
  onRotation,
}: {
  name: string;
  url: string | null;
  revealed?: { user: string; password: string };
  onReveal: () => void;
  onEdit: (() => void) | null;
  onRemove: (() => void) | null;
  onRotation?: (() => void) | null;
}) {
  const t = useTranslations("projects");
  return (
    <div className="row">
      <div className="row-icon">{initials(name)}</div>
      <div className="row-info">
        <div className="row-name">{name}</div>
        <div className="row-meta">
          {url && (
            <a href={url} target="_blank" rel="noreferrer noopener">
              {url}
            </a>
          )}
          <span className="code-mono">
            <span className="text-muted">user:</span>{" "}
            {revealed ? revealed.user || t("access.empty") : "••••••••"}
          </span>
          <span className="code-mono">
            <span className="text-muted">pass:</span>{" "}
            {revealed ? revealed.password || t("access.empty") : "••••••••"}
          </span>
        </div>
      </div>
      <div className="row-actions">
        <button
          type="button"
          onClick={onReveal}
          className="btn btn-ghost btn-xs"
        >
          {revealed ? t("access.hideBtn") : t("access.revealBtn")}
        </button>
        {onEdit && (
          <button
            type="button"
            onClick={onEdit}
            className="btn btn-ghost btn-xs"
          >
            {t("access.editBtn")}
          </button>
        )}
        {onRotation && (
          <button
            type="button"
            onClick={onRotation}
            className="btn btn-ghost btn-xs"
          >
            {t("access.rotationBtn")}
          </button>
        )}
        {onRemove && (
          <button
            type="button"
            onClick={onRemove}
            className="btn btn-danger btn-xs"
          >
            {t("access.deleteBtn")}
          </button>
        )}
      </div>
    </div>
  );
}

// Modale rotation d'un service / compte (stratégie implicite REMINDER) :
// config du rappel (activer + intervalle) + section « Rotation immédiate »
// (générer/saisir le mdp → ré-encrypt {user inchangé, mdp}) dans la même modale.
function CredentialRotationDialog({
  slug,
  kind,
  id,
  name,
  onClose,
}: {
  slug: string;
  kind: "services" | "accounts";
  id: string;
  name: string;
  onClose: () => void;
}) {
  const t = useTranslations("projects");
  const confirm = useConfirm();
  // La stratégie WEBHOOK (hook côté app) n'est proposée que pour les Comptes.
  const supportsWebhook = kind === "accounts";
  const [loaded, setLoaded] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [intervalDays, setIntervalDays] = useState("30");
  const [strategy, setStrategy] = useState<"REMINDER" | "WEBHOOK" | "DATABASE">("REMINDER");
  // Le hook ET la cible DB vivent sur le service backend lié : on sait juste si
  // ce service en a un.
  const [serviceHasHook, setServiceHasHook] = useState(false);
  const [serviceHasDb, setServiceHasDb] = useState(false);
  // DATABASE : cible "role" (rôle Postgres) ou "supabase_auth" (auth.users).
  const [dbTarget, setDbTarget] = useState<"role" | "supabase_auth">("role");
  // Vrai si la config SAUVEGARDÉE est automatique (WEBHOOK/DATABASE) + activée →
  // autorise « Forcer ».
  const [savedAuto, setSavedAuto] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const isWebhook = supportsWebhook && strategy === "WEBHOOK";
  const isDatabase = supportsWebhook && strategy === "DATABASE";
  // Stratégies automatiques (pas de rotation immédiate assistée ; bouton Forcer).
  const isAuto = isWebhook || isDatabase;

  useEffect(() => {
    fetch(`/api/projects/${slug}/${kind}/${id}/rotation`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d: { rotation: {
        rotationEnabled: boolean; rotationIntervalDays: number | null;
        rotationStrategy?: string | null; rotationDbTarget?: string | null;
        serviceHasHook?: boolean; serviceHasDb?: boolean;
      } }) => {
        setEnabled(d.rotation.rotationEnabled);
        if (d.rotation.rotationIntervalDays) setIntervalDays(String(d.rotation.rotationIntervalDays));
        const strat = d.rotation.rotationStrategy;
        if (strat === "WEBHOOK") setStrategy("WEBHOOK");
        else if (strat === "DATABASE") setStrategy("DATABASE");
        if (d.rotation.rotationDbTarget === "supabase_auth") setDbTarget("supabase_auth");
        setServiceHasHook(Boolean(d.rotation.serviceHasHook));
        setServiceHasDb(Boolean(d.rotation.serviceHasDb));
        setSavedAuto((strat === "WEBHOOK" || strat === "DATABASE") && d.rotation.rotationEnabled);
      })
      .catch(() => null)
      .finally(() => setLoaded(true));
  }, [slug, kind, id]);

  function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    if (enabled && isWebhook && !serviceHasHook) {
      setError(t("access.webhookNeedsServiceHook"));
      return;
    }
    if (enabled && isDatabase && !serviceHasDb) {
      setError(t("access.dbNeedsServiceDb"));
      return;
    }
    startTransition(async () => {
      const res = await fetch(`/api/projects/${slug}/${kind}/${id}/rotation`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          rotationEnabled: enabled,
          rotationIntervalDays: enabled && intervalDays ? Number(intervalDays) : null,
          ...(supportsWebhook ? { rotationStrategy: strategy } : {}),
          ...(isDatabase ? { rotationDbTarget: dbTarget } : {}),
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? t("access.saveError"));
        return;
      }
      onClose();
    });
  }

  // Forcer la rotation WEBHOOK maintenant (DIRECT = hook exécuté tout de suite ;
  // AGENT = rendu dû). Basé sur la config SAUVEGARDÉE (savedWebhook).
  async function forceNow() {
    setError(null);
    if (!(await confirm({ message: t("access.forceConfirm") }))) return;
    startTransition(async () => {
      const res = await fetch(`/api/projects/${slug}/${kind}/${id}/rotation/force`, { method: "POST" });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? t("access.saveError"));
        return;
      }
      onClose();
    });
  }

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-header">
          <h2 className="dialog-title">{t("access.rotationTitle", { name })}</h2>
          <button type="button" onClick={onClose} className="dialog-close" aria-label={t("access.cancelBtn")}>✕</button>
        </div>
        <div className="dialog-body">
          {!loaded ? (
            <p className="help">{t("access.loading")}</p>
          ) : (
            <form onSubmit={save} className="flex flex-col gap-4">
              <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} disabled={pending} />
                <span>{t("access.rotationEnable")}</span>
              </label>
              {enabled && (
                <div className="field">
                  <label>{t("access.rotationInterval")}</label>
                  <input type="number" value={intervalDays} onChange={(e) => setIntervalDays(e.target.value)} min={1} max={3650} className="input" style={{ maxWidth: 120 }} disabled={pending} />
                </div>
              )}

              {enabled && supportsWebhook && (
                <div className="field">
                  <label>{t("access.rotationStrategyLabel")}</label>
                  <select value={strategy} onChange={(e) => setStrategy(e.target.value as "REMINDER" | "WEBHOOK" | "DATABASE")} className="select" disabled={pending}>
                    <option value="REMINDER">{t("access.strategyReminder")}</option>
                    <option value="WEBHOOK">{t("access.strategyWebhook")}</option>
                    <option value="DATABASE">{t("access.strategyDatabase")}</option>
                  </select>
                </div>
              )}

              {enabled && isWebhook && (
                <div
                  style={{
                    background: serviceHasHook ? "rgba(34,197,94,0.08)" : "rgba(234,179,8,0.08)",
                    border: `1px solid ${serviceHasHook ? "rgba(34,197,94,0.3)" : "rgba(234,179,8,0.3)"}`,
                    borderRadius: 6,
                    padding: "8px 12px",
                    fontSize: 12,
                    lineHeight: 1.6,
                  }}
                >
                  {serviceHasHook ? t("access.webhookServiceOk") : t("access.webhookNeedsServiceHook")}
                </div>
              )}

              {enabled && isDatabase && (
                <div className="field">
                  <label>{t("access.dbTargetLabel")}</label>
                  <select value={dbTarget} onChange={(e) => setDbTarget(e.target.value as "role" | "supabase_auth")} className="select" disabled={pending}>
                    <option value="role">{t("access.dbTargetRole")}</option>
                    <option value="supabase_auth">{t("access.dbTargetAuth")}</option>
                  </select>
                  <p className="help" style={{ fontSize: 11, marginTop: 4 }}>
                    {dbTarget === "supabase_auth" ? t("access.dbTargetAuthHint") : t("access.dbTargetRoleHint")}
                  </p>
                </div>
              )}

              {enabled && isDatabase && (
                <div
                  style={{
                    background: serviceHasDb ? "rgba(34,197,94,0.08)" : "rgba(234,179,8,0.08)",
                    border: `1px solid ${serviceHasDb ? "rgba(34,197,94,0.3)" : "rgba(234,179,8,0.3)"}`,
                    borderRadius: 6,
                    padding: "8px 12px",
                    fontSize: 12,
                    lineHeight: 1.6,
                  }}
                >
                  {serviceHasDb ? t("access.dbServiceOk") : t("access.dbNeedsServiceDb")}
                </div>
              )}

              {!isAuto && <p className="help" style={{ fontSize: 12 }}>{t("access.rotationHelp")}</p>}
              {error && <p className="error-text">{error}</p>}
              {/* Rotation immédiate (assistée) seulement en REMINDER ; en WEBHOOK/
                  DATABASE la rotation est automatique (cron / agent / ALTER DB). */}
              {!isAuto && (
                <ImmediateRotationSection endpoint={`/api/projects/${slug}/${kind}/${id}/rotation`} payloadKey="newPassword" />
              )}
              {savedAuto && (
                <div className="field" style={{ borderTop: "1px solid var(--border, rgba(0,0,0,0.1))", paddingTop: 12, marginTop: 4 }}>
                  <label>{t("access.forceHeading")}</label>
                  <p className="help" style={{ fontSize: 11, marginTop: 0, marginBottom: 6 }}>{t("access.forceHint")}</p>
                  <button type="button" onClick={forceNow} disabled={pending} className="btn btn-secondary btn-sm">
                    {t("access.forceBtn")}
                  </button>
                </div>
              )}
              <div className="flex items-center gap-2">
                <button type="submit" disabled={pending} className="btn btn-primary btn-sm">
                  {pending ? t("access.rotationSavingBtn") : t("access.rotationSaveBtn")}
                </button>
                <button type="button" onClick={onClose} className="btn btn-ghost btn-sm" disabled={pending}>
                  {t("access.cancelBtn")}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
