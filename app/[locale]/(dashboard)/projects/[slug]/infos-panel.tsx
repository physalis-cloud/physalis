"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import type { ComponentProps, ReactNode } from "react";
import { useTranslations } from "next-intl";
import AccessPanel from "./access-panel";

// InfosPanel = l'onglet « Infos » (ex-Accès). Sous-onglets : Accès (le contenu
// actuel) + Readme/Technique/Sécurité (docs du repo, servies depuis le cache DB ;
// affichées seulement si le fichier existe). Refresh manuel + auto au deploy.
// + « Installation » (C-0051) en premier, tant que le guide est visible.

// Props publiques de l'onglet Infos : on retire les props « controllees » de
// AccessPanel (etat ajout / vide / readme), gerees ici et passees explicitement.
type Props = Omit<
  ComponentProps<typeof AccessPanel>,
  | "readmeHtml"
  | "addingService"
  | "setAddingService"
  | "addingAccount"
  | "setAddingAccount"
  | "onServicesEmptyChange"
  | "onAccountsEmptyChange"
> & {
  /** Guide d'installation déjà rendu (onglet « Installation », C-0051). Absent
   *  = guide masqué : pas de sous-onglet. Optionnel, le jumeau overlay de
   *  project-view.tsx ne le passe pas. */
  setup?: ReactNode;
};
type DocKind = "README" | "TECHNICAL" | "SECURITY";
type Doc = { kind: DocKind; html: string; fetchedAt: string };
type Sub = "setup" | "access" | DocKind;

const ROLE_RANK = { VIEWER: 1, EDITOR: 2, OWNER: 3 } as const;
const DOC_ORDER: DocKind[] = ["README", "TECHNICAL", "SECURITY"];

export default function InfosPanel({ setup, ...props }: Props) {
  const { slug, role } = props;
  const t = useTranslations("projects.infos");
  const tAccess = useTranslations("projects.access");
  const canEdit = ROLE_RANK[role] >= ROLE_RANK.EDITOR;

  // Tant que l'utilisateur n'a rien choisi, le défaut se RECALCULE : le guide
  // s'il est visible, sinon « Accès ». Un useState(défaut) figerait la valeur
  // du premier rendu, avant que le plan (useFeature) ne soit connu.
  const [chosen, setSub] = useState<Sub | null>(null);
  const preferred: Sub = chosen ?? (setup ? "setup" : "access");
  // Guide masqué entre-temps (paramètres, bouton « Masquer ») : on retombe sur
  // « Accès » plutôt que sur un contenu vide.
  const sub: Sub = preferred === "setup" && !setup ? "access" : preferred;
  const [docs, setDocs] = useState<Doc[]>([]);
  const [canRefresh, setCanRefresh] = useState(false);
  const [busy, startBusy] = useTransition();

  // Etat « ajout » des sections Services / Comptes remonte ici : quand une
  // section est vide, son bouton d'ajout est rendu dans la barre d'onglets
  // (a droite), sur la meme ligne que les onglets Acces / Readme / ...
  const [addingService, setAddingService] = useState(false);
  const [addingAccount, setAddingAccount] = useState(false);
  const [servicesEmpty, setServicesEmpty] = useState<boolean | null>(null);
  const [accountsEmpty, setAccountsEmpty] = useState<boolean | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/projects/${slug}/docs`);
    if (!res.ok) return;
    const d = (await res.json()) as { docs: Doc[]; canRefresh: boolean };
    setDocs(d.docs ?? []);
    setCanRefresh(Boolean(d.canRefresh));
  }, [slug]);

  useEffect(() => {
    load();
  }, [load]);

  function refresh() {
    startBusy(async () => {
      await fetch(`/api/projects/${slug}/docs/refresh`, { method: "POST" });
      await load();
    });
  }

  const has = (k: DocKind) => docs.some((d) => d.kind === k);
  const current =
    sub !== "access" && sub !== "setup" ? docs.find((d) => d.kind === sub) : null;
  const readmeHtml = docs.find((d) => d.kind === "README")?.html ?? null;

  // Bloc d'ajout rapide (sections Services/Comptes vides). Poussé tout à droite
  // via marginLeft:auto ; Rafraîchir ne prend la marge auto que s'il est seul
  // (sinon deux marges auto se partagent l'espace et créent un écart).
  const showQuickAdd =
    sub === "access" &&
    canEdit &&
    // Quand NI service NI compte : c'est l'EmptyCard (après Environnements) qui
    // porte les boutons d'ajout → on masque le quick-add du header.
    !(servicesEmpty === true && accountsEmpty === true) &&
    ((servicesEmpty === true && !addingService) ||
      (accountsEmpty === true && !addingAccount));

  return (
    <div className="flex flex-col gap-4">
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div className="subtab-bar" style={{ alignItems: "center" }}>
          {setup && (
            <button
              type="button"
              className={`subtab ${sub === "setup" ? "active" : ""}`}
              onClick={() => setSub("setup")}
            >
              {t("subtabs.setup")}
            </button>
          )}
          <button
            type="button"
            className={`subtab ${sub === "access" ? "active" : ""}`}
            onClick={() => setSub("access")}
          >
            {t("subtabs.access")}
          </button>
          {DOC_ORDER.filter(has).map((k) => (
            <button
              key={k}
              type="button"
              className={`subtab ${sub === k ? "active" : ""}`}
              onClick={() => setSub(k)}
            >
              {t(`subtabs.${k}`)}
            </button>
          ))}
          {canRefresh && canEdit && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={refresh}
              disabled={busy}
              title={t("refreshHint")}
            >
              {busy ? t("refreshing") : t("refresh")}
            </button>
          )}
        </div>

        {/* Boutons d'ajout rapide : HORS de la pastille d'onglets, poussés
            complètement à droite de la ligne d'en-tête. */}
        {showQuickAdd && (
          <div
            style={{
              marginLeft: "auto",
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            {servicesEmpty === true && !addingService && (
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => setAddingService(true)}
              >
                {tAccess("addService")}
              </button>
            )}
            {accountsEmpty === true && !addingAccount && (
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => setAddingAccount(true)}
              >
                {tAccess("addAccount")}
              </button>
            )}
          </div>
        )}
      </div>

      {sub === "setup" ? (
        setup
      ) : sub === "access" ? (
        <AccessPanel
          {...props}
          readmeHtml={readmeHtml}
          addingService={addingService}
          setAddingService={setAddingService}
          addingAccount={addingAccount}
          setAddingAccount={setAddingAccount}
          onServicesEmptyChange={setServicesEmpty}
          onAccountsEmptyChange={setAccountsEmpty}
        />
      ) : current ? (
        <article className="docs-prose" dangerouslySetInnerHTML={{ __html: current.html }} />
      ) : (
        <p className="help">{t("docEmpty")}</p>
      )}
    </div>
  );
}
