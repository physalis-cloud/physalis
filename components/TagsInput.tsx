"use client";

// Composant d'édition de tags techniques (Phase 11b).
//
// Réutilisé dans les dialogs Secret / Service / AppAccount. Permet :
//   - d'ajouter un tag avec Enter ou virgule
//   - de retirer un tag via le ✕ sur chaque chip
//   - normalisation côté client (lowercase, trim, dédupe)
//
// La validation finale (regex, longueur) est faite côté serveur via
// lib/tags.ts. Ici on est volontairement permissif pour ne pas bloquer
// l'UX — le serveur renvoie un 400 explicite si invalide.

import { useState } from "react";

// Deux politiques de casse selon le consommateur :
//  - `lowercase` (défaut) : tags normalisés minuscule côté serveur (secrets/
//    services/comptes, lib/tags.ts) → l'input force la minuscule.
//  - sinon : casse préservée (coffres perso/équipe, dont l'API garde la casse)
//    → on accepte A-Z et on ne minusculise pas.
const LOWER_RE = /^[a-z0-9][a-z0-9._-]{0,49}$/;
const MIXED_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,49}$/;

export default function TagsInput({
  value,
  onChange,
  placeholder = "+ tag",
  suggestions = [],
  lowercase = true,
  size = "sm",
}: {
  value: string[];
  onChange: (tags: string[]) => void;
  placeholder?: string;
  suggestions?: string[];
  /** Force la minuscule (défaut). `false` = casse préservée (coffres). */
  lowercase?: boolean;
  /** `sm` (défaut) : champ compact, historique. `md` : mêmes padding et
   *  taille de police que `.input`/`.select`, pour s'aligner sur eux quand
   *  les trois vivent sur une même `.form-row`. */
  size?: "sm" | "md";
}) {
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);

  function add(raw: string) {
    const trimmed = raw.trim();
    const t = lowercase ? trimmed.toLowerCase() : trimmed;
    if (!t) {
      setInput("");
      return;
    }
    if (!(lowercase ? LOWER_RE : MIXED_RE).test(t)) {
      setError(
        lowercase
          ? `Format invalide (a-z, 0-9, . _ - uniquement, ≤ 50 chars)`
          : `Format invalide (a-z, A-Z, 0-9, . _ - uniquement, ≤ 50 chars)`,
      );
      return;
    }
    // Dédup insensible à la casse (évite « App » + « app »).
    if (value.some((v) => v.toLowerCase() === t.toLowerCase())) {
      setInput("");
      return;
    }
    if (value.length >= 20) {
      setError("Maximum 20 tags");
      return;
    }
    onChange([...value, t]);
    setInput("");
    setError(null);
  }

  function remove(tag: string) {
    onChange(value.filter((t) => t !== tag));
  }

  // Suggestions = tags existants, filtrés par préfixe input. Comparaison
  // INSENSIBLE À LA CASSE des deux côtés : les tags historiques peuvent être en
  // casse mixte (`Prod`) alors que l'input est minuscule → sinon ils ne
  // matchaient jamais.
  const filteredSuggestions =
    input.length > 0
      ? suggestions
          .filter((s) => {
            const sl = s.toLowerCase();
            return (
              sl.startsWith(input.toLowerCase()) &&
              !value.some((v) => v.toLowerCase() === sl)
            );
          })
          .slice(0, 5)
      : [];

  return (
    <div>
      <div className="flex flex-wrap gap-1.5 items-center">
        {value.map((t) => (
          <span
            key={t}
            className="chip"
            style={{ display: "inline-flex", gap: 4, alignItems: "center" }}
          >
            {t}
            <button
              type="button"
              onClick={() => remove(t)}
              aria-label={`Retirer le tag ${t}`}
              style={{
                background: "none",
                border: "none",
                cursor: "pointer",
                padding: 0,
                fontSize: 12,
                color: "var(--text-muted)",
              }}
            >
              ×
            </button>
          </span>
        ))}
        {/* En `md` le champ occupe la largeur restante de sa colonne — sinon
            il reste à 140px et laisse un trou jusqu'au champ suivant. */}
        <div
          style={
            size === "md"
              ? { position: "relative", flex: "1 1 120px", minWidth: 0 }
              : { position: "relative" }
          }
        >
          <input
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === ",") {
                e.preventDefault();
                add(input);
              } else if (e.key === "Backspace" && !input && value.length > 0) {
                remove(value[value.length - 1]);
              }
            }}
            onBlur={() => {
              if (input) add(input);
            }}
            placeholder={placeholder}
            className="input"
            style={
              size === "md"
                ? { width: "100%" }
                : { width: 140, padding: "6px 10px", fontSize: 12 }
            }
          />
          {filteredSuggestions.length > 0 && (
            <div
              role="listbox"
              style={{
                position: "absolute",
                top: "100%",
                left: 0,
                marginTop: 2,
                minWidth: 140,
                background: "var(--surface, #1a1a1a)",
                border: "1px solid var(--border, rgba(255,255,255,0.1))",
                borderRadius: 4,
                padding: 4,
                zIndex: 10,
                boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
              }}
            >
              {filteredSuggestions.map((s) => (
                <button
                  key={s}
                  type="button"
                  role="option"
                  aria-selected={false}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    add(s);
                  }}
                  className="btn btn-ghost btn-sm"
                  style={{
                    width: "100%",
                    justifyContent: "flex-start",
                    padding: "4px 8px",
                    fontSize: 12,
                  }}
                >
                  {s}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      {error && (
        <p className="error-text" style={{ marginTop: 4, fontSize: 11 }}>
          {error}
        </p>
      )}
    </div>
  );
}
