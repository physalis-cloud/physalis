// Déclaration minimale — @types/js-yaml absent. js-yaml v4 : `load` est le
// chargeur sûr (safeLoad déprécié).
declare module "js-yaml" {
  /** Schéma YAML. Opaque ici : on ne fait que le passer à `load`. */
  export type Schema = { readonly __schema: unique symbol };

  /**
   * Schéma « core » : null, booléens, entiers, flottants, chaînes — et RIEN
   * d'autre. En particulier **pas de type `timestamp`**, contrairement au
   * schéma par défaut.
   *
   * C'est ce qui nous intéresse pour le frontmatter des tâches : le schéma par
   * défaut convertit `verified: 2026-08-07` en objet Date, ce qui faisait
   * silencieusement disparaître toutes les dates non quotées du corpus.
   */
  export const CORE_SCHEMA: Schema;
  /** Schéma par défaut, avec `timestamp`. Conservé pour compose-*.ts. */
  export const DEFAULT_SCHEMA: Schema;
  export const JSON_SCHEMA: Schema;
  export const FAILSAFE_SCHEMA: Schema;

  // Options volontairement OUVERTES : `dump` reçoit aussi `lineWidth` dans
  // compose-merge.ts, et d'autres clés existent (indent, noRefs, sortKeys…).
  // Typer seulement `schema` et fermer le reste casserait des appels valides —
  // ce qui est arrivé à la première rédaction de ce fichier.
  type Options = { schema?: Schema; [key: string]: unknown };

  export function load(input: string, options?: Options): unknown;
  export function dump(obj: unknown, options?: Options): string;
}
