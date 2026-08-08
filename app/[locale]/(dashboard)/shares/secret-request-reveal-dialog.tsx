"use client";

import { useEffect, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { decryptFromSender } from "@/lib/secret-request-crypto";
import { hybridDecryptFromSender, parsePrivateKey } from "@/lib/hybrid-kem";

export default function SecretRequestRevealDialog({
  requestId,
  label,
  canImport,
  envName,
  secretKey,
  onClose,
  onChanged,
}: {
  requestId: string;
  label: string;
  canImport: boolean;
  envName: string | null;
  secretKey: string | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const t = useTranslations("shares.revealDialog");
  const [privateKey, setPrivateKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [decrypted, setDecrypted] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [imported, setImported] = useState(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function onReveal(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const res = await fetch(
        `/api/secret-requests/${requestId}/reveal`,
        { method: "POST" },
      );
      if (!res.ok) {
        setError(
          res.status === 410
            ? t("errorRevoked")
            : res.status === 404
              ? t("errorNotFound")
              : t("errorFetch"),
        );
        return;
      }
      const payload = (await res.json()) as {
        encryptedSecret: string;
        iv: string;
        ephemeralPublicJwk: string;
        mlkemCiphertext: string | null;
        hybridVersion: number | null;
      };
      try {
        // Détecte le format de la clé privée saisie (composite hybride ou
        // JWK ECDH legacy) et choisit le chemin de déchiffrement adéquat.
        const key = parsePrivateKey(privateKey);
        const isHybrid =
          payload.hybridVersion === 1 && payload.mlkemCiphertext != null;

        let plain: string;
        if (isHybrid) {
          if (key.kind !== "hybrid") {
            setError(t("error"));
            return;
          }
          plain = await hybridDecryptFromSender(
            {
              ciphertext: payload.encryptedSecret,
              iv: payload.iv,
              ephemeralPublicJwk: payload.ephemeralPublicJwk,
              mlkemCiphertext: payload.mlkemCiphertext!,
            },
            key.ecdh,
            key.mlkem,
          );
        } else {
          // Demande legacy (ECDH seul). Une clé composite reste utilisable :
          // on en extrait le volet ECDH.
          plain = await decryptFromSender(
            {
              ciphertext: payload.encryptedSecret,
              iv: payload.iv,
              ephemeralPublicJwk: payload.ephemeralPublicJwk,
            },
            key.ecdh,
          );
        }
        setDecrypted(plain);
        setPrivateKey("");
      } catch {
        setError(t("error"));
      }
    });
  }

  function copyDecrypted() {
    if (!decrypted) return;
    navigator.clipboard.writeText(decrypted).catch(() => undefined);
  }

  function importToProject() {
    if (!decrypted) return;
    startTransition(async () => {
      const res = await fetch(
        `/api/secret-requests/${requestId}/import`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ value: decrypted }),
        },
      );
      if (res.ok) {
        setImported(true);
        setTimeout(() => {
          onChanged();
          onClose();
        }, 1200);
      } else {
        const data = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        setError(data?.error ?? t("errorImport"));
      }
    });
  }

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div
        className="dialog dialog-lg"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: 720, width: "92vw" }}
      >
        <div className="dialog-header">
          <h2 className="dialog-title">{t("title")}</h2>
          <button
            type="button"
            onClick={onClose}
            className="dialog-close"
            aria-label={t("closeBtn")}
          >
            ✕
          </button>
        </div>

        <div className="dialog-body">
          <p className="help" style={{ fontSize: 13 }}>
            <strong>{label}</strong>
          </p>

          {!decrypted ? (
            <form onSubmit={onReveal} className="flex flex-col gap-3">
              <div className="field">
                <label>{t("privateKeyLabel")}</label>
                <textarea
                  required
                  rows={6}
                  value={privateKey}
                  onChange={(e) => setPrivateKey(e.target.value)}
                  placeholder='{"v":1,"ecdh":"{...}","mlkem":"..."}'
                  className="input input-mono"
                  style={{ fontSize: 11, resize: "vertical" }}
                />
                <div className="help" style={{ marginTop: 4, fontSize: 12 }}>
                  {t("localHint")}
                </div>
              </div>
              {error && <p className="error-text">{error}</p>}
              <div
                style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}
              >
                <button
                  type="button"
                  onClick={onClose}
                  className="btn btn-ghost btn-sm"
                >
                  {t("cancelBtn")}
                </button>
                <button
                  type="submit"
                  disabled={pending || !privateKey.trim()}
                  className="btn btn-primary btn-sm"
                >
                  {pending ? t("decryptingBtn") : t("submitBtn")}
                </button>
              </div>
            </form>
          ) : (
            <>
              <div className="field">
                <label>{t("decryptedLabel")}</label>
                <textarea
                  readOnly
                  rows={5}
                  value={decrypted}
                  onFocus={(e) => e.currentTarget.select()}
                  className="input input-mono"
                  style={{ fontSize: 12, resize: "vertical" }}
                />
              </div>
              {imported && (
                <p
                  className="help"
                  style={{ color: "var(--success)", textAlign: "center" }}
                >
                  {t("imported")}
                </p>
              )}
              {error && <p className="error-text">{error}</p>}
              <div
                style={{
                  display: "flex",
                  justifyContent: "flex-end",
                  gap: 8,
                  flexWrap: "wrap",
                }}
              >
                <button
                  type="button"
                  onClick={copyDecrypted}
                  className="btn btn-ghost btn-sm"
                >
                  {t("copyBtn")}
                </button>
                {canImport && !imported && (
                  <button
                    type="button"
                    onClick={importToProject}
                    disabled={pending}
                    className="btn btn-primary btn-sm"
                  >
                    {pending
                      ? t("importingBtn")
                      : envName && secretKey
                        ? t("importBtn", { env: envName, key: secretKey })
                        : t("importToVaultBtn")}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    setDecrypted(null);
                    onClose();
                  }}
                  className="btn btn-ghost btn-sm"
                >
                  {t("closeBtn")}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
