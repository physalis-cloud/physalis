"use client";

// Clés SSH du coffre personnel — chantier C-0050 (agent-ssh), phase 1.
//
// Section à part de la liste générique : une clé SSH n'a ni mot de passe, ni
// révélation, ni conversion, ni déplacement (lib/vault-entry-types.ts). On n'en
// montre que la clé publique et l'empreinte ; la clé privée ne quitte jamais le
// serveur. La génération dans Physalis est le chemin recommandé : la clé n'a
// alors jamais existé sur aucun disque.

import { useCallback, useEffect, useState } from "react";
import { RiTerminalBoxLine, RiFileCopyLine, RiDeleteBinLine } from "@remixicon/react";
import { useTranslations } from "next-intl";
import { useConfirm } from "@/components/ConfirmDialog";

type SshKeyEntry = {
  id: string;
  type: string;
  name: string;
  sshPublicKey: string | null;
  sshFingerprint: string | null;
  createdAt: string;
};

const ERROR_CODES = [
  "unrecognized_format",
  "passphrase_required",
  "wrong_passphrase",
  "unsupported_algorithm",
  "rsa_too_short",
  "unsupported_cipher",
  "duplicate_key",
  "kdf_rounds_too_high",
] as const;

export default function SshKeysSection({ onChanged }: { onChanged?: () => void }) {
  const t = useTranslations("vault.sshKeys");
  const confirm = useConfirm();
  const [keys, setKeys] = useState<SshKeyEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const reload = useCallback(async () => {
    const res = await fetch("/api/vault/entries");
    if (!res.ok) {
      setError(t("loadError"));
      return;
    }
    const data = (await res.json()) as { entries: SshKeyEntry[] };
    setKeys(data.entries.filter((e) => e.type === "SSH_KEY"));
  }, [t]);

  useEffect(() => {
    reload();
  }, [reload]);

  async function copyPublicKey(k: SshKeyEntry) {
    if (!k.sshPublicKey) return;
    await navigator.clipboard.writeText(k.sshPublicKey);
    setNotice(t("copied"));
    setTimeout(() => setNotice(null), 2000);
  }

  async function remove(k: SshKeyEntry) {
    if (!(await confirm({ message: t("deleteConfirm", { name: k.name }), danger: true }))) return;
    const res = await fetch(`/api/vault/entries/${k.id}`, { method: "DELETE" });
    if (!res.ok) {
      setError(t("deleteError"));
      return;
    }
    reload();
    onChanged?.();
  }

  return (
    <section className="section" style={{ marginTop: 24 }}>
      <div className="section-header flex items-center justify-between">
        <h2 className="section-title">{t("title")}</h2>
        <button type="button" className="btn btn-ghost" onClick={() => setAdding(true)}>
          {t("addBtn")}
        </button>
      </div>
      <p className="help" style={{ marginBottom: 12 }}>{t("intro")}</p>
      {error && <p className="error-text">{error}</p>}
      {notice && <p className="help">{notice}</p>}

      {adding && (
        <SshKeyDialog
          onClose={() => setAdding(false)}
          onCreated={() => {
            setAdding(false);
            reload();
            onChanged?.();
          }}
        />
      )}

      {keys === null ? (
        <p className="help">{t("loading")}</p>
      ) : keys.length === 0 ? (
        <div className="empty-state" style={{ padding: 20 }}>
          <div>{t("empty")}</div>
        </div>
      ) : (
        <div className="row-list">
          {keys.map((k) => (
            <div key={k.id} className="row">
              <div className="row-icon"><RiTerminalBoxLine size={18} aria-hidden /></div>
              <div className="row-info">
                <div className="row-name">{k.name}</div>
                <div className="row-meta code-mono">
                  {k.sshPublicKey?.split(" ")[0]} · {k.sshFingerprint}
                </div>
              </div>
              <div className="row-actions">
                <button
                  type="button"
                  className="btn btn-ghost btn-xs"
                  onClick={() => copyPublicKey(k)}
                  title={t("copyPublicKey")}
                >
                  <RiFileCopyLine size={14} aria-hidden /> {t("copyPublicKey")}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-xs"
                  onClick={() => remove(k)}
                  aria-label={t("deleteBtn")}
                  title={t("deleteBtn")}
                >
                  <RiDeleteBinLine size={14} aria-hidden />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function SshKeyDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const t = useTranslations("vault.sshKeys");
  const [mode, setMode] = useState<"generate" | "import">("generate");
  const [name, setName] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/vault/ssh-keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          mode === "generate"
            ? { name, mode }
            : { name, mode, privateKey, ...(passphrase ? { passphrase } : {}) },
        ),
      });
      if (res.ok) {
        onCreated();
        return;
      }
      const body = (await res.json().catch(() => null)) as { code?: string; error?: string } | null;
      const code = body?.code;
      setError(
        code && (ERROR_CODES as readonly string[]).includes(code)
          ? t(`errors.${code}`)
          : (body?.error ?? t("errors.generic")),
      );
    } finally {
      setPending(false);
      // Ne pas garder la phrase de passe en mémoire du formulaire plus que nécessaire.
      setPassphrase("");
    }
  }

  return (
    <form onSubmit={submit} className="card" style={{ padding: 16, marginBottom: 16 }}>
      <div className="flex gap-2" style={{ marginBottom: 12 }}>
        <button
          type="button"
          className={`btn btn-xs ${mode === "generate" ? "btn-primary" : "btn-ghost"}`}
          onClick={() => setMode("generate")}
        >
          {t("modeGenerate")}
        </button>
        <button
          type="button"
          className={`btn btn-xs ${mode === "import" ? "btn-primary" : "btn-ghost"}`}
          onClick={() => setMode("import")}
        >
          {t("modeImport")}
        </button>
      </div>
      <p className="help" style={{ marginBottom: 12 }}>
        {mode === "generate" ? t("generateHint") : t("importHint")}
      </p>

      <div className="field">
        <label htmlFor="ssh-name">{t("nameLabel")}</label>
        <input
          id="ssh-name"
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("namePlaceholder")}
          required
          autoFocus
        />
      </div>

      {mode === "import" && (
        <>
          <div className="field">
            <label htmlFor="ssh-private">{t("privateKeyLabel")}</label>
            <textarea
              id="ssh-private"
              className="input code-mono"
              rows={6}
              value={privateKey}
              onChange={(e) => setPrivateKey(e.target.value)}
              placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
              spellCheck={false}
              autoComplete="off"
              required
            />
          </div>
          <div className="field">
            <label htmlFor="ssh-pass">{t("passphraseLabel")}</label>
            <input
              id="ssh-pass"
              type="password"
              className="input"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              autoComplete="off"
            />
          </div>
          <p className="help">{t("importAfter")}</p>
        </>
      )}

      {error && <p className="error-text">{error}</p>}
      <div className="flex gap-2" style={{ marginTop: 12 }}>
        <button type="submit" className="btn btn-primary" disabled={pending || !name.trim()}>
          {mode === "generate" ? t("generateBtn") : t("importBtn")}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onClose} disabled={pending}>
          {t("cancelBtn")}
        </button>
      </div>
    </form>
  );
}
