"use client";

// Les morceaux de formulaire qui dépendent de la FORME d'une entrée de coffre
// (C-0047) — partagés entre le coffre personnel et le coffre d'équipe.
//
// ⚠️ **Partagés, et pas recopiés.** Le coffre d'équipe a gagné les quatre formes
// après le coffre personnel ; la voie facile était de dupliquer le sélecteur et
// les deux éditeurs dans `team-vault-panel.tsx`. Deux copies auraient divergé au
// premier ajustement — et ce qui diverge ici, ce n'est pas une marge : c'est ce
// que l'utilisateur croit être en train d'écrire, et la liste des conversions
// que l'écran lui propose.
//
// ⚠️ Ces composants sont PRÉSENTATIONNELS. Ils ne connaissent ni route, ni
// modèle, ni contrôle d'accès : l'état vit dans le panneau appelant, qui seul
// sait où il enregistre. C'est ce qui permet de les partager entre deux coffres
// dont les API n'ont rien en commun.
//
// ⚠️ Ils lisent le namespace `vault` — celui que les deux panneaux utilisent
// déjà pour leur dialogue d'entrée. Pas de clés nouvelles, donc pas de
// traduction muette dans l'une des trois langues.

import { useTranslations } from "next-intl";
import { RiFileTextLine, RiKey2Line, RiListCheck2 } from "@remixicon/react";
import { maskedInputProps } from "@/lib/masked-input";
import {
  VAULT_ENTRY_TYPES,
  VAULT_TYPE_LIMITS,
  conversionBlocker,
  type ConvertibleEntry,
  type VaultEntryType,
  type VaultListItem,
} from "@/lib/vault-entry-types";

/** Glyphe d'une entrée sans URL : un SECRET, une LIST ou une NOTE n'a pas de
 *  favicon à afficher, et deux initiales ne disent pas de quoi il s'agit. */
export function TypeGlyph({ type, size = 18 }: { type: VaultEntryType; size?: number }) {
  if (type === "LIST") return <RiListCheck2 size={size} aria-hidden />;
  if (type === "NOTE") return <RiFileTextLine size={size} aria-hidden />;
  return <RiKey2Line size={size} aria-hidden />;
}

/**
 * Sélecteur de forme de l'entrée.
 *
 * En création les quatre formes sont libres. En édition, seules les conversions
 * qui ne détruisent rien sont proposées — miroir client de `conversionBlocker`,
 * calculé sur les **métadonnées STOCKÉES** et pas sur l'état du formulaire,
 * puisque c'est la ligne en base que le serveur convertit.
 *
 * ⚠️ Conséquence à ne pas « corriger » : vider l'URL dans le formulaire ne
 * débloque pas la conversion tant qu'on n'a pas enregistré. Le serveur reste
 * l'autorité, et l'écran ne propose rien qu'il refuserait — une pastille
 * cliquable menant à un 409 serait pire qu'une pastille grisée qui dit pourquoi.
 */
export function TypeSwitcher({
  value,
  entry,
  onChange,
  disabled,
}: {
  value: VaultEntryType;
  /** L'entrée telle qu'elle est EN BASE, ou `null` en création. */
  entry: ConvertibleEntry | null;
  onChange: (next: VaultEntryType) => void;
  disabled?: boolean;
}) {
  const t = useTranslations("vault");
  return (
    // Pas de label : les quatre pastilles se lisent seules, et la phrase d'aide
    // sous le groupe dit déjà ce que fait le type sélectionné.
    <div className="field">
      <div className="flex flex-wrap gap-1.5" role="group">
        {VAULT_ENTRY_TYPES.map((candidate) => {
          const blocker = entry ? conversionBlocker(entry, candidate) : null;
          const locked = blocker !== null;
          const active = candidate === value;
          return (
            <button
              key={candidate}
              type="button"
              onClick={() => onChange(candidate)}
              disabled={disabled || locked}
              aria-pressed={active}
              title={locked ? t(`form.typeLocked.${blocker}`) : t(`types.${candidate}.hint`)}
              className={`chip chip-button ${active ? "active chip-active" : ""}`}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                // Un peu plus grandes que les pastilles de tags : c'est le
                // premier choix du formulaire, pas une étiquette.
                fontSize: 12.5,
                padding: "6px 12px",
                opacity: locked ? 0.45 : 1,
                cursor: locked ? "not-allowed" : "pointer",
              }}
            >
              <TypeGlyph type={candidate} size={13} />
              {t(`types.${candidate}.label`)}
            </button>
          );
        })}
      </div>
      <div className="help">{t(`types.${value}.hint`)}</div>
    </div>
  );
}

