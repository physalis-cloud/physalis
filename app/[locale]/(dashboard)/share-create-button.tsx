"use client";

// Bouton "Partager un secret" dans le header + modal de creation.
//
// Architecture zero-knowledge (cf. lib/share-crypto.ts) :
//   1. L'user empile un ou plusieurs items dans la modale : des secrets texte
//      et/ou de petits fichiers texte (cf. lib/share-envelope.ts).
//   2. Au submit : on serialise les items en enveloppe JSON, on genere une cle
//      AES-256 cote NAVIGATEUR, on encrypt l'enveloppe, on POST
//      { ciphertext, iv, title?, ttlSeconds }. La cle ne quitte jamais le
//      navigateur ; le serveur ignore qu'il y a plusieurs items dedans.
//   3. Le serveur retourne un token public. On construit l'URL :
//      `https://<host>/share/<token>#<key>` et on l'affiche pour copy.
//   4. Le destinataire ouvre l'URL → fetch ciphertext → decrypt avec la
//      cle du fragment → affiche la liste d'items.

import { useState, useTransition } from "react";
import { Link } from "@/i18n/navigation";
import {
  RiShareForward2Line,
  RiAddLine,
  RiDeleteBinLine,
  RiFileTextLine,
} from "@remixicon/react";
import { useTranslations, useLocale } from "next-intl";
import { encryptShareContent, generateShareKey } from "@/lib/share-crypto";
import { maskedInputProps } from "@/lib/masked-input";
import {
  encodeEnvelope,
  encodedByteLength,
  type ShareItem,
  TEXT_ITEM_MAX,
  FILE_ITEM_MAX,
  ENVELOPE_PLAINTEXT_MAX,
  MAX_ITEMS,
} from "@/lib/share-envelope";

const TTL_OPTIONS: { value: number; label: string }[] = [
  { value: 900, label: "15 minutes" },
  { value: 3600, label: "1 hour" },
  { value: 14400, label: "4 hours" },
  { value: 86400, label: "24 hours" },
];

const DEFAULT_TTL = 3600;

export default function ShareCreateButton() {
  const t = useTranslations("shares");
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="btn btn-primary"
      >
        <RiShareForward2Line size={14} aria-hidden /> {t("createBtn")}
      </button>
      {open && <ShareCreateDialog onClose={() => setOpen(false)} />}
    </>
  );
}

// Seuils en secondes a partir desquels on suggere l'ajout d'un mot de passe :
// 4h ou plus → fenetre d'attaque longue, le password ajoute une defense en
// profondeur utile. <4h → on cache le champ, friction non justifiee.
const TTL_PASSWORD_THRESHOLD = 14400;
const PASSWORD_MIN = 4;

// Item interne (le champ `title` du form est conserve meme vide pour ne pas
// perdre le focus pendant la frappe ; on le trim seulement au submit).
type FormItem =
  | { type: "text"; title: string; content: string }
  | { type: "file"; filename: string; content: string };

