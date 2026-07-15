"use client";

// Modale de confirmation générique, promise-based — remplace les window.confirm()
// natifs par une modale cohérente avec le reste de l'app (classes .dialog* /
// .btn* de globals.css).
//
// Usage :
//   const confirm = useConfirm();
//   if (!(await confirm({ message: t("deleteConfirm", { name }) }))) return;
//
// Le <ConfirmProvider> est monté une fois dans le layout dashboard. Le message
// est fourni déjà traduit par l'appelant ; seuls les libellés des boutons ont
// un défaut i18n (namespace "common.confirm"), surchargeables par option.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { useTranslations } from "next-intl";

export type ConfirmOptions = {
  /** Titre de la modale (défaut : "Confirmation"). */
  title?: string;
  /** Corps du message (déjà traduit). Les retours à la ligne sont préservés. */
  message: string;
  /** Libellé du bouton de validation (défaut : "Confirmer"). */
  confirmLabel?: string;
  /** Libellé du bouton d'annulation (défaut : "Annuler"). */
  cancelLabel?: string;
  /** Action destructive → bouton de validation en rouge. */
  danger?: boolean;
};

type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

/** Hook : retourne une fonction `confirm(opts) => Promise<boolean>`. */
export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext);
  if (!ctx) {
    throw new Error("useConfirm doit être utilisé dans un <ConfirmProvider>");
  }
  return ctx;
}

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const t = useTranslations("common.confirm");
  const [opts, setOpts] = useState<ConfirmOptions | null>(null);
  const resolver = useRef<((v: boolean) => void) | null>(null);

  const confirm = useCallback<ConfirmFn>((o) => {
    setOpts(o);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const close = useCallback((result: boolean) => {
    resolver.current?.(result);
    resolver.current = null;
    setOpts(null);
  }, []);

  // Échap = annuler.
  useEffect(() => {
    if (!opts) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [opts, close]);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {opts && (
        <div className="dialog-overlay" onClick={() => close(false)}>
          <div
            className="dialog"
            onClick={(e) => e.stopPropagation()}
            role="alertdialog"
            aria-modal="true"
            style={{ maxWidth: 440 }}
          >
            <div className="dialog-header">
              <h2 className="dialog-title">{opts.title ?? t("title")}</h2>
              <button
                type="button"
                onClick={() => close(false)}
                className="dialog-close"
                aria-label={opts.cancelLabel ?? t("cancel")}
              >
                ✕
              </button>
            </div>
            <div className="dialog-body">
              <p style={{ whiteSpace: "pre-line", margin: 0 }}>{opts.message}</p>
            </div>
            <div className="dialog-footer">
              <button
                type="button"
                onClick={() => close(false)}
                className="btn btn-ghost btn-sm"
                autoFocus
              >
                {opts.cancelLabel ?? t("cancel")}
              </button>
              <button
                type="button"
                onClick={() => close(true)}
                className={`btn btn-sm ${opts.danger ? "btn-danger" : "btn-primary"}`}
              >
                {opts.confirmLabel ?? t("confirm")}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}
