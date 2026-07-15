"use client";

// Consommation d'un OneTimeShare cote navigateur.
//
// Flow :
//   1. Au mount, on extrait la cle du fragment `window.location.hash`.
//      Si absent ou mal formate → "lien incomplet".
//   2. L'user clique "Reveler" → POST /api/share/[token] (sans body) :
//      - Si le share n'a pas de password : le serveur consomme et renvoie
//        ciphertext+iv direct.
//      - Sinon : 401 + `{ requiresPassword: true }`. On affiche un input
//        password puis on relance avec `{ password }`.
//   3. Le serveur consomme atomiquement (UPDATE WHERE consumedAt IS NULL),
//      renvoie ciphertext+iv+title.
//   4. On dechiffre en local avec la cle du fragment.
//
// Apres reveal, le fragment est nettoye de l'URL (history.replaceState) pour
// eviter qu'un partage de l'URL post-consume puisse re-dechiffrer.

import Image from "next/image";
import { useState, useTransition } from "react";
import {
  RiClipboardLine,
  RiLockUnlockLine,
  RiDownloadLine,
  RiFileTextLine,
} from "@remixicon/react";
import { decryptShareContent } from "@/lib/share-crypto";
import { decodeEnvelope, type ShareItem } from "@/lib/share-envelope";

type Status =
  | { kind: "ready"; key: string }
  | { kind: "no_key" }
  | {
      kind: "password_required";
      key: string;
      attemptsRemaining: number | null;
      lastError: string | null;
    }
  | { kind: "revealed"; items: ShareItem[]; title: string | null }
  | { kind: "error"; message: string };

