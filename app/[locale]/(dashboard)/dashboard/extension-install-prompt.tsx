"use client";

// Detection de l'extension Physalis sur le dashboard.
//
// Strategie : l'extension (content script) injecte un marqueur DOM sur le
// document du domaine vault et dispatche un CustomEvent
// `secretvault-extension-ready`. On cumule les deux mecanismes pour
// gerer la course :
//   - Le content script peut s'executer AVANT le mount du composant
//     (auquel cas le dataset est deja present, on le voit directement).
//   - Ou APRES (auquel cas l'event nous reveille).
//   - Si rien apres ~3s, on assume que l'extension n'est pas installee.

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import {
  RiChromeFill,
  RiExternalLinkLine,
  RiFirefoxFill,
  RiPuzzle2Line,
} from "@remixicon/react";

type Status = "checking" | "installed" | "not_installed";

const POLL_INTERVAL_MS = 500;
const POLL_MAX_ATTEMPTS = 6; // ~3s

export default function ExtensionInstallPrompt() {
  const t = useTranslations("dashboard.extension");
  const [status, setStatus] = useState<Status>("checking");
  const [version, setVersion] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    function getVersion(): string | null {
      return document.documentElement.dataset.secretvaultExt ?? null;
    }

    const v = getVersion();
    if (v) {
      setVersion(v);
      setStatus("installed");
      return;
    }

    const onReady = () => {
      setVersion(getVersion());
      setStatus("installed");
    };
    document.addEventListener(
      "secretvault-extension-ready",
      onReady as EventListener,
    );

    let attempts = 0;
    const timer = setInterval(() => {
      attempts++;
      const v2 = getVersion();
      if (v2) {
        setVersion(v2);
        setStatus("installed");
        clearInterval(timer);
      } else if (attempts >= POLL_MAX_ATTEMPTS) {
        setStatus("not_installed");
        clearInterval(timer);
      }
    }, POLL_INTERVAL_MS);

    return () => {
      clearInterval(timer);
      document.removeEventListener(
        "secretvault-extension-ready",
        onReady as EventListener,
      );
    };
  }, []);

  if (status === "installed") {
    // Ce bloc ne rend qu'apres le mount (status passe a "installed" dans un
    // effet), donc `navigator` est disponible : pas de risque d'hydratation.
    const storeVersion = STORE_VERSION[detectBrowser()];
    const hasUpdate =
      version != null &&
      storeVersion != null &&
      isVersionLower(version, storeVersion);
    return (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        <span style={{ fontSize: 12, color: "var(--muted)", display: "inline-flex", alignItems: "center", gap: 4 }}>
          <RiPuzzle2Line size={13} aria-hidden />
          {t("installed", { version: version ? ` v${version}` : "" })}
        </span>
        {hasUpdate && (
          <button
            type="button"
            onClick={() => setOpen(true)}
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: "var(--accent-text)",
              background: "var(--accent-bg)",
              border: "1px solid var(--accent-soft)",
              borderRadius: 99,
              padding: "2px 8px",
              cursor: "pointer",
            }}
          >
            {t("updateAvailable", { version: storeVersion })}
          </button>
        )}
      </span>
    );
  }

  if (status !== "not_installed") return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="btn btn-ghost"
      >
        <RiPuzzle2Line size={14} aria-hidden /> {t("installBtn")}
      </button>
      {open && <InstallModal onClose={() => setOpen(false)} />}
    </>
  );
}

type Browser = "chrome" | "firefox" | "other";

// Version REELLEMENT disponible sur chaque store — surtout pas celle du
// manifest. Les deux stores ne validant pas au meme rythme, une soumission en
// attente de revue ne doit pas etre annoncee : l'utilisateur verrait
// « v0.8.0 disponible » sans aucun moyen de l'installer.
//
// A bumper store par store, au moment ou la revue PASSE, pas a la soumission.
const STORE_VERSION: Record<Browser, string | null> = {
  chrome: "0.7.0", // 0.8.0 soumise, en attente de revue Chrome Web Store
  firefox: "0.8.0", // publiee sur AMO le 2026-08-06
  other: null, // navigateur non supporte → aucune mise a jour a annoncer
};

// L'extension est distribuee exclusivement par les stores officiels.
const CHROME_STORE_URL =
  "https://chromewebstore.google.com/detail/physalis/nkbdijmefoleebhonbfadecclaieolea";
const FIREFOX_STORE_URL =
  "https://addons.mozilla.org/firefox/addon/physalis-vault/";

