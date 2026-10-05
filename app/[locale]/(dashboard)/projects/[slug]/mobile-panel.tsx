"use client";

// Chantier "Déploiement mobile" — Phase 1 (socle credentials).
// Cf. documentation/plans/deploiement-mobile.md.
//
// i18n fr/en/es sous `projects.mobile` (messages/*.json), libellés des types de
// credential compris — `kindLabel()` retombe sur la clé brute plutôt que de
// laisser next-intl crier si l'API sert un `kind` que l'interface ne connaît
// pas encore.
//
// Habillage : classes maison de app/globals.css (`.section-header`, `.card`,
// `.create-card`, `.field` + `<label>`, `.input`/`.select`, `.table`,
// `.badge`, `.help`). Les `<input>`/`<select>` SANS `className` retombent sur
// le style natif du navigateur — c'est ce qui donnait des champs bruts au
// milieu d'une interface stylée.

import { useCallback, useEffect, useState, useTransition } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { ProjectRole } from "@prisma/client";
import {
  RiSmartphoneLine,
  RiDeleteBinLine,
  RiPencilLine,
  RiAndroidFill,
  RiAppleFill,
  RiPauseCircleLine,
  RiPlayCircleLine,
  RiCheckboxCircleLine,
  RiErrorWarningLine,
  RiCloseCircleLine,
  RiIndeterminateCircleLine,
  RiStethoscopeLine,
  RiKey2Line,
} from "@remixicon/react";
import { useConfirm } from "@/components/ConfirmDialog";
import EmptyCard from "@/components/EmptyCard";
import {
  MOBILE_CREDENTIAL_KINDS,
  MOBILE_EXPIRY_KINDS,
  MOBILE_FILE_KINDS,
} from "@/lib/mobile-credentials";
// ⚠️ `import type` UNIQUEMENT : lib/mobile-verify.ts tire openssl
// (node:child_process) et du fetch sortant, et CE fichier est un composant
// client. Un import de VALEUR ferait entrer node:child_process dans le bundle
// navigateur — `tsc` et `eslint` resteraient verts et `next build` casserait,
// exactement comme en Phase 1 avec lib/mobile-credentials.ts.
import type { MobileCheck, MobileVerifyReport } from "@/lib/mobile-verify";

const ROLE_RANK: Record<ProjectRole, number> = { VIEWER: 1, EDITOR: 2, OWNER: 3 };

type Translator = ReturnType<typeof useTranslations<"projects.mobile">>;

/** Libellé traduit d'un type de credential, clé brute en repli. */
function kindLabel(t: Translator, kind: string): string {
  return KNOWN_KINDS.has(kind) ? t(`kinds.${kind}` as never) : kind;
}

/** Pastille de plateforme : le logo sur un fond teinté de la marque, plutôt
 *  que le mot « android »/« ios » — reconnaissable d'un coup d'œil dans une
 *  liste où le nom de l'app porte déjà le texte. Teintes douces plutôt que
 *  les couleurs de marque saturées : la carte reste calme et l'icône garde
 *  son contraste (le vert Android pur ne passe pas en fond d'icône blanche). */
const PLATFORM_BADGE: Record<
  "android" | "ios",
  { label: string; bg: string; fg: string; Icon: typeof RiAndroidFill }
> = {
  android: { label: "Android", bg: "#e6f6ec", fg: "#1b7a44", Icon: RiAndroidFill },
  ios: { label: "iOS", bg: "#ececef", fg: "#1d1d1f", Icon: RiAppleFill },
};

function PlatformBadge({ platform }: { platform: "android" | "ios" }) {
  const { label, bg, fg, Icon } = PLATFORM_BADGE[platform];
  return (
    <span
      title={label}
      aria-label={label}
      role="img"
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 36,
        height: 36,
        borderRadius: 999,
        background: bg,
        color: fg,
        flexShrink: 0,
      }}
    >
      <Icon size={20} aria-hidden />
    </span>
  );
}

/** Les `kind` connus de l'interface — hors de cette liste, on affiche la clé
 *  brute plutôt qu'un message d'erreur de traduction. */
const KNOWN_KINDS = new Set<string>(MOBILE_CREDENTIAL_KINDS);

/** Extension proposée dans le sélecteur de fichier, par kind. Purement
 *  ergonomique : le serveur n'accorde aucune confiance à l'extension. */
const KIND_ACCEPT: Record<string, string> = {
  android_keystore: ".jks,.keystore,.p12",
  play_service_account: ".json,application/json",
  ios_p12: ".p12",
  ios_profile: ".mobileprovision",
  asc_api_key: ".p8",
};

/** Kinds pour lesquels une passphrase de déchiffrement a un sens (sert
 *  uniquement à l'extraction d'`expiresAt`, jamais persistée telle quelle). */
const PASSPHRASE_KINDS = new Set(["ios_p12", "android_keystore"]);

type MobileApp = {
  id: string;
  platform: "android" | "ios";
  bundleId: string;
  displayName: string;
  vendorTeamId: string | null;
  group: string | null;
  versionName: string | null;
  buildNumber: number;
  deployPaused: boolean;
  /** Échéance la plus proche du matériel de cette app (Phase 4) — sert la
   *  bannière de surveillance. `null` = aucun matériel daté. */
  expiresAt?: string | null;
  _count?: { credentials: number };
};