export default function ShareConsumeClient({ token }: { token: string }) {
  const [status, setStatus] = useState<Status>(() => {
    if (typeof window === "undefined") return { kind: "no_key" };
    const hash = window.location.hash.replace(/^#/, "");
    if (!hash) return { kind: "no_key" };
    return { kind: "ready", key: hash };
  });
  const [pwInput, setPwInput] = useState("");
  const [pending, startTransition] = useTransition();
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);

  function reveal(key: string, password?: string) {
    startTransition(async () => {
      try {
        const res = await fetch(`/api/share/${token}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ password: password ?? null }),
        });

        if (res.status === 401) {
          const data = (await res.json().catch(() => null)) as {
            requiresPassword?: boolean;
            attemptsRemaining?: number;
            revoked?: boolean;
          } | null;
          if (data?.revoked) {
            setStatus({
              kind: "error",
              message:
                "Trop de tentatives. Le lien a été automatiquement révoqué.",
            });
            return;
          }
          if (data?.requiresPassword) {
            setStatus({
              kind: "password_required",
              key,
              attemptsRemaining: data.attemptsRemaining ?? null,
              lastError:
                password !== undefined ? "Mot de passe incorrect." : null,
            });
            setPwInput("");
            return;
          }
        }
        if (res.status === 404) {
          setStatus({
            kind: "error",
            message:
              "Lien invalide, expiré ou déjà consommé. Un partage ne peut être ouvert qu'une seule fois.",
          });
          return;
        }
        if (!res.ok) {
          setStatus({ kind: "error", message: "Erreur réseau." });
          return;
        }
        const data = (await res.json()) as {
          ciphertext: string;
          iv: string;
          title: string | null;
        };
        const plaintext = await decryptShareContent(
          data.ciphertext,
          data.iv,
          key,
        );
        const items = decodeEnvelope(plaintext);
        history.replaceState(null, "", window.location.pathname);
        setStatus({ kind: "revealed", items, title: data.title });
      } catch {
        setStatus({
          kind: "error",
          message:
            "Échec du déchiffrement. La clé est peut-être incorrecte ou les données sont corrompues.",
        });
      }
    });
  }

  async function copyContent(idx: number, content: string) {
    try {
      await navigator.clipboard.writeText(content);
      setCopiedIdx(idx);
      setTimeout(() => setCopiedIdx((c) => (c === idx ? null : c)), 1500);
    } catch {
      // ignore
    }
  }

  function downloadFile(filename: string, content: string) {
    // Sanitize : pas de separateur de chemin dans le nom telecharge.
    const safe = filename.replace(/[/\\]/g, "_").trim() || "fichier.txt";
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = safe;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  // Layout : le card est plus large pour la lecture confortable du contenu
  // (vs login-card par defaut). Override via style inline.
  return (
    <div
      className="login-card"
      style={{ maxWidth: 640, width: "100%" }}
    >
      <div className="login-brand">
        <Image
          src="/icon-128.png"
          alt="Physalis"
          width={64}
          height={64}
          className="login-brand-icon"
          priority
        />
        <div className="login-brand-text">
          <div className="login-brand-name">Physalis</div>
          <div className="login-brand-tag">Partage à usage unique</div>
        </div>
      </div>

      {status.kind === "no_key" && (
        <>
          <p className="error-text" style={{ textAlign: "center" }}>
            Lien incomplet : la clé de déchiffrement est manquante.
          </p>
          <p className="help" style={{ textAlign: "center" }}>
            Vérifie que tu as bien copié l&apos;URL en entier (incluant le
            <code className="code-mono"> # </code>et tout ce qui suit).
          </p>
        </>
      )}

      {status.kind === "ready" && (
        <>
          <p className="help" style={{ textAlign: "center" }}>
            Quelqu&apos;un t&apos;a partagé un secret. Cliquer ci-dessous va le
            déchiffrer dans ton navigateur et le détruire côté serveur.{" "}
            <strong>Tu ne pourras le voir qu&apos;une fois.</strong>
          </p>
          <button
            type="button"
            onClick={() => reveal(status.key)}
            disabled={pending}
            className="btn btn-primary"
            style={{
              marginTop: 6,
              padding: "11px 16px",
              justifyContent: "center",
            }}
          >
            {pending ? (
              "Déchiffrement…"
            ) : (
              <>
                <RiLockUnlockLine size={14} aria-hidden /> Révéler le contenu
              </>
            )}
          </button>
        </>
      )}

      {status.kind === "password_required" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!pwInput) return;
            reveal(status.key, pwInput);
          }}
          className="login-form"
        >
          <p className="help" style={{ textAlign: "center" }}>
            Ce partage est protégé par un mot de passe. Tu devrais l&apos;avoir
            reçu via un autre canal (SMS, appel, …).
          </p>
          <div className="field">
            <label>Mot de passe</label>
            <input
              type="password"
              required
              autoFocus
              value={pwInput}
              onChange={(e) => setPwInput(e.target.value)}
              autoComplete="off"
              className="input"
            />
            {status.lastError && (
              <p className="error-text" style={{ marginTop: 6 }}>
                {status.lastError}
                {status.attemptsRemaining !== null && (
                  <>
                    {" "}({status.attemptsRemaining} tentative
                    {status.attemptsRemaining === 1 ? "" : "s"} restante
                    {status.attemptsRemaining === 1 ? "" : "s"})
                  </>
                )}
              </p>
            )}
          </div>
          <button
            type="submit"
            disabled={pending || !pwInput}
            className="btn btn-primary"
            style={{
              marginTop: 6,
              padding: "11px 16px",
              justifyContent: "center",
            }}
          >
            {pending ? (
              "Vérification…"
            ) : (
              <>
                <RiLockUnlockLine size={14} aria-hidden /> Valider et révéler
              </>
            )}
          </button>
        </form>
      )}

      {status.kind === "revealed" && (
        <>
          {status.title && (
            <div className="help" style={{ textAlign: "center" }}>
              <strong>{status.title}</strong>
            </div>
          )}
          <p className="help" style={{ textAlign: "center" }}>
            Ce contenu ne sera plus jamais accessible via ce lien. Copie ou
            télécharge maintenant ce dont tu as besoin.
          </p>
          <div style={{ display: "grid", gap: 16 }}>
            {status.items.map((item, idx) =>
              item.type === "file" ? (
                <div key={idx}>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      marginBottom: 6,
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
                      {item.filename}
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        downloadFile(item.filename, item.content)
                      }
                      className="btn btn-primary btn-sm"
                    >
                      <RiDownloadLine size={14} aria-hidden /> Télécharger
                    </button>
                    <button
                      type="button"
                      onClick={() => copyContent(idx, item.content)}
                      className="btn btn-ghost btn-sm"
                    >
                      {copiedIdx === idx ? (
                        "✓ Copié"
                      ) : (
                        <>
                          <RiClipboardLine size={14} aria-hidden /> Copier
                        </>
                      )}
                    </button>
                  </div>
                  <pre
                    className="code-mono"
                    style={{
                      padding: "16px 18px",
                      background: "var(--code-bg)",
                      border: "1px solid var(--border)",
                      borderRadius: 10,
                      fontSize: 13,
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                      maxHeight: 240,
                      overflow: "auto",
                      margin: 0,
                    }}
                  >
                    {item.content}
                  </pre>
                </div>
              ) : (
                <div key={idx}>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      marginBottom: 6,
                    }}
                  >
                    {item.title && (
                      <strong style={{ flex: 1, fontSize: 13 }}>
                        {item.title}
                      </strong>
                    )}
                    <button
                      type="button"
                      onClick={() => copyContent(idx, item.content)}
                      className="btn btn-primary btn-sm"
                      style={{ marginLeft: "auto" }}
                    >
                      {copiedIdx === idx ? (
                        "✓ Copié"
                      ) : (
                        <>
                          <RiClipboardLine size={14} aria-hidden /> Copier
                        </>
                      )}
                    </button>
                  </div>
                  <pre
                    className="code-mono"
                    style={{
                      padding: "20px 22px",
                      background: "var(--code-bg)",
                      border: "1px solid var(--border)",
                      borderRadius: 10,
                      fontSize: 13,
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                      maxHeight: 400,
                      overflow: "auto",
                      margin: 0,
                    }}
                  >
                    {item.content}
                  </pre>
                </div>
              ),
            )}
          </div>
        </>
      )}

      {status.kind === "error" && (
        <p className="error-text" style={{ textAlign: "center" }}>
          {status.message}
        </p>
      )}
    </div>
  );
}
