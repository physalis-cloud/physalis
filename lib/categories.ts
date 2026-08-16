// Catégories de Secret — liste hardcodée + ordre d'affichage figé.
//
// L'ordre du tableau est l'ordre d'affichage dans la liste des secrets
// (groupé par catégorie). Les secrets sans catégorie (`category === null`)
// sont affichés en dernier sous le label `UNCATEGORIZED_LABEL`.
//
// La validation côté API n'autorise que les valeurs présentes dans
// `SECRET_CATEGORIES`. Pour ajouter une catégorie : l'ajouter ici à la
// position voulue, ajouter le label en accord, redéployer. Aucune
// migration DB nécessaire — le champ `Secret.category` est un text libre
// avec validation app-level.

export const SECRET_CATEGORIES = [
  "ports",
  "database",
  "auth",
  "services",
  "email",
  "infra",
  "application",
] as const;

export type SecretCategory = (typeof SECRET_CATEGORIES)[number];

export const SECRET_CATEGORY_LABELS: Record<SecretCategory, string> = {
  ports: "Ports",
  database: "Database",
  auth: "Auth",
  services: "Services",
  email: "Email",
  infra: "Infra",
  application: "Application",
};

export const UNCATEGORIZED_LABEL = "Sans catégorie";

export function isValidCategory(value: unknown): value is SecretCategory {
  return (
    typeof value === "string" &&
    (SECRET_CATEGORIES as readonly string[]).includes(value)
  );
}

// ─── Résolution d'un commentaire .env vers une catégorie ────────────
//
// L'export .env écrit un en-tête `# <slug>` par groupe (cf.
// app/api/.../secrets/export/route.ts) et `# Sans catégorie` pour les
// orphelins. L'import relit ces en-têtes pour ranger chaque clé.
//
// Règle d'or : un commentaire NON reconnu ne range rien (l'entrée
// retombe sur la catégorie par défaut choisie dans le dialogue). C'est
// ce qui permet d'ingérer n'importe quel .env du monde réel — plein de
// commentaires libres — sans inventer de rangement.

/** Résultat d'une résolution : une catégorie, "none" (le commentaire dit
 *  explicitement « sans catégorie »), ou null (non reconnu). */
export type CategoryHint = SecretCategory | "none";

// Alias acceptés, en forme normalisée (minuscules, sans accent). Les
// slugs eux-mêmes sont ajoutés automatiquement plus bas — inutile de les
// répéter ici (les labels FR sont identiques aux slugs à la casse près).
const CATEGORY_ALIASES: Record<string, CategoryHint> = {
  port: "ports",
  puertos: "ports",
  db: "database",
  bdd: "database",
  "base de donnees": "database",
  "base de datos": "database",
  postgres: "database",
  postgresql: "database",
  mysql: "database",
  authentification: "auth",
  authentication: "auth",
  autenticacion: "auth",
  service: "services",
  servicios: "services",
  "third party": "services",
  mail: "email",
  "e-mail": "email",
  correo: "email",
  smtp: "email",
  infrastructure: "infra",
  infraestructura: "infra",
  devops: "infra",
  app: "application",
  aplicacion: "application",
  "sans categorie": "none",
  "sans categories": "none",
  uncategorized: "none",
  "no category": "none",
  "sin categoria": "none",
  autres: "none",
  autre: "none",
  divers: "none",
  other: "none",
  misc: "none",
};

/** Minuscules, accents retirés, ponctuation décorative rognée aux deux
 *  bouts (`# --- Database --- :` → `database`), espaces compactés. */
function normalizeComment(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(new RegExp("[\\u0300-\\u036f]", "g"), "")
    .toLowerCase()
    .replace(/^[^a-z0-9]+/, "")
    .replace(/[^a-z0-9]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Traduit un commentaire de section en catégorie. Renvoie `null` si le
 *  commentaire n'évoque aucune catégorie connue. */
export function resolveCategoryFromComment(
  comment: string | undefined | null,
): CategoryHint | null {
  if (!comment) return null;
  const normalized = normalizeComment(comment);
  if (!normalized) return null;
  if ((SECRET_CATEGORIES as readonly string[]).includes(normalized)) {
    return normalized as SecretCategory;
  }
  return CATEGORY_ALIASES[normalized] ?? null;
}
