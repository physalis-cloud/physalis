// Quels environnements une session CLI peut toucher « en dehors de la mémoire »
// — C-0050 (agent-ssh). Une seule liste, deux usages :
//   - `physalis pull` : les environnements dont un `.env` en clair peut être
//     écrit sur le poste (phase 2c, scénario S1) ;
//   - session « agent IA » : les seuls environnements qu'un humain peut ouvrir
//     à Claude Code (phase 2d, scénario S4 : jamais la production).

/**
 * Noms d'environnement dont un `.env` en clair peut être téléchargé
 * (`physalis pull`, scénario S1 du plan : hors-ligne, dev uniquement).
 *
 * LISTE FERMÉE, et pas une détection de « production » : un environnement n'a
 * qu'un nom libre (aucun marqueur en base), et un modèle de déploiement en
 * nomme déjà un `main`. Deviner la prod par son nom laisserait passer
 * `main`, `prd`, `live`… ; n'autoriser que des noms de dev ne laisse rien
 * passer par surprise. `staging` est refusé : il porte souvent des accès réels.
 * Même liste côté CLI (physalis-cli/src/commands/pull.ts).
 */
export const PULLABLE_ENV_NAMES: ReadonlySet<string> = new Set([
  "development",
  "dev",
  "local",
  "test",
  "testing",
  "sandbox",
]);

export function isPullableEnvironment(name: string): boolean {
  return PULLABLE_ENV_NAMES.has(name.trim().toLowerCase());
}