function ShareCreateDialog({ onClose }: { onClose: () => void }) {
  const t = useTranslations("shares");
  const locale = useLocale();
  const [items, setItems] = useState<FormItem[]>([
    { type: "text", title: "", content: "" },
  ]);
  const [title, setTitle] = useState("");
  const [recipientEmail, setRecipientEmail] = useState("");
  const [password, setPassword] = useState("");
  const [ttl, setTtl] = useState<number>(DEFAULT_TTL);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [emailSent, setEmailSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [copied, setCopied] = useState(false);

  const showPasswordField = ttl >= TTL_PASSWORD_THRESHOLD;
  const kb = (bytes: number) => Math.round(bytes / 1024);

  function addTextItem() {
    setError(null);
    setItems((prev) =>
      prev.length >= MAX_ITEMS
        ? prev
        : [...prev, { type: "text", title: "", content: "" }],
    );
    if (items.length >= MAX_ITEMS)
      setError(t("createDialog.tooManyItems", { max: MAX_ITEMS }));
  }

  function updateTextItem(
    idx: number,
    patch: { title?: string; content?: string },
  ) {
    setItems((prev) =>
      prev.map((it, i) =>
        i === idx && it.type === "text" ? { ...it, ...patch } : it,
      ),
    );
  }

  function removeItem(idx: number) {
    setError(null);
    setItems((prev) => prev.filter((_, i) => i !== idx));
  }

  async function onFilesPicked(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = ""; // permet de re-selectionner le meme fichier
    if (files.length === 0) return;
    const read = await Promise.all(
      files.map((f) => f.text().then((content) => ({ name: f.name, content }))),
    );
    let err: string | null = null;
    const next = [...items];
    for (const { name, content } of read) {
      if (next.length >= MAX_ITEMS) {
        err = t("createDialog.tooManyItems", { max: MAX_ITEMS });
        break;
      }
      if (content.length > FILE_ITEM_MAX) {
        err = t("createDialog.fileTooLarge", {
          name,
          max: kb(FILE_ITEM_MAX),
        });
        continue;
      }
      next.push({ type: "file", filename: name, content });
    }
    setItems(next);
    setError(err);
  }

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);

    // Items effectifs : on garde les fichiers + les secrets texte non vides.
    const cleaned: ShareItem[] = items
      .filter((it) => it.type === "file" || it.content.trim().length > 0)
      .map((it) =>
        it.type === "text"
          ? {
              type: "text",
              content: it.content,
              ...(it.title.trim() ? { title: it.title.trim() } : {}),
            }
          : { type: "file", filename: it.filename, content: it.content },
      );

    if (cleaned.length === 0) {
      setError(t("createDialog.errorEmpty"));
      return;
    }
    for (const it of cleaned) {
      if (it.type === "text" && it.content.length > TEXT_ITEM_MAX) {
        setError(t("createDialog.errorLength", { max: TEXT_ITEM_MAX }));
        return;
      }
      if (it.type === "file" && it.content.length > FILE_ITEM_MAX) {
        setError(
          t("createDialog.fileTooLarge", {
            name: it.filename,
            max: kb(FILE_ITEM_MAX),
          }),
        );
        return;
      }
    }
    if (encodedByteLength(cleaned) > ENVELOPE_PLAINTEXT_MAX) {
      setError(
        t("createDialog.bundleTooLarge", { max: kb(ENVELOPE_PLAINTEXT_MAX) }),
      );
      return;
    }
    if (showPasswordField && password && password.length < PASSWORD_MIN) {
      setError(t("createDialog.errorPassword", { min: PASSWORD_MIN }));
      return;
    }

    startTransition(async () => {
      try {
        const key = await generateShareKey();
        const { ciphertext, iv } = await encryptShareContent(
          encodeEnvelope(cleaned),
          key,
        );
        const res = await fetch("/api/share", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ciphertext,
            iv,
            title: title.trim() || null,
            ttlSeconds: ttl,
            password: showPasswordField && password ? password : null,
          }),
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => null)) as
            | { error?: string }
            | null;
          setError(data?.error ?? t("createDialog.createError"));
          return;
        }
        const data = (await res.json()) as {
          id: string;
          token: string;
          expiresAt: string;
        };
        const url = `${window.location.origin}/${locale}/share/${data.token}#${key}`;
        setShareUrl(url);
        setExpiresAt(data.expiresAt);

        if (recipientEmail.trim()) {
          const sendRes = await fetch(`/api/me/shares/${data.id}/send`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ email: recipientEmail.trim(), url }),
          });
          if (sendRes.ok) setEmailSent(true);
          else {
            const sendData = (await sendRes.json().catch(() => null)) as
              | { error?: string }
              | null;
            setError(
              t("createDialog.errorEmailFailed", {
                error: sendData?.error ?? "error",
              }),
            );
          }
        }
      } catch (err) {
        console.error(err);
        setError(t("createDialog.encryptionError"));
      }
    });
  }

  async function copyUrl() {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError(t("copyError"));
    }
  }

  const expiresLabel = expiresAt ? new Date(expiresAt).toLocaleString() : "";
  const hasContent = items.some(
    (it) => it.type === "file" || it.content.trim().length > 0,
  );
  const atMaxItems = items.length >= MAX_ITEMS;

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog dialog-lg" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-header">
          <h2 className="dialog-title">
            <RiShareForward2Line size={18} aria-hidden />{" "}
            {t("createDialog.title")}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="dialog-close"
            aria-label={t("createDialog.closeLabel")}
          >
            ✕
          </button>
        </div>

        {shareUrl ? (
          <>
            <div className="dialog-body">
              {emailSent && (
                <p
                  className="help"
                  style={{
                    padding: 12,
                    background: "var(--accent-bg)",
                    border: "1px solid var(--accent-soft)",
                    borderRadius: 8,
                    color: "var(--fg)",
                  }}
                >
                  {t("createDialog.emailSentTo", { email: recipientEmail })}
                </p>
              )}
              <p className="help">
                <strong>{t("createDialog.urlNotShownAgain")}</strong>{" "}
                {t("createDialog.expiresOn", { date: expiresLabel })}
              </p>
              <div className="field">
                <label>{t("createDialog.linkLabel")}</label>
                <div
                  className="code-mono"
                  style={{
                    padding: 10,
                    background: "var(--code-bg)",
                    border: "1px solid var(--border)",
                    borderRadius: 8,
                    fontSize: 12,
                    wordBreak: "break-all",
                  }}
                >
                  {shareUrl}
                </div>
              </div>
              <p className="help">
                <strong>{t("createDialog.zkNote")} :</strong>{" "}
                <Link href="/shares" className="text-accent">
                  {t("createDialog.seeMyShares")}
                </Link>
              </p>
            </div>
            <div className="dialog-footer">
              <button
                type="button"
                onClick={copyUrl}
                className="btn btn-primary btn-sm"
              >
                {copied
                  ? t("createDialog.copiedBtn")
                  : t("createDialog.copyBtn")}
              </button>
              <button
                type="button"
                onClick={onClose}
                className="btn btn-ghost btn-sm"
              >
                {t("createDialog.closeLabel")}
              </button>
            </div>
          </>
        ) : (
          <form onSubmit={submit}>
            <div className="dialog-body">
              <div className="field">
                <label>{t("createDialog.titleLabel")}</label>
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  maxLength={200}
                  className="input"
                />
              </div>

              <div className="field">
                <label>{t("createDialog.contentLabel")}</label>
                <div style={{ display: "grid", gap: 10 }}>
                  {items.map((it, idx) =>
                    it.type === "text" ? (
                      <div
                        key={idx}
                        style={{
                          border: "1px solid var(--border)",
                          borderRadius: 8,
                          padding: 10,
                          display: "grid",
                          gap: 8,
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            gap: 8,
                            alignItems: "center",
                          }}
                        >
                          <input
                            value={it.title}
                            onChange={(e) =>
                              updateTextItem(idx, { title: e.target.value })
                            }
                            maxLength={200}
                            placeholder={t("createDialog.itemTitlePlaceholder")}
                            className="input"
                            style={{ flex: 1 }}
                          />
                          {items.length > 1 && (
                            <button
                              type="button"
                              onClick={() => removeItem(idx)}
                              className="btn btn-ghost btn-sm"
                              aria-label={t("createDialog.removeItemLabel")}
                            >
                              <RiDeleteBinLine size={14} aria-hidden />
                            </button>
                          )}
                        </div>
                        <textarea
                          value={it.content}
                          onChange={(e) =>
                            updateTextItem(idx, { content: e.target.value })
                          }
                          rows={6}
                          maxLength={TEXT_ITEM_MAX}
                          className="textarea textarea-mono"
                          autoFocus={idx === 0}
                        />
                      </div>
                    ) : (
                      <div
                        key={idx}
                        style={{
                          border: "1px solid var(--border)",
                          borderRadius: 8,
                          padding: "8px 10px",
                          display: "flex",
                          gap: 8,
                          alignItems: "center",
                        }}
                      >
                        <RiFileTextLine
                          size={16}
                          aria-hidden
                          style={{ flexShrink: 0, opacity: 0.7 }}
                        />
                        <span
                          className="code-mono"
                          style={{
                            flex: 1,
                            fontSize: 13,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {it.filename}
                        </span>
                        <span className="help" style={{ fontSize: 12 }}>
                          {kb(it.content.length) || 1} KB
                        </span>
                        <button
                          type="button"
                          onClick={() => removeItem(idx)}
                          className="btn btn-ghost btn-sm"
                          aria-label={t("createDialog.removeItemLabel")}
                        >
                          <RiDeleteBinLine size={14} aria-hidden />
                        </button>
                      </div>
                    ),
                  )}
                </div>
                <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                  <button
                    type="button"
                    onClick={addTextItem}
                    disabled={atMaxItems}
                    className="btn btn-ghost btn-sm"
                  >
                    <RiAddLine size={14} aria-hidden />{" "}
                    {t("createDialog.addSecretBtn")}
                  </button>
                  <label
                    className="btn btn-ghost btn-sm"
                    style={{
                      cursor: atMaxItems ? "not-allowed" : "pointer",
                      opacity: atMaxItems ? 0.5 : 1,
                    }}
                  >
                    <RiFileTextLine size={14} aria-hidden />{" "}
                    {t("createDialog.addFileBtn")}
                    <input
                      type="file"
                      multiple
                      hidden
                      disabled={atMaxItems}
                      onChange={onFilesPicked}
                    />
                  </label>
                </div>
              </div>

              <div className="field">
                <label>{t("createDialog.durationLabel")}</label>
                <select
                  value={ttl}
                  onChange={(e) => setTtl(Number(e.target.value))}
                  className="select"
                >
                  {TTL_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>

              {showPasswordField && (
                <div className="field">
                  <label>{t("createDialog.passwordLabel")}</label>
                  <input
                    {...maskedInputProps(false, "input")}
                    name="share-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={`≥ ${PASSWORD_MIN} chars`}
                    autoComplete="off"
                  />
                </div>
              )}

              <div className="field">
                <label>{t("createDialog.emailLabel")}</label>
                <input
                  type="email"
                  value={recipientEmail}
                  onChange={(e) => setRecipientEmail(e.target.value)}
                  placeholder="recipient@example.com"
                  autoComplete="off"
                  className="input"
                />
              </div>

              {error && <p className="error-text">{error}</p>}
            </div>
            <div className="dialog-footer">
              <button
                type="button"
                onClick={onClose}
                className="btn btn-ghost btn-sm"
              >
                {t("createDialog.cancelBtn")}
              </button>
              <button
                type="submit"
                disabled={pending || !hasContent}
                className="btn btn-primary btn-sm"
              >
                {pending
                  ? t("createDialog.encryptingBtn")
                  : t("createDialog.submitBtn")}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