type MobileCredential = {
  id: string;
  kind: string;
  filename: string | null;
  sizeBytes: number;
  sha256: string;
  expiresAt: string | null;
  expiryAlertedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

function fmtDate(iso: string | null, locale: string): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function fmtSize(bytes: number, locale: string): string {
  const n = bytes < 1024 ? bytes : bytes / 1024;
  const unit = bytes < 1024 ? "B" : "kB";
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(n)} ${unit}`;
}

function isExpiringSoon(iso: string | null): boolean {
  if (!iso) return false;
  const days = (new Date(iso).getTime() - Date.now()) / 86_400_000;
  return days < 60;
}

/** base64 d'une valeur texte. `btoa` lève `InvalidCharacterError` sur tout
 *  caractère hors Latin-1 : un mot de passe de keystore accentué suffisait à
 *  faire échouer l'import en silence (rejet dans la transition, aucun message
 *  affiché). On encode donc les octets UTF-8, comme le fait `FileReader`. */
function textToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const result = reader.result as string;
      // data:<mime>;base64,<...> → ne garder que la partie base64.
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.readAsDataURL(file);
  });
}

export default function MobilePanel({
  slug,
  role,
}: {
  slug: string;
  role: ProjectRole;
}) {
  const t = useTranslations("projects.mobile");
  const locale = useLocale();
  const confirm = useConfirm();
  const canEdit = ROLE_RANK[role] >= ROLE_RANK.EDITOR;
  const [apps, setApps] = useState<MobileApp[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showNewApp, setShowNewApp] = useState(false);
  const [pending, startTransition] = useTransition();

  const load = useCallback(() => {
    fetch(`/api/projects/${slug}/mobile/apps`)
      .then((res) => {
        if (!res.ok) throw new Error("load_failed");
        return res.json();
      })
      .then((data) => setApps(data.apps ?? []))
      .catch(() => setError(t("loadError")));
  }, [slug, t]);

  useEffect(() => {
    load();
  }, [load]);

  // ⚠️ `confirm()` est attendu HORS de `startTransition`. Dedans, la modale ne
  // s'ouvre jamais : le rendu qui l'affiche est planifié à l'intérieur d'une
  // transition qui reste « pending » tant que le callback asynchrone n'a pas
  // résolu — or il attend précisément un clic dans cette modale. Blocage
  // circulaire, sans erreur en console. C'est l'idiome du reste de l'app
  // (cf. secrets-panel : `if (!(await confirm(…))) return;` puis l'action).
  async function handleDeleteApp(app: MobileApp) {
    const ok = await confirm({
      message: t("deleteAppConfirm", {
        name: app.displayName,
        platform: app.platform,
      }),
      danger: true,
    });
    if (!ok) return;
    startTransition(async () => {
      const res = await fetch(`/api/projects/${slug}/mobile/apps/${app.id}`, {
        method: "DELETE",
      });
      if (res.ok) load();
    });
  }

  async function handleTogglePause(app: MobileApp) {
    // Reprise : sans confirmation. Mise en pause : on confirme, c'est un gel
    // qui fera échouer les runs CI tant qu'il tient.
    if (!app.deployPaused) {
      const ok = await confirm({
        message: t("pauseConfirm", { name: app.displayName }),
      });
      if (!ok) return;
    }
    startTransition(async () => {
      const res = await fetch(`/api/projects/${slug}/mobile/apps/${app.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deployPaused: !app.deployPaused }),
      });
      if (res.ok) load();
    });
  }

  if (error) return <div className="error-text">{error}</div>;
  if (apps === null) return <p className="help">{t("loading")}</p>;

  return (
    <div className="flex flex-col gap-4">
      <div className="section-header">
        <div>
          <h2 className="section-title">{t("title")}</h2>
          <p className="panel-subtitle">{t("intro")}</p>
        </div>
        {canEdit && apps.length > 0 && !showNewApp && (
          <button
            type="button"
            className="btn btn-accent btn-sm"
            onClick={() => setShowNewApp(true)}
          >
            {t("newApp")}
          </button>
        )}
      </div>

      <ExpiryBanner apps={apps} t={t} locale={locale} />

      {showNewApp && (
        <AppForm
          slug={slug}
          onCancel={() => setShowNewApp(false)}
          onSaved={() => {
            setShowNewApp(false);
            load();
          }}
        />
      )}

      {apps.length === 0 && !showNewApp ? (
        <EmptyCard
          icon={<RiSmartphoneLine size={28} aria-hidden />}
          title={t("emptyTitle")}
          hint={t("emptyHint")}
          action={
            canEdit && (
              <button
                type="button"
                className="btn btn-accent"
                onClick={() => setShowNewApp(true)}
              >
                {t("newApp")}
              </button>
            )
          }
        />
      ) : (
        <div
          className="flex flex-col gap-3"
          style={{
            padding: 12,
            borderRadius: 10,
            border: "1px solid var(--accent-soft)",
            background: "var(--accent-bg)",
          }}
        >
          {apps.map((app) => {
            const open = expandedId === app.id;
            return (
              <div key={app.id} className="card" style={{ padding: 16 }}>
                <div className="row-no-icon">
                  <button
                    type="button"
                    aria-expanded={open}
                    onClick={() => setExpandedId(open ? null : app.id)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      flex: 1,
                      minWidth: 0,
                      background: "none",
                      border: "none",
                      padding: 0,
                      font: "inherit",
                      color: "inherit",
                      cursor: "pointer",
                      textAlign: "left",
                    }}
                  >
                    <PlatformBadge platform={app.platform} />
                    {/* `.row-*` sont pensées pour des blocs (ellipsis) ; on
                        garde des <span> — le contenu d'un <button> doit rester
                        du phrasing content — d'où le display explicite. */}
                    <span className="row-info" style={{ display: "block" }}>
                      <span className="row-name" style={{ display: "block" }}>
                        {app.displayName}
                        {app.group && (
                          <span
                            className="text-muted"
                            style={{ marginLeft: 8, fontSize: 12, fontWeight: 400 }}
                          >
                            · {app.group}
                          </span>
                        )}
                      </span>
                      <span className="row-meta">
                        <span className="code-mono">{app.bundleId}</span>
                        <span aria-hidden>—</span>
                        <span>
                          {t("credentialCount", {
                            n: app._count?.credentials ?? 0,
                          })}
                        </span>
                        <span aria-hidden>—</span>
                        <span>
                          {app.versionName ? `${app.versionName} · ` : ""}
                          {t("nextBuild", { n: app.buildNumber + 1 })}
                        </span>
                        {app.deployPaused && (
                          <span
                            className="badge danger"
                            title={t("pausedBadgeTitle")}
                          >
                            {t("paused")}
                          </span>
                        )}
                      </span>
                    </span>
                  </button>
                  <div className="row-actions">
                    {canEdit && (
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        aria-label={
                          app.deployPaused
                            ? t("resumeDeploys")
                            : t("pauseDeploys")
                        }
                        title={
                          app.deployPaused
                            ? t("resumeDeploys")
                            : t("pauseDeploys")
                        }
                        disabled={pending}
                        onClick={() => handleTogglePause(app)}
                      >
                        {app.deployPaused ? (
                          <RiPlayCircleLine size={16} aria-hidden />
                        ) : (
                          <RiPauseCircleLine size={16} aria-hidden />
                        )}
                      </button>
                    )}
                    {canEdit && (
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        aria-label={t("editApp")}
                        title={t("editAppTitle")}
                        disabled={pending}
                        onClick={() =>
                          setEditingId(editingId === app.id ? null : app.id)
                        }
                      >
                        <RiPencilLine size={16} aria-hidden />
                      </button>
                    )}
                    {canEdit && (
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        aria-label={t("deleteAppLabel")}
                        disabled={pending}
                        onClick={() => handleDeleteApp(app)}
                      >
                        <RiDeleteBinLine size={16} aria-hidden />
                      </button>
                    )}
                  </div>
                </div>
                {editingId === app.id && (
                  <div style={{ marginTop: 16 }}>
                    <AppForm
                      slug={slug}
                      app={app}
                      onCancel={() => setEditingId(null)}
                      onSaved={() => {
                        setEditingId(null);
                        load();
                      }}
                    />
                  </div>
                )}
                {open && (
                  <div
                    style={{
                      marginTop: 16,
                      borderTop: "1px solid var(--border)",
                      paddingTop: 16,
                    }}
                  >
                    <AppTabs
                      slug={slug}
                      app={app}
                      canEdit={canEdit}
                      onChange={load}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Création ET édition : même formulaire, `app` distingue les deux modes.
 *  En édition la plateforme est verrouillée — elle décide des types de
 *  credential attendus, la basculer laisserait un keystore Android accroché
 *  à une app iOS (le serveur la refuse aussi). */
function AppForm({
  slug,
  app,
  onCancel,
  onSaved,
}: {
  slug: string;
  app?: MobileApp;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const t = useTranslations("projects.mobile");
  const editing = app != null;
  const [platform, setPlatform] = useState<"android" | "ios">(
    app?.platform ?? "android",
  );
  const [bundleId, setBundleId] = useState(app?.bundleId ?? "");
  const [displayName, setDisplayName] = useState(app?.displayName ?? "");
  const [vendorTeamId, setVendorTeamId] = useState(app?.vendorTeamId ?? "");
  const [group, setGroup] = useState(app?.group ?? "");
  const [versionName, setVersionName] = useState(app?.versionName ?? "");
  // Chaîne dans l'état (un input) ; validée/convertie à l'envoi.
  const [buildNumber, setBuildNumber] = useState(
    app ? String(app.buildNumber) : "0",
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const parsedBuild = Number.parseInt(buildNumber, 10);
      const payload = {
        bundleId: bundleId.trim(),
        displayName: displayName.trim(),
        vendorTeamId: vendorTeamId.trim() || null,
        group: group.trim() || null,
        versionName: versionName.trim() || null,
        buildNumber: Number.isNaN(parsedBuild) ? 0 : parsedBuild,
      };
      const res = await fetch(
        editing
          ? `/api/projects/${slug}/mobile/apps/${app.id}`
          : `/api/projects/${slug}/mobile/apps`,
        {
          method: editing ? "PATCH" : "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(editing ? payload : { ...payload, platform }),
        },
      );
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.error ?? t(editing ? "saveError" : "createError"));
        return;
      }
      onSaved();
    });
  }

  return (
    <form onSubmit={submit} className="create-card">
      <div className="create-card-title">
        {editing ? t("editApp") : t("newApp")}
      </div>
      <div className="form-row">
        <div className="field" style={{ maxWidth: 160 }}>
          <label htmlFor="mobile-platform">{t("platform")}</label>
          <select
            id="mobile-platform"
            className="select"
            value={platform}
            disabled={editing}
            onChange={(e) => setPlatform(e.target.value as "android" | "ios")}
          >
            <option value="android">Android</option>
            <option value="ios">iOS</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="mobile-name">{t("name")}</label>
          <input
            id="mobile-name"
            className="input"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder={t("namePlaceholder")}
          />
        </div>
      </div>
      <div className="form-row" style={{ marginTop: 10 }}>
        <div className="field">
          <label htmlFor="mobile-bundle">
            {platform === "android" ? t("bundleIdAndroid") : t("bundleIdIos")}
          </label>
          <input
            id="mobile-bundle"
            className="input input-mono"
            value={bundleId}
            onChange={(e) => setBundleId(e.target.value)}
            placeholder={t("bundleIdPlaceholder")}
          />
        </div>
        <div className="field">
          <label htmlFor="mobile-group">{t("group")}</label>
          <input
            id="mobile-group"
            className="input"
            value={group}
            onChange={(e) => setGroup(e.target.value)}
            placeholder={t("groupPlaceholder")}
          />
        </div>
      </div>
      <div className="form-row" style={{ marginTop: 10 }}>
        <div className="field">
          <label htmlFor="mobile-vendor">{t("vendorTeamId")}</label>
          <input
            id="mobile-vendor"
            className="input input-mono"
            value={vendorTeamId}
            onChange={(e) => setVendorTeamId(e.target.value)}
            placeholder={t("vendorTeamIdPlaceholder")}
          />
          <p className="help">{t("vendorTeamIdHint")}</p>
        </div>
      </div>
      {/* alignItems flex-start : `.form-row` aligne par le bas, ce qui décale
          le champ Version vers le bas à cause de l'aide sous le n° de build. */}
      <div
        className="form-row"
        style={{ marginTop: 10, alignItems: "flex-start" }}
      >
        <div className="field" style={{ maxWidth: 160 }}>
          <label htmlFor="mobile-version">{t("versionName")}</label>
          <input
            id="mobile-version"
            className="input input-mono"
            value={versionName}
            onChange={(e) => setVersionName(e.target.value)}
            placeholder={t("versionNamePlaceholder")}
          />
        </div>
        <div className="field">
          <label htmlFor="mobile-build">{t("buildNumber")}</label>
          <input
            id="mobile-build"
            className="input input-mono"
            type="number"
            min={0}
            step={1}
            value={buildNumber}
            onChange={(e) => setBuildNumber(e.target.value)}
            placeholder="10"
          />
          <p className="help">{t("buildNumberHint")}</p>
        </div>
      </div>
      {error && <p className="error-text">{error}</p>}
      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={onCancel}
          disabled={pending}
        >
          {t("cancel")}
        </button>
        <button
          type="submit"
          className="btn btn-accent btn-sm"
          disabled={pending || !bundleId.trim() || !displayName.trim()}
        >
          {editing
            ? pending
              ? t("saving")
              : t("save")
            : pending
              ? t("creating")
              : t("create")}
        </button>
      </div>
    </form>
  );
}

function CredentialsSection({
  slug,
  app,
  canEdit,
  onChange,
}: {
  slug: string;
  app: MobileApp;
  canEdit: boolean;
  onChange: () => void;
}) {
  const t = useTranslations("projects.mobile");
  const locale = useLocale();
  const confirm = useConfirm();
  const [credentials, setCredentials] = useState<MobileCredential[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [pending, startTransition] = useTransition();

  // `res.ok` testé : sur 403 (add-on retiré en cours de session) ou 500, le
  // corps n'a pas de `credentials` — on posait `undefined`, et le rendu
  // plantait sur `.length` puisque l'état n'était plus `null`.
  const load = useCallback(() => {
    fetch(`/api/projects/${slug}/mobile/apps/${app.id}/credentials`)
      .then((res) => {
        if (!res.ok) throw new Error("load_failed");
        return res.json();
      })
      .then((data) => setCredentials(data.credentials ?? []))
      .catch(() => setError(t("credentialsLoadError")));
  }, [slug, app.id, t]);

  useEffect(() => {
    load();
  }, [load]);

  // Cf. la note de handleDeleteApp : la confirmation vit HORS de la transition.
  async function handleDelete(kind: string) {
    const ok = await confirm({
      message: t("deleteCredentialConfirm", { kind: kindLabel(t, kind) }),
      danger: true,
    });
    if (!ok) return;
    startTransition(async () => {
      const res = await fetch(
        `/api/projects/${slug}/mobile/apps/${app.id}/credentials/${kind}`,
        { method: "DELETE" },
      );
      if (res.ok) {
        load();
        onChange();
      }
    });
  }

  const relevantKinds = MOBILE_CREDENTIAL_KINDS.filter((k) =>
    app.platform === "android"
      ? k.startsWith("android_") || k === "play_service_account"
      : k.startsWith("ios_") || k.startsWith("asc_"),
  );

  return (
    <div className="flex flex-col gap-3">
      {notice && (
        <p
          className="help"
          style={{
            marginTop: 0,
            padding: "8px 12px",
            borderRadius: 8,
            background: "var(--accent-bg)",
            border: "1px solid var(--accent-soft)",
          }}
        >
          {notice}
        </p>
      )}
      {error ? (
        <p className="error-text">{error}</p>
      ) : credentials === null ? (
        <p className="help">{t("loading")}</p>
      ) : credentials.length === 0 ? (
        <p className="help">{t("noCredentials")}</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>{t("colKind")}</th>
              <th>{t("colFile")}</th>
              <th>{t("colSize")}</th>
              <th>{t("colFingerprint")}</th>
              <th>{t("colExpires")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {credentials.map((c) => (
              <tr key={c.id}>
                <td>{kindLabel(t, c.kind)}</td>
                <td className="text-muted">{c.filename ?? "—"}</td>
                <td className="text-muted">{fmtSize(c.sizeBytes, locale)}</td>
                <td
                  className="code-mono text-muted"
                  title={c.sha256}
                  style={{ fontSize: 11 }}
                >
                  {c.sha256.slice(0, 12)}…
                </td>
                <td>
                  {c.expiresAt === null && MOBILE_EXPIRY_KINDS.has(c.kind) ? (
                    <span className="text-muted" title={t("expiryUnreadable")}>
                      —&nbsp;<abbr title={t("expiryUnreadable")}>?</abbr>
                    </span>
                  ) : isExpiringSoon(c.expiresAt) ? (
                    <span className="badge danger">
                      {fmtDate(c.expiresAt, locale)}
                    </span>
                  ) : (
                    <span className="text-muted">
                      {fmtDate(c.expiresAt, locale)}
                    </span>
                  )}
                </td>
                <td>
                  {canEdit && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      aria-label={t("deleteCredential")}
                      disabled={pending}
                      onClick={() => handleDelete(c.kind)}
                    >
                      <RiDeleteBinLine size={14} aria-hidden />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {canEdit && !showImport && (
        <div>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setShowImport(true)}
          >
            {t("importCredential")}
          </button>
        </div>
      )}
      {canEdit && showImport && (
        <ImportForm
          slug={slug}
          appId={app.id}
          kinds={relevantKinds}
          onCancel={() => setShowImport(false)}
          onImported={(expiryUnread) => {
            setShowImport(false);
            // L'import a réussi : ce n'est pas une erreur, mais un silence
            // serait pire — sans ce message, « pas de date » se confond avec
            // « ce type n'en a pas ».
            setNotice(expiryUnread ? t("expiryUnreadNotice") : null);
            load();
            onChange();
          }}
        />
      )}

      {canEdit && (
        <GenerateSection
          slug={slug}
          app={app}
          hasPivot={(credentials ?? []).some(
            (c) => c.kind === (app.platform === "android" ? "android_keystore" : "ios_p12"),
          )}
          onGenerated={() => {
            load();
            onChange();
          }}
        />
      )}
    </div>
  );
}

/** Les quatre onglets d'une application. Regroupés par QUESTION POSÉE, et non
 *  par fonctionnalité : un onglet qui tiendrait en un seul bouton coûterait un
 *  clic sans rien clarifier. */
type AppTab = "material" | "verify" | "releases" | "ci";

const APP_TABS: AppTab[] = ["material", "verify", "releases", "ci"];

/**
 * Panneau d'une application dépliée.
 *
 * Avant, les cinq sections s'empilaient d'un coup : illisible dès qu'une
 * application avait du matériel, des livraisons ET des policies. Les onglets ne
 * cachent rien — ils répondent à une question à la fois.
 *
 * ⚠️ Les certificats Apple vivent dans « Matériel » et non dans un onglet à
 * eux : « Régénérer le profil seul » ne fonctionne que grâce au certificat en
 * service, et les séparer casserait la lecture de ce lien. De même, promouvoir
 * une version vit dans « Livraisons » — c'est agir sur une ligne qu'on est en
 * train de regarder.
 */
function AppTabs({
  slug,
  app,
  canEdit,
  onChange,
}: {
  slug: string;
  app: MobileApp;
  canEdit: boolean;
  onChange: () => void;
}) {
  const t = useTranslations("projects.mobile");
  const [tab, setTab] = useState<AppTab>("material");
  // Remonté depuis l'onglet Vérification pour porter la pastille : sans elle,
  // il faudrait ouvrir l'onglet pour apprendre qu'il y a un problème.
  const [failures, setFailures] = useState(0);

  return (
    <div>
      <div className="tab-bar" style={{ marginBottom: 16 }}>
        {APP_TABS.map((id) => (
          <button
            key={id}
            type="button"
            className={`tab${tab === id ? " active" : ""}`}
            onClick={() => setTab(id)}
          >
            {t(`tabs.${id}` as never)}
            {id === "verify" && failures > 0 && (
              <span
                className="badge danger"
                title={t("verify.badgeHint")}
                style={{ marginLeft: 6 }}
              >
                {failures}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Chaque onglet est monté/démonté : c'est ce qui fait que l'ouverture
          d'un onglet vaut rafraîchissement pour les listes qui se périment
          (certificats Apple), sans code de synchronisation supplémentaire. */}
      {tab === "material" && (
        <CredentialsSection
          slug={slug}
          app={app}
          canEdit={canEdit}
          onChange={onChange}
        />
      )}
      {tab === "verify" && (
        <VerifySection slug={slug} app={app} canEdit={canEdit} onFailures={setFailures} />
      )}
      {tab === "releases" && (
        <ReleasesSection slug={slug} app={app} canEdit={canEdit} />
      )}
      {tab === "ci" && <PoliciesSection slug={slug} app={app} canEdit={canEdit} />}
    </div>
  );
}

// ── Surveillance d'expiration (Phase 4, §5.4 du plan) ───────────────────────

/**
 * Bannière d'échéance, en tête du panneau.
 *
 * Le pendant visible des rappels J-60/30/7 du cron : un email peut se perdre,
 * partir à un OWNER absent, ou finir en filtre. L'écran, lui, est consulté par
 * la personne qui va justement publier — c'est le dernier endroit où
 * l'avertissement a encore une chance d'être utile.
 *
 * ⚠️ Ni Google, ni Apple, ni les forges n'alertent là-dessus (§5.4). Ce bandeau
 * n'a donc aucun doublon ailleurs.
 */
function ExpiryBanner({
  apps,
  t,
  locale,
}: {
  apps: MobileApp[];
  t: Translator;
  locale: string;
}) {
  const now = Date.now();
  const flagged = apps
    .filter((a) => a.expiresAt)
    .map((a) => ({
      app: a,
      days: Math.floor((new Date(a.expiresAt!).getTime() - now) / 86_400_000),
    }))
    // Même fenêtre que le cron : au-delà de 60 jours, il n'y a rien à faire.
    .filter((x) => x.days <= 60)
    .sort((a, b) => a.days - b.days);

  if (flagged.length === 0) return null;

  // Une seule échéance dépassée suffit à faire virer la bannière au rouge : à
  // ce stade les publications sont déjà cassées, ce n'est plus un rappel.
  const expired = flagged.some((x) => x.days < 0);
  const tone = expired
    ? { bg: "#fef2f2", border: "#fecaca", fg: "#b42318" }
    : { bg: "#fffbeb", border: "#fde68a", fg: "#b45309" };

  return (
    <div
      role="status"
      style={{
        padding: "10px 14px",
        borderRadius: 8,
        background: tone.bg,
        border: `1px solid ${tone.border}`,
      }}
    >
      <div
        style={{ display: "flex", alignItems: "center", gap: 8, color: tone.fg }}
      >
        <RiErrorWarningLine size={16} aria-hidden />
        <strong style={{ fontSize: 13 }}>
          {expired ? t("expiry.titleExpired") : t("expiry.titleSoon")}
        </strong>
      </div>
      <ul style={{ margin: "6px 0 0", paddingLeft: 26, fontSize: 12 }}>
        {flagged.map(({ app, days }) => (
          <li key={app.id}>
            <strong>{app.displayName}</strong>{" "}
            <span className="text-muted">({app.bundleId})</span> —{" "}
            {days < 0
              ? t("expiry.itemExpired", { date: fmtDate(app.expiresAt!, locale) })
              : t("expiry.itemSoon", {
                  date: fmtDate(app.expiresAt!, locale),
                  days,
                })}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── Registre de livraisons (Phase 3, §5.3 du plan) ──────────────────────────

type MobileRelease = {
  id: string;
  track: string;
  versionName: string | null;
  buildNumber: string;
  status: string;
  /** "reported" = le CI l'a dit ; "store" = relu au magasin (Phase 5). */
  statusSource: string;
  statusDetail: string | null;
  signedByCurrent: boolean | null;
  ciProvider: string | null;
  ciRepo: string | null;
  ciRef: string | null;
  requestedAt: string;
  reportedAt: string | null;
};

/** Teinte par état. `live` est le seul vert : tout le reste est en cours, ou
 *  a mal fini. Un `requested` orphelin (matériel servi, jamais rapporté) est
 *  volontairement visible — c'est une information, pas un déchet. */
/** Pistes Play proposées à la promotion. Doit rester alignée sur
 *  `PLAY_PROMOTABLE_TRACKS` de lib/mobile-store-write.ts — le serveur refuse
 *  tout le reste, cette liste n'est que l'ergonomie. */
const PLAY_TRACKS = ["internal", "alpha", "beta", "production"] as const;

const RELEASE_STATUS_TONE: Record<string, string> = {
  live: "#1b7a44",
  uploaded: "#4b5563",
  processing: "#4b5563",
  in_review: "#b45309",
  requested: "#6b7280",
  halted: "#b45309",
  rejected: "#b42318",
  failed: "#b42318",
};

/**
 * L'historique des livraisons d'une application.
 *
 * ⚠️ Physalis ne détient pas l'artefact (§3.2) : cet écran montre des
 * SIGNALEMENTS. Le verbe reste « livré sur une piste », jamais « déployé ».
 */
function ReleasesSection({
  slug,
  app,
  canEdit,
}: {
  slug: string;
  app: MobileApp;
  canEdit: boolean;
}) {
  const t = useTranslations("projects.mobile");
  const locale = useLocale();
  const [releases, setReleases] = useState<MobileRelease[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [acting, setActing] = useState<string | null>(null);
  // Formulaire de promotion ouvert, par ligne. `null` = fermé. La promotion
  // demande DEUX gestes délibérés (ouvrir, puis confirmer) : aucune suite de
  // clics ne doit pouvoir atteindre la production par inadvertance.
  const [promoting, setPromoting] = useState<string | null>(null);
  const [promoteTrack, setPromoteTrack] = useState("");
  const [promoteFraction, setPromoteFraction] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const confirm = useConfirm();

  const load = useCallback(() => {
    fetch(`/api/projects/${slug}/mobile/apps/${app.id}/releases`)
      .then((res) => {
        if (!res.ok) throw new Error("load_failed");
        return res.json();
      })
      .then((data) => setReleases(data.releases ?? []))
      .catch(() => setError(t("releases.loadError")));
  }, [slug, app.id, t]);

  useEffect(() => {
    load();
  }, [load]);

  /** Demande au MAGASIN où en sont ces livraisons. Geste explicite : il part
   *  avec les clés du client vers Google ou Apple. */
  async function sync() {
    setSyncing(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(
        `/api/projects/${slug}/mobile/apps/${app.id}/releases/sync`,
        { method: "POST" },
      );
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(t(`releases.syncErr.${data?.error ?? "failed"}` as never));
        return;
      }
      // « 0 mise à jour » n'est PAS un échec : c'est le cas normal quand rien
      // n'a bougé au magasin depuis la dernière fois. Le taire laisserait
      // croire que le bouton n'a rien fait.
      setNotice(
        t("releases.syncDone", {
          matched: data?.matched ?? 0,
          changed: data?.changed?.length ?? 0,
        }),
      );
      load();
    } catch {
      setError(t("releases.syncErr.failed"));
    } finally {
      setSyncing(false);
    }
  }

  /**
   * Agit sur le MAGASIN (Phase 6). ⚠️ Irréversible : promouvoir en production
   * atteint de vrais utilisateurs, et Play refuse de revenir à un versionCode
   * inférieur. La confirmation dit donc la conséquence, pas « êtes-vous sûr ».
   */
  async function storeAction(
    r: MobileRelease,
    action: "promote" | "halt",
    track: string,
    userFraction?: number,
  ) {
    // La production n'est pas une piste comme les autres : elle atteint les
    // utilisateurs réels de l'application. Son avertissement est distinct, et
    // c'est voulu — un message générique s'use à force d'être lu.
    const message =
      action === "halt"
        ? t("releases.haltConfirm", { build: r.buildNumber, track })
        : track === "production"
          ? t("releases.promoteConfirmProduction", { build: r.buildNumber })
          : t("releases.promoteConfirm", { build: r.buildNumber, track });
    const ok = await confirm({ message, danger: true });
    if (!ok) return;

    setActing(r.id);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(
        `/api/projects/${slug}/mobile/apps/${app.id}/store-action`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action,
            buildNumber: r.buildNumber,
            track,
            ...(userFraction !== undefined ? { userFraction } : {}),
          }),
        },
      );
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        // Le message de Google est explicite (« Version code 41 has already
        // been used ») : le rendre tel quel vaut mieux qu'un libellé générique.
        setError(data?.detail ?? t("releases.actionErr"));
        return;
      }
      setNotice(t("releases.actionDone"));
      setPromoting(null);
      load();
    } catch {
      setError(t("releases.actionErr"));
    } finally {
      setActing(null);
    }
  }

  if (error) return <p className="error-text">{error}</p>;
  if (releases === null) return <p className="help">{t("loading")}</p>;

  return (
    <div>
      <h4 style={{ margin: "0 0 4px", fontSize: 14 }}>{t("releases.title")}</h4>
      <p className="help" style={{ marginTop: 0 }}>
        {t("releases.intro")}
      </p>

      {releases.length > 0 && (
        <div style={{ marginBottom: 8 }}>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={syncing}
            onClick={sync}
          >
            {syncing ? t("releases.syncing") : t("releases.sync")}
          </button>
          {notice && (
            <span className="help" style={{ marginLeft: 8 }}>
              {notice}
            </span>
          )}
        </div>
      )}

      {releases.length === 0 ? (
        <p className="help">{t("releases.empty")}</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>{t("releases.colVersion")}</th>
              <th>{t("releases.colTrack")}</th>
              <th>{t("releases.colStatus")}</th>
              <th>{t("releases.colPipeline")}</th>
              <th>{t("releases.colWhen")}</th>
              {canEdit && app.platform === "android" && <th />}
            </tr>
          </thead>
          <tbody>
            {releases.map((r) => (
              <tr key={r.id}>
                <td>
                  <span className="code-mono">{r.buildNumber}</span>
                  {r.versionName && (
                    <span className="text-muted"> · {r.versionName}</span>
                  )}
                  {/* Une livraison signée par du matériel depuis remplacé ne se
                      reproduit plus à l'identique — ça mérite un signal. */}
                  {r.signedByCurrent === false && (
                    <>
                      {" "}
                      <abbr title={t("releases.staleMaterial")}>
                        <RiErrorWarningLine
                          size={13}
                          color="#b45309"
                          aria-label={t("releases.staleMaterial")}
                        />
                      </abbr>
                    </>
                  )}
                </td>
                <td>
                  {r.track === "pending" ? (
                    <span className="text-muted">{t("releases.trackPending")}</span>
                  ) : (
                    <span className="badge">{r.track}</span>
                  )}
                </td>
                <td>
                  <span style={{ color: RELEASE_STATUS_TONE[r.status] ?? "inherit" }}>
                    {t(`releases.status.${r.status}` as never)}
                  </span>
                  {/* Constaté au magasin vs déclaré par le CI : la nuance dit
                      au lecteur s'il lit celui qui publie ou celui qui héberge. */}
                  {r.statusSource === "store" && (
                    <span
                      className="text-muted"
                      title={t("releases.fromStoreHint")}
                      style={{ fontSize: 10, marginLeft: 4 }}
                    >
                      {t("releases.fromStore")}
                    </span>
                  )}
                  {r.statusDetail && (
                    <div className="text-muted" style={{ fontSize: 11 }}>
                      {r.statusDetail}
                    </div>
                  )}
                </td>
                <td className="text-muted" style={{ fontSize: 12 }}>
                  {r.ciRepo ?? "—"}
                  {r.ciRef && <div style={{ fontSize: 11 }}>{r.ciRef}</div>}
                </td>
                <td className="text-muted" style={{ fontSize: 12 }}>
                  {new Date(r.reportedAt ?? r.requestedAt).toLocaleString(locale)}
                </td>
                {/* Actions magasin : Android seulement pour l'instant — côté
                    Apple, la promotion en vente relève d'appStoreVersions, que
                    la Phase 5 ne lit pas encore. */}
                {canEdit && app.platform === "android" && (
                  <td style={{ whiteSpace: "nowrap" }}>
                    {r.track !== "pending" && r.status !== "halted" && (
                      promoting === r.id ? (
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 6,
                            flexWrap: "wrap",
                          }}
                        >
                          {/* Aucune valeur par défaut : le bouton reste
                              désactivé tant qu'une piste n'a pas été CHOISIE.
                              Un défaut, quel qu'il soit, finirait par être
                              validé sans être lu. */}
                          <select
                            className="select"
                            value={promoteTrack}
                            onChange={(e) => setPromoteTrack(e.target.value)}
                            aria-label={t("releases.promoteTrackLabel")}
                          >
                            <option value="">{t("releases.promoteTrackChoose")}</option>
                            {PLAY_TRACKS.map((tr) => (
                              <option key={tr} value={tr}>
                                {tr}
                                {tr === r.track ? ` — ${t("releases.currentTrack")}` : ""}
                              </option>
                            ))}
                          </select>
                          <input
                            className="input"
                            style={{ width: 96 }}
                            type="number"
                            min={1}
                            max={99}
                            placeholder={t("releases.promoteFractionPlaceholder")}
                            title={t("releases.promoteFractionHint")}
                            value={promoteFraction}
                            onChange={(e) => setPromoteFraction(e.target.value)}
                            aria-label={t("releases.promoteFractionLabel")}
                          />
                          <button
                            type="button"
                            className="btn btn-outline btn-sm"
                            disabled={acting === r.id || !promoteTrack}
                            onClick={() => {
                              const pct = Number.parseInt(promoteFraction, 10);
                              storeAction(
                                r,
                                "promote",
                                promoteTrack,
                                // Vide => diffusion COMPLÈTE. Les bornes sont
                                // strictes côté serveur : 100 % n'est pas un
                                // échelonnement mais un statut `completed`.
                                Number.isFinite(pct) && pct > 0 && pct < 100
                                  ? pct / 100
                                  : undefined,
                              );
                            }}
                          >
                            {t("releases.promoteConfirmBtn")}
                          </button>
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            onClick={() => setPromoting(null)}
                          >
                            {t("cancel")}
                          </button>
                        </div>
                      ) : (
                        <>
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            disabled={acting === r.id}
                            onClick={() => {
                              setPromoting(r.id);
                              setPromoteTrack("");
                              setPromoteFraction("");
                            }}
                          >
                            {t("releases.promote")}
                          </button>
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            disabled={acting === r.id}
                            onClick={() => storeAction(r, "halt", r.track)}
                          >
                            {t("releases.halt")}
                          </button>
                        </>
                      )
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ── Génération du matériel de signature (Phase 7, §5.5 du plan) ─────────────

/**
 * « Générer » plutôt que « déposer ». Android est autonome (un keystore n'est
 * que du crypto) ; iOS part de la seule clé `.p8` déjà importée — Apple ne
 * l'émet que dans son portail, c'est le point d'amorçage irréductible.
 *
 * ⚠️ Le geste est destructif quand du matériel existe déjà : la confirmation
 * n'est pas décorative, et son texte diffère par plateforme (§6.1 — le matériel
 * n'est pas également remplaçable).
 */
function GenerateSection({
  slug,
  app,
  hasPivot,
  onGenerated,
}: {
  slug: string;
  app: MobileApp;
  hasPivot: boolean;
  onGenerated: () => void;
}) {
  const t = useTranslations("projects.mobile");
  const confirm = useConfirm();
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<Record<string, string> | null>(null);

  async function run(mode: "full" | "profile" = "full") {
    // La confirmation vit HORS de l'état « en cours » : même note que
    // handleDeleteApp — une modale ouverte dans une transition ne s'affiche pas.
    // Le mode « profil seul » ne touche ni le certificat ni la clé privée : il
    // n'y a rien à confirmer.
    if (hasPivot && mode === "full") {
      const ok = await confirm({
        message: t(
          app.platform === "android"
            ? "generate.replaceConfirmAndroid"
            : "generate.replaceConfirmIos",
        ),
        danger: true,
      });
      if (!ok) return;
    }

    setRunning(true);
    setError(null);
    setSummary(null);
    try {
      const res = await fetch(
        `/api/projects/${slug}/mobile/apps/${app.id}/generate`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ replace: hasPivot, mode }),
        },
      );
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(generateError(t, data));
        return;
      }
      setSummary(data?.summary ?? {});
      onGenerated();
    } catch {
      setError(t("generate.failed"));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div style={{ marginTop: 12 }}>
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        disabled={running}
        onClick={() => run("full")}
      >
        <RiKey2Line size={14} aria-hidden />
        &nbsp;
        {running
          ? t("generate.running")
          : hasPivot
            ? t("generate.actionReplace")
            : t("generate.action")}
      </button>
      {/* Réemploi (§5.5) : régénérer le SEUL profil quand le certificat est
          encore bon. Un profil vaut 1 an, un certificat aussi, mais leurs
          dates ne coïncident pas — tout régénérer brûlerait un slot Apple
          pour rien, et il n'y en a que deux ou trois. */}
      {app.platform === "ios" && hasPivot && (
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={running}
          style={{ marginLeft: 8 }}
          onClick={() => run("profile")}
        >
          {t("generate.actionProfileOnly")}
        </button>
      )}

      <p className="help" style={{ marginTop: 6 }}>
        {t(app.platform === "android" ? "generate.hintAndroid" : "generate.hintIos")}
      </p>

      {error && <p className="error-text">{error}</p>}

      {app.platform === "ios" && <CertificatesSection slug={slug} app={app} />}

      {summary && (
        <div
          className="help"
          style={{
            marginTop: 8,
            padding: "8px 12px",
            borderRadius: 8,
            background: "var(--accent-bg)",
            border: "1px solid var(--accent-soft)",
          }}
        >
          <strong>{t("generate.done")}</strong>
          <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
            {Object.entries(summary).map(([k, v]) => (
              <li key={k} style={{ fontSize: 12 }}>
                <span className="text-muted">{k}</span> : <span className="code-mono">{v}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Traduit l'échec renvoyé par la route. Les messages d'Apple (`detail`) sont
 *  rendus TELS QUELS : « There is no App ID with ID … » est plus actionnable
 *  que n'importe quelle reformulation, et Apple ne les traduit pas. */
function generateError(t: Translator, data: unknown): string {
  const d = (data ?? {}) as { error?: string; detail?: string; missing?: string[] };
  switch (d.error) {
    case "asc_key_missing": {
      // Nommer CE QUI MANQUE, et non réciter les trois éléments : déposer le
      // seul fichier .p8 est l'erreur naturelle — c'est lui qu'Apple fait
      // télécharger — et un refus générique laisse croire qu'il n'a pas été pris.
      const missing = (d.missing ?? []).map((k) => kindLabel(t, k)).join(", ");
      return missing
        ? t("generate.errAscKeyMissingList", { missing })
        : t("generate.errAscKeyMissing");
    }
    case "cert_cap_reached":
      return t("generate.errCertCap");
    case "bundle_id_not_registered":
      return t("generate.errBundleIdNotRegistered");
    case "asc_error":
      return `${t("generate.errApple")} ${d.detail ?? ""}`.trim();
    case "no_certificate_to_reuse":
    case "certificate_in_use":
    case "already_provisioned":
      // Ces trois-là portent un `detail` écrit pour être lu par un humain :
      // le rendre tel quel vaut mieux qu'un libellé générique.
      return d.detail ?? t("generate.failed");
    default:
      return t("generate.failed");
  }
}

type AscCertificate = {
  id: string;
  name: string;
  expiresAt: string | null;
  inUse: boolean;
};

/**
 * Les certificats de distribution du compte Apple, et lequel est EN SERVICE.
 *
 * ⚠️ Apple en plafonne le nombre (2 pour un compte individuel, 3 pour une
 * organisation) et son API ne dit pas où on en est. Sans cet écran, le seul
 * recours au plafond est la console Apple — ce qui viderait de son sens la
 * promesse « Physalis remplace `match` ».
 *
 * `inUse` est calculé côté serveur en ouvrant le `.p12` du coffre et en
 * comparant les empreintes de CERTIFICAT. Sans lui, révoquer serait un coup de
 * dés : supprimer celui qu'on utilise casse la publication sans prévenir.
 */
function CertificatesSection({ slug, app }: { slug: string; app: MobileApp }) {
  const t = useTranslations("projects.mobile");
  const locale = useLocale();
  const confirm = useConfirm();
  const [certs, setCerts] = useState<AscCertificate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(
        `/api/projects/${slug}/mobile/apps/${app.id}/certificates`,
      );
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        // `asc_key_missing` n'est pas une erreur : c'est l'état normal d'une
        // app dont la clé d'API n'a pas encore été déposée.
        setCerts([]);
        if (data?.error !== "asc_key_missing") {
          setError(data?.detail ?? t("certificates.loadError"));
        }
        return;
      }
      setCerts(data.certificates ?? []);
    } catch {
      setCerts([]);
      setError(t("certificates.loadError"));
    }
  }, [slug, app.id, t]);

  function del(certificateId: string, force: boolean) {
    return fetch(
      `/api/projects/${slug}/mobile/apps/${app.id}/certificates?id=${encodeURIComponent(certificateId)}${force ? "&force=1" : ""}`,
      { method: "DELETE" },
    );
  }

  /**
   * Révocation en DEUX temps, et c'est délibéré.
   *
   * ⚠️ La première tentative ne porte JAMAIS `force`. C'est le serveur qui
   * décide si ce certificat est en service — pas le navigateur. `cert.inUse`
   * date du chargement de la liste : si le `.p12` du coffre a changé depuis
   * (import, régénération, autre onglet), cette croyance est périmée. Envoyer
   * `force` d'emblée, comme le faisait la première version, revenait à laisser
   * le client court-circuiter la garde serveur sur une donnée fausse — et donc
   * à ne jamais l'exercer depuis l'écran.
   *
   * `cert.inUse` ne sert plus qu'au LIBELLÉ de la première confirmation. Quand
   * il est vrai, l'utilisateur a déjà lu et accepté l'avertissement rouge : on
   * ne le lui repose pas au 409.
   */
  async function revoke(cert: AscCertificate) {
    const warnedUpfront = cert.inUse;
    const ok = await confirm({
      message: warnedUpfront
        ? t("certificates.revokeInUseConfirm", { name: cert.name })
        : t("certificates.revokeConfirm", { name: cert.name }),
      danger: true,
    });
    if (!ok) return;

    setBusy(true);
    try {
      let res = await del(cert.id, false);
      let data = await res.json().catch(() => null);

      if (res.status === 409 && data?.error === "certificate_in_use") {
        // Le serveur contredit l'écran : ce certificat EST en service. Si
        // l'utilisateur n'a pas déjà vu l'avertissement rouge, il le voit
        // maintenant — c'est exactement le cas que la garde existe pour
        // attraper.
        if (!warnedUpfront) {
          const forced = await confirm({
            message: t("certificates.revokeInUseConfirm", { name: cert.name }),
            danger: true,
          });
          if (!forced) {
            // La liste affichait une information fausse : on la rafraîchit
            // plutôt que de laisser l'utilisateur devant un badge périmé.
            await load();
            return;
          }
        }
        res = await del(cert.id, true);
        data = await res.json().catch(() => null);
      }

      if (!res.ok) {
        setError(data?.detail ?? t("certificates.revokeError"));
        return;
      }
      await load();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ marginTop: 10 }}>
      {certs === null ? (
        <button type="button" className="btn btn-ghost btn-sm" onClick={load}>
          {t("certificates.load")}
        </button>
      ) : (
        <>
          <p className="help" style={{ margin: "0 0 4px" }}>
            {t("certificates.cap", { count: certs.length })}
          </p>
          {certs.length === 0 ? (
            <p className="help">{t("certificates.empty")}</p>
          ) : (
            <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {certs.map((c) => (
                <li
                  key={c.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "3px 0",
                    fontSize: 12,
                  }}
                >
                  <span>{c.name || c.id}</span>
                  {c.inUse && (
                    <span className="badge" title={t("certificates.inUseHint")}>
                      {t("certificates.inUse")}
                    </span>
                  )}
                  <span className="text-muted">
                    {c.expiresAt ? fmtDate(c.expiresAt, locale) : "—"}
                  </span>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    disabled={busy}
                    onClick={() => revoke(c)}
                  >
                    {t("certificates.revoke")}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {error && <p className="error-text">{error}</p>}
    </div>
  );
}

// ── Validation d'accréditation (Phase 2, §7 du plan) ────────────────────────

const STATUS_STYLE: Record<
  MobileCheck["status"],
  { Icon: typeof RiCheckboxCircleLine; color: string }
> = {
  ok: { Icon: RiCheckboxCircleLine, color: "#1b7a44" },
  warn: { Icon: RiErrorWarningLine, color: "#b45309" },
  fail: { Icon: RiCloseCircleLine, color: "#b42318" },
  skipped: { Icon: RiIndeterminateCircleLine, color: "var(--text-muted)" },
};

/** Codes que CETTE version de l'interface sait traduire. Même discipline que
 *  `kindLabel` : un code inconnu (serveur plus récent que le bundle servi)
 *  s'affiche brut plutôt que de faire crier next-intl et blanchir le panneau. */
const VERIFY_CODES = new Set<string>([
  "complete", "missing",
  "expiry_unknown", "expired", "expiring", "valid_until",
  "keystore_absent", "keystore_unreadable", "keystore_alias_ok",
  "keystore_alias_absent", "keystore_alias_missing",
  "keystore_key_password_differs",
  "p12_absent", "p12_unreadable", "p12_readable",
  "profile_absent", "profile_unreadable", "profile_bundle_ok",
  "profile_bundle_mismatch", "profile_development", "profile_adhoc",
  "profile_cert_match", "profile_cert_mismatch", "profile_team_mismatch",
  "play_absent", "play_offline", "play_ok", "play_ok_scope",
  "play_invalid_key", "play_unauthorized", "play_forbidden",
  "play_app_not_found", "play_unreachable",
  "asc_absent", "asc_offline", "asc_ok", "asc_ok_scope",
  "asc_invalid_key", "asc_unauthorized", "asc_forbidden",
  "asc_app_not_found", "asc_unreachable",
]);

/**
 * « Vérifier le matériel » : contrôles hors ligne (cohérence keystore/profil/
 * certificat) + sondes d'accréditation chez Google et Apple.
 *
 * Geste explicite, jamais automatique — il part avec les clés du client vers
 * des API tierces. Cf. la note en tête de app/api/.../verify/route.ts.
 */
function VerifySection({
  slug,
  app,
  canEdit,
  onFailures,
}: {
  slug: string;
  app: MobileApp;
  canEdit: boolean;
  /** Remonte le nombre d'échecs pour la pastille de l'onglet. */
  onFailures: (n: number) => void;
}) {
  const t = useTranslations("projects.mobile");
  const locale = useLocale();
  const [report, setReport] = useState<MobileVerifyReport | null>(null);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const publish = useCallback(
    (r: MobileVerifyReport | null) => {
      onFailures(r ? r.checks.filter((c) => c.status === "fail").length : 0);
    },
    [onFailures],
  );

  // Le DERNIER rapport connu, lu en base — aucun appel sortant. C'est ce qui
  // permet d'ouvrir l'onglet et de voir l'état sans redemander à Google et
  // Apple, qui coûtent quatre appels et plusieurs secondes.
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/projects/${slug}/mobile/apps/${app.id}/verify`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        setReport(data.report ?? null);
        setCheckedAt(data.checkedAt ?? null);
        publish(data.report ?? null);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [slug, app.id, publish]);

  async function run() {
    setRunning(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/projects/${slug}/mobile/apps/${app.id}/verify`,
        { method: "POST" },
      );
      if (!res.ok) throw new Error("verify_failed");
      const data = await res.json();
      setReport(data.report ?? null);
      setCheckedAt(data.report?.checkedAt ?? null);
      publish(data.report ?? null);
    } catch {
      setError(t("verify.failed"));
    } finally {
      setRunning(false);
    }
  }

  // next-intl type les clés littéralement : une clé CALCULÉE se cast en `never`,
  // ce qui fait retomber le second paramètre sur `undefined` et interdit de
  // passer des valeurs. On desserre donc le typage du traducteur pour ce seul
  // appel — la garde de justesse est `VERIFY_CODES`, pas le compilateur.
  const tCode = t as unknown as (
    key: string,
    values?: Record<string, string | number>,
  ) => string;

  function label(check: MobileCheck): string {
    if (!VERIFY_CODES.has(check.code)) return check.code;
    return tCode(`verify.codes.${check.code}`, check.params ?? {});
  }

  return (
    <div style={{ marginTop: 12 }}>
      {canEdit && (
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={running}
          onClick={run}
        >
          <RiStethoscopeLine size={14} aria-hidden />
          &nbsp;
          {running
            ? t("verify.running")
            : report
              ? t("verify.refresh")
              : t("verify.action")}
        </button>
      )}
      <p className="help" style={{ marginTop: 6 }}>
        {t("verify.hint")}
      </p>

      {error && <p className="error-text">{error}</p>}

      {!report && !running && (
        <p className="help">{t("verify.never")}</p>
      )}

      {report && (
        <div style={{ marginTop: 10 }}>
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {report.checks.map((c, i) => {
              const { Icon, color } = STATUS_STYLE[c.status];
              return (
                <li
                  key={`${c.id}-${c.code}-${i}`}
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 8,
                    padding: "4px 0",
                    fontSize: 13,
                  }}
                >
                  <Icon
                    size={15}
                    color={color}
                    aria-hidden
                    style={{ flexShrink: 0, marginTop: 1 }}
                  />
                  <span>
                    <span className="text-muted">
                      {t(`verify.groups.${c.id}` as never)} —{" "}
                    </span>
                    {label(c)}
                  </span>
                </li>
              );
            })}
          </ul>
          <p className="help" style={{ marginTop: 6 }}>
            {t("verify.checkedAt", {
              date: new Date(checkedAt ?? report.checkedAt).toLocaleString(locale),
            })}
          </p>
        </div>
      )}
    </div>
  );
}

type MobilePolicy = {
  id: string;
  provider: string;
  repo: string;
  workflow: string;
  branch: string;
  createdAt: string;
};

type ProjectCi = {
  provider: string;
  repo: string;
  connectionConfigured: boolean;
};

const PROVIDER_LABEL: Record<string, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  bitbucket: "Bitbucket",
};

/** Autorisations OIDC de CETTE application : quels pipelines peuvent récupérer
 *  son matériel de signature via POST /api/deploy/mobile. Le repo et le
 *  provider viennent de la connexion CI du projet — non éditables ici. */
function PoliciesSection({
  slug,
  app,
  canEdit,
}: {
  slug: string;
  app: MobileApp;
  canEdit: boolean;
}) {
  const t = useTranslations("projects.mobile");
  const confirm = useConfirm();
  const [policies, setPolicies] = useState<MobilePolicy[] | null>(null);
  const [ci, setCi] = useState<ProjectCi | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [pending, startTransition] = useTransition();

  const load = useCallback(() => {
    fetch(`/api/projects/${slug}/mobile/apps/${app.id}/policies`)
      .then((res) => {
        if (!res.ok) throw new Error("load_failed");
        return res.json();
      })
      .then((data) => {
        setPolicies(data.policies ?? []);
        setCi(data.project ?? null);
      })
      .catch(() => setError("Impossible de charger les autorisations."));
  }, [slug, app.id]);

  useEffect(() => {
    load();
  }, [load]);

  function handleDelete(policy: MobilePolicy) {
    startTransition(async () => {
      const ok = await confirm({
        message: t("deletePolicyConfirm", {
          workflow: policy.workflow,
          branch: policy.branch,
        }),
        danger: true,
      });
      if (!ok) return;
      const res = await fetch(
        `/api/projects/${slug}/mobile/apps/${app.id}/policies/${policy.id}`,
        { method: "DELETE" },
      );
      if (res.ok) load();
    });
  }

  const ccxReady = ci?.connectionConfigured && ci.repo !== "";
  const provider = ci?.provider ?? "github";

  return (
    <div className="flex flex-col gap-2">
      <div>
        <h4 className="section-title" style={{ fontSize: 14, margin: 0 }}>
          {t("policiesTitle")}
        </h4>
        <p className="help" style={{ marginTop: 2 }}>
          {t("policiesIntro")}
        </p>
      </div>

      {error ? (
        <p className="error-text">{error}</p>
      ) : policies === null ? (
        <p className="help">{t("loading")}</p>
      ) : (
        <>
          {!ccxReady && <p className="help">{t("policiesNoCcx")}</p>}
          {policies.length > 0 && (
            <p className="help" style={{ marginTop: 0 }}>
              {t("ciHint", {
                endpoint: "/api/deploy/mobile",
                app: app.bundleId,
              })}
            </p>
          )}
          {policies.length > 0 && (
            <table className="table" style={{ marginBottom: 4 }}>
              <thead>
                <tr>
                  <th>{t("policyRepo")}</th>
                  <th>
                    {provider === "github"
                      ? t("policyWorkflow")
                      : t("policyWorkflowCi")}
                  </th>
                  <th>{t("policyBranch")}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {policies.map((p) => (
                  <tr key={p.id}>
                    <td className="code-mono text-muted" style={{ fontSize: 12 }}>
                      <span className="badge" style={{ marginRight: 6 }}>
                        {PROVIDER_LABEL[p.provider] ?? p.provider}
                      </span>
                      {p.repo}
                    </td>
                    <td className="code-mono" style={{ fontSize: 12 }}>
                      {p.workflow || "—"}
                    </td>
                    <td className="code-mono" style={{ fontSize: 12 }}>
                      {p.branch}
                    </td>
                    <td>
                      {canEdit && (
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          aria-label={t("deletePolicy")}
                          disabled={pending}
                          onClick={() => handleDelete(p)}
                        >
                          <RiDeleteBinLine size={14} aria-hidden />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {policies.length === 0 && ccxReady && (
            <p className="help">{t("noPolicies")}</p>
          )}
          {canEdit && ccxReady && !showAdd && (
            <div>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setShowAdd(true)}
              >
                {t("addPolicy")}
              </button>
            </div>
          )}
          {canEdit && ccxReady && showAdd && (
            <PolicyForm
              slug={slug}
              appId={app.id}
              provider={provider}
              repo={ci!.repo}
              onCancel={() => setShowAdd(false)}
              onCreated={() => {
                setShowAdd(false);
                load();
              }}
            />
          )}
        </>
      )}
    </div>
  );
}

function PolicyForm({
  slug,
  appId,
  provider,
  repo,
  onCancel,
  onCreated,
}: {
  slug: string;
  appId: string;
  provider: string;
  repo: string;
  onCancel: () => void;
  onCreated: () => void;
}) {
  const t = useTranslations("projects.mobile");
  const [workflow, setWorkflow] = useState("");
  const [branch, setBranch] = useState("main");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const res = await fetch(
        `/api/projects/${slug}/mobile/apps/${appId}/policies`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            workflow: workflow.trim(),
            branch: branch.trim(),
          }),
        },
      );
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.error ?? t("createPolicyError"));
        return;
      }
      onCreated();
    });
  }

  return (
    <form onSubmit={submit} className="create-card">
      <div className="create-card-title">{t("addPolicy")}</div>
      <p className="help" style={{ marginTop: 0, marginBottom: 8 }}>
        <span className="badge" style={{ marginRight: 6 }}>
          {PROVIDER_LABEL[provider] ?? provider}
        </span>
        <span className="code-mono">{repo}</span>
      </p>
      <div className="form-row">
        <div className="field">
          <label htmlFor="mpol-workflow">
            {provider === "github"
              ? t("policyWorkflow")
              : t("policyWorkflowCi")}
          </label>
          <input
            id="mpol-workflow"
            className="input input-mono"
            value={workflow}
            onChange={(e) => setWorkflow(e.target.value)}
            placeholder={
              provider === "github" ? t("policyWorkflowPlaceholder") : "production"
            }
          />
        </div>
        <div className="field">
          <label htmlFor="mpol-branch">{t("policyBranch")}</label>
          <input
            id="mpol-branch"
            className="input input-mono"
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            placeholder={t("policyBranchPlaceholder")}
          />
        </div>
      </div>
      {error && <p className="error-text">{error}</p>}
      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={onCancel}
          disabled={pending}
        >
          {t("cancel")}
        </button>
        <button
          type="submit"
          className="btn btn-accent btn-sm"
          disabled={pending || !workflow.trim() || !branch.trim()}
        >
          {pending ? t("creatingPolicy") : t("createPolicy")}
        </button>
      </div>
    </form>
  );
}

function ImportForm({
  slug,
  appId,
  kinds,
  onCancel,
  onImported,
}: {
  slug: string;
  appId: string;
  kinds: readonly string[];
  onCancel: () => void;
  /** `expiryUnread` : import réussi, mais date d'expiration illisible. */
  onImported: (expiryUnread: boolean) => void;
}) {
  const t = useTranslations("projects.mobile");
  const [kind, setKind] = useState<string>(kinds[0] ?? "");
  const [file, setFile] = useState<File | null>(null);
  const [textValue, setTextValue] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const isFileKind = MOBILE_FILE_KINDS.has(kind);
  const needsPassphrase = PASSPHRASE_KINDS.has(kind);

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      let valueBase64: string;
      let filename: string | null = null;
      if (isFileKind) {
        if (!file) {
          setError(t("fileMissing"));
          return;
        }
        try {
          valueBase64 = await fileToBase64(file);
        } catch {
          setError(t("fileUnreadable"));
          return;
        }
        filename = file.name;
      } else {
        if (!textValue.trim()) {
          setError(t("valueMissing"));
          return;
        }
        valueBase64 = textToBase64(textValue.trim());
      }

      const res = await fetch(
        `/api/projects/${slug}/mobile/apps/${appId}/credentials`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            kind,
            valueBase64,
            filename,
            passphrase: needsPassphrase && passphrase ? passphrase : undefined,
          }),
        },
      );
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.error ?? t("importError"));
        return;
      }
      onImported(data?.expiryUnread === true);
    });
  }

  return (
    <form onSubmit={submit} className="create-card">
      <div className="create-card-title">{t("importCredential")}</div>
      <div className="form-row">
        <div className="field">
          <label htmlFor="mobile-kind">{t("credentialKind")}</label>
          <select
            id="mobile-kind"
            className="select"
            value={kind}
            onChange={(e) => {
              setKind(e.target.value);
              // Un changement de type change la nature de la valeur : on repart
              // à vide plutôt que de poster le reliquat du type précédent.
              setFile(null);
              setTextValue("");
              setPassphrase("");
            }}
          >
            {kinds.map((k) => (
              <option key={k} value={k}>
                {kindLabel(t, k)}
              </option>
            ))}
          </select>
        </div>
        {isFileKind ? (
          <div className="field">
            <label htmlFor="mobile-file">{t("file")}</label>
            <input
              id="mobile-file"
              type="file"
              className="input"
              accept={KIND_ACCEPT[kind]}
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </div>
        ) : (
          <div className="field">
            <label htmlFor="mobile-value">{t("value")}</label>
            <input
              id="mobile-value"
              type="password"
              className="input"
              value={textValue}
              onChange={(e) => setTextValue(e.target.value)}
              placeholder={t("valuePlaceholder")}
            />
          </div>
        )}
      </div>
      {needsPassphrase && (
        <div className="field" style={{ marginTop: 10 }}>
          <label htmlFor="mobile-passphrase">{t("passphrase")}</label>
          <input
            id="mobile-passphrase"
            type="password"
            className="input"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
          />
          <p className="help">{t("passphraseHint")}</p>
        </div>
      )}
      {error && <p className="error-text">{error}</p>}
      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={onCancel}
          disabled={pending}
        >
          {t("cancel")}
        </button>
        <button type="submit" className="btn btn-accent btn-sm" disabled={pending}>
          {pending ? t("importing") : t("import")}
        </button>
      </div>
    </form>
  );
}
