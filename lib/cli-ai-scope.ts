// Périmètre d'une session « agent IA » — C-0050 (agent-ssh), phase 2d,
// scénario S4 du plan (Claude Code sous sa propre identité).
//
// Un humain approuve la session IA dans le navigateur et COCHE ce qu'elle peut
// lire : des couples (projet, environnement). Ce module garantit trois choses,
// côté serveur, qu'un client modifié ne peut pas contourner :
//
//   1. on ne peut cocher que ce que l'humain lit lui-même (mêmes helpers que
//      l'interface : lib/project-access.ts) ;
//   2. on ne peut cocher QUE des environnements de dev (lib/cli-env-policy.ts) :
//      jamais la production, jamais `staging` ;
//   3. à chaque lecture, le couple demandé doit être dans le périmètre. Les
//      droits de l'humain sont re-vérifiés EN PLUS (lib/cli-secrets.ts) : un
//      humain qui perd l'accès à un projet le retire aussi à son agent.
//
// Le périmètre est stocké par id de projet (un slug peut changer) ; le slug
// n'est gardé que pour l'affichage.

import type { Prisma } from "@prisma/client";
import { withTenantSchema } from "./tenant";
import { accessibleProjectsWhere, resolveOrgRole } from "./project-access";
import { isPullableEnvironment } from "./cli-env-policy";

export type AiScope = {
  projects: { projectId: string; slug: string; environments: string[] }[];
};

export type SelectableProject = {
  slug: string;
  name: string;
  environments: string[];
};

/** Garde le nombre de couples raisonnable : une session IA n'est pas un accès global. */
const MAX_SCOPE_PROJECTS = 50;

/** Relit un périmètre stocké (JSON). Tout ce qui n'a pas la forme attendue → null (refus). */
export function parseAiScope(raw: unknown): AiScope | null {
  if (!raw || typeof raw !== "object") return null;
  const projects = (raw as { projects?: unknown }).projects;
  if (!Array.isArray(projects)) return null;
  const out: AiScope["projects"] = [];
  for (const p of projects) {
    if (!p || typeof p !== "object") return null;
    const { projectId, slug, environments } = p as Record<string, unknown>;
    if (typeof projectId !== "string" || typeof slug !== "string" || !Array.isArray(environments)) {
      return null;
    }
    if (!environments.every((e) => typeof e === "string")) return null;
    out.push({ projectId, slug, environments: environments as string[] });
  }
  return { projects: out };
}

/**
 * Le couple (projet, environnement) est-il ouvert à cette session IA ?
 * L'environnement doit AUSSI être un environnement de dev : un périmètre
 * forgé en base avec `production` reste refusé.
 */
export function aiScopeAllows(scope: AiScope | null, projectId: string, envName: string): boolean {
  if (!scope || !isPullableEnvironment(envName)) return false;
  const entry = scope.projects.find((p) => p.projectId === projectId);
  return !!entry && entry.environments.includes(envName);
}

/** Ce que l'humain peut ouvrir à son agent : ses projets, leurs environnements de dev. */
export async function listAiSelectableProjects(
  tenantSlug: string | null,
  userId: string,
  platformRole: string,
): Promise<(SelectableProject & { id: string })[]> {
  return withTenantSchema(tenantSlug, async (tx) => {
    const memberships = await tx.orgMember.findMany({
      where: { userId },
      select: { organizationId: true, role: true },
    });
    const out: (SelectableProject & { id: string })[] = [];
    for (const m of memberships) {
      const orgRole = resolveOrgRole(m.role, platformRole);
      const projects = await tx.project.findMany({
        where: accessibleProjectsWhere(m.organizationId, userId, orgRole),
        select: {
          id: true,
          slug: true,
          name: true,
          environments: { select: { name: true }, orderBy: { name: "asc" } },
        },
        orderBy: { name: "asc" },
      });
      for (const p of projects) {
        const environments = p.environments.map((e) => e.name).filter(isPullableEnvironment);
        if (environments.length) {
          out.push({ id: p.id, slug: p.slug, name: p.name, environments });
        }
      }
    }
    return out;
  });
}

/**
 * Valide la sélection envoyée par la page d'approbation :
 * `[{ project: "<slug>", environments: ["development", …] }, …]`.
 * Chaque couple doit figurer dans `listAiSelectableProjects` — sinon refus
 * complet (on n'ouvre pas une partie en silence).
 */
export async function validateAiSelection(
  tenantSlug: string | null,
  userId: string,
  platformRole: string,
  selection: unknown,
): Promise<{ ok: true; scope: AiScope } | { ok: false; error: string }> {
  if (!Array.isArray(selection) || selection.length === 0) {
    return { ok: false, error: "empty_scope" };
  }
  if (selection.length > MAX_SCOPE_PROJECTS) return { ok: false, error: "scope_too_large" };

  const selectable = await listAiSelectableProjects(tenantSlug, userId, platformRole);
  const bySlug = new Map(selectable.map((p) => [p.slug, p]));
  const projects: AiScope["projects"] = [];
  const seen = new Set<string>();

  for (const item of selection) {
    const { project, environments } = (item ?? {}) as { project?: unknown; environments?: unknown };
    if (typeof project !== "string" || !Array.isArray(environments) || environments.length === 0) {
      return { ok: false, error: "invalid_scope" };
    }
    const allowed = bySlug.get(project);
    if (!allowed || seen.has(project)) return { ok: false, error: "invalid_scope" };
    seen.add(project);
    const envs = [...new Set(environments)];
    if (!envs.every((e) => typeof e === "string" && allowed.environments.includes(e))) {
      return { ok: false, error: "invalid_scope" };
    }
    projects.push({ projectId: allowed.id, slug: allowed.slug, environments: envs as string[] });
  }
  return { ok: true, scope: { projects } };
}

/** Forme stockable dans la colonne JSON `scope`. */
export function aiScopeToJson(scope: AiScope): Prisma.InputJsonValue {
  return scope as unknown as Prisma.InputJsonValue;
}