function isVersionLower(a: string, b: string): boolean {
  const parse = (v: string) => v.split(".").map(Number);
  const [aMaj = 0, aMin = 0, aPatch = 0] = parse(a);
  const [bMaj = 0, bMin = 0, bPatch = 0] = parse(b);
  if (aMaj !== bMaj) return aMaj < bMaj;
  if (aMin !== bMin) return aMin < bMin;
  return aPatch < bPatch;
}

function detectBrowser(): Browser {
  if (typeof navigator === "undefined") return "other";
  const ua = navigator.userAgent;
  if (/Firefox\//.test(ua)) return "firefox";
  // Edge, Brave, Opera, Chrome — tous installent depuis le Chrome Web Store.
  if (/Chrome\//.test(ua)) return "chrome";
  return "other";
}

function StoreLink({
  browser,
  label,
  primary,
}: {
  browser: "chrome" | "firefox";
  label: string;
  primary: boolean;
}) {
  const Icon = browser === "chrome" ? RiChromeFill : RiFirefoxFill;
  return (
    <a
      href={browser === "chrome" ? CHROME_STORE_URL : FIREFOX_STORE_URL}
      target="_blank"
      rel="noopener noreferrer"
      className={primary ? "btn btn-primary" : "btn btn-ghost"}
    >
      <Icon size={14} aria-hidden /> {label}{" "}
      <RiExternalLinkLine size={12} aria-hidden />
    </a>
  );
}

function InstallModal({ onClose }: { onClose: () => void }) {
  const t = useTranslations("dashboard.extension");
  const browser = detectBrowser();
  const isChrome = browser === "chrome";
  const isFirefox = browser === "firefox";

  const title = isChrome
    ? t("chromeTitle")
    : isFirefox
      ? t("firefoxTitle")
      : t("genericTitle");

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div
        className="dialog dialog-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="dialog-header">
          <h2 className="dialog-title">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="dialog-close"
            aria-label={t("closeLabel")}
          >
            ✕
          </button>
        </div>

        <div className="dialog-body">
          <section>
            <p style={{ fontSize: 13, lineHeight: 1.6, margin: 0 }}>
              {t("featureIntro")}
            </p>
            <ul
              style={{
                paddingLeft: 18,
                margin: "8px 0 0",
                fontSize: 13,
                lineHeight: 1.7,
              }}
            >
              <li>{t.rich("feature1", { bold: (c) => <strong>{c}</strong> })}</li>
              <li>{t.rich("feature2", { bold: (c) => <strong>{c}</strong> })}</li>
              <li>{t("feature3")}</li>
            </ul>
          </section>

          <section style={{ borderTop: "1px solid var(--border)", paddingTop: 16 }}>
            <h3
              className="section-title"
              style={{ fontSize: 14, marginBottom: 10 }}
            >
              {t("installTitle")}
            </h3>
            <ol
              style={{
                paddingLeft: 22,
                margin: 0,
                fontSize: 13,
                lineHeight: 1.9,
              }}
            >
              {isChrome && (
                <li>
                  {t.rich("stepChromeStore", {
                    bold: (c) => <strong>{c}</strong>,
                  })}
                </li>
              )}
              {isFirefox && (
                <li>
                  {t.rich("stepFirefoxStore", {
                    bold: (c) => <strong>{c}</strong>,
                  })}
                </li>
              )}
              {!isChrome && !isFirefox && <li>{t("stepOther")}</li>}
              <li>{t("stepSignIn")}</li>
            </ol>

            <div
              style={{
                display: "flex",
                gap: 8,
                flexWrap: "wrap",
                marginTop: 16,
              }}
            >
              {!isFirefox && (
                <StoreLink
                  browser="chrome"
                  label={t("storeBtnChrome")}
                  primary={isChrome || browser === "other"}
                />
              )}
              {!isChrome && (
                <StoreLink
                  browser="firefox"
                  label={t("storeBtnFirefox")}
                  primary={isFirefox}
                />
              )}
            </div>
          </section>

          <section style={{ borderTop: "1px solid var(--border)", paddingTop: 16 }}>
            <h3
              className="section-title"
              style={{ fontSize: 14, marginBottom: 6 }}
            >
              {t("tipTitle")}
            </h3>
            <p className="help" style={{ margin: 0, lineHeight: 1.8 }}>
              {t.rich("tipContent", { bold: (c) => <strong>{c}</strong> })}
            </p>
          </section>
        </div>

        <div className="dialog-footer">
          <button
            type="button"
            onClick={onClose}
            className="btn btn-primary btn-sm"
          >
            {t("closeBtn")}
          </button>
        </div>
      </div>
    </div>
  );
}