/**
 * L'éditeur d'items d'une LIST.
 *
 * ⚠️ Les valeurs sont MASQUÉES par défaut (`maskedInputProps`), comme un mot de
 * passe : une LIST porte des jeux de codes et des réponses à des questions
 * secrètes, pas des étiquettes. Le bouton de révélation est global à la liste —
 * un par ligne aurait fait dix gestes pour lire six champs.
 */
export function ItemsEditor({
  items,
  onChange,
  visible,
  onToggleVisible,
}: {
  items: VaultListItem[];
  onChange: (items: VaultListItem[]) => void;
  visible: boolean;
  onToggleVisible: () => void;
}) {
  const t = useTranslations("vault");
  const maj = (i: number, patch: Partial<VaultListItem>) =>
    onChange(items.map((it, k) => (k === i ? { ...it, ...patch } : it)));

  return (
    <div className="field">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <label style={{ margin: 0 }}>{t("form.itemsLabel")}</label>
        <button
          type="button"
          onClick={() => onChange([...items, { label: "", value: "" }])}
          disabled={items.length >= VAULT_TYPE_LIMITS.itemsMax}
          className="btn btn-ghost btn-xs"
        >
          {t("form.addItemBtn")}
        </button>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {items.map((item, i) => (
          <div key={i} className="flex items-center gap-2">
            <input
              name={`vault-entry-item-label-${i}`}
              autoComplete="off"
              value={item.label}
              onChange={(ev) => maj(i, { label: ev.target.value })}
              placeholder={t("form.itemLabelPlaceholder")}
              className="input"
              style={{ flex: "1 1 40%" }}
            />
            <input
              {...maskedInputProps(visible)}
              name={`vault-entry-item-${i}`}
              autoComplete="off"
              value={item.value}
              onChange={(ev) => maj(i, { value: ev.target.value })}
              placeholder={t("form.itemValuePlaceholder")}
              style={{ flex: "1 1 60%" }}
            />
            <button
              type="button"
              // ⚠️ Supprimer le DERNIER item laisse une ligne vierge plutôt
              // qu'un éditeur sans aucune ligne : sinon la liste se vide, et il
              // ne reste qu'un bouton « ajouter » là où l'utilisateur voulait
              // juste effacer une valeur. Un item vide est ignoré à
              // l'enregistrement (`validateListItems`), donc ça ne crée rien.
              onClick={() => {
                const reste = items.filter((_, k) => k !== i);
                onChange(reste.length > 0 ? reste : [{ label: "", value: "" }]);
              }}
              title={t("form.removeItemBtn")}
              aria-label={t("form.removeItemBtn")}
              className="btn btn-ghost btn-xs"
              // Même hauteur que les deux champs de la ligne.
              style={{ height: 42, flex: "0 0 auto", padding: "0 10px" }}
            >
              ✕
            </button>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2" style={{ marginTop: 4 }}>
        <button type="button" onClick={onToggleVisible} className="btn btn-ghost btn-xs">
          {visible ? t("hideBtn") : t("revealBtn")}
        </button>
        <span className="help">{t("form.itemsHint", { max: VAULT_TYPE_LIMITS.itemsMax })}</span>
      </div>
    </div>
  );
}

/** L'éditeur de texte d'une NOTE. */
export function NoteEditor({
  text,
  onChange,
}: {
  text: string;
  onChange: (text: string) => void;
}) {
  const t = useTranslations("vault");
  return (
    <div className="field vault-grow-field">
      <label>{t("form.textLabel")}</label>
      <textarea
        name="vault-entry-text"
        autoComplete="off"
        value={text}
        onChange={(e) => onChange(e.target.value)}
        rows={6}
        maxLength={VAULT_TYPE_LIMITS.noteTextMax}
        placeholder={t("form.textPlaceholder")}
        className="textarea"
      />
      <div className="help" style={{ marginTop: 4 }}>
        {t("form.textHint", { n: text.length, max: VAULT_TYPE_LIMITS.noteTextMax })}
      </div>
    </div>
  );
}
