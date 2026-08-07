import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { auth } from "./auth";
import { prisma } from "./prisma";
import type { OrgRole, ProjectRole, Role } from "@prisma/client";
import { isPlatformAdmin } from "./roles";

// `accessibleProjectsWhere` vit désormais dans lib/project-access.ts, aux côtés
// des deux autres formes des mêmes règles (rôle effectif, filtre mémoire) et de
// la matrice qui les force à s'accorder (§4). Ré-export pour ne pas casser les
// imports existants — il n'y a plus qu'UNE implémentation.
export { accessibleProjectsWhere } from "./project-access";
import { effectiveProjectRole, hasProjectRole } from "./project-access";

export type AuthedUser = {
  id: string;
  email: string;
  role: Role;
  /** #5 — instant d'émission du JWT (ms epoch), null si token legacy. */
  loginAt: number | null;
  /** §2.18 — origine de la session ("plugin_token" | "web" | null legacy). */
  origin: string | null;
};

const ORG_ROLE_RANK: Record<OrgRole, number> = {
  MEMBER: 1,
  DEV: 2,
  ADMIN_DEV: 3,
  ADMIN: 4,
  OWNER: 5,
};

export const CURRENT_ORG_COOKIE = "sv-current-org";

export async function requireUser(): Promise<
  { user: AuthedUser; tenantSlug: string | null } | { error: NextResponse }
> {
  const session = await auth();
  if (!session?.user?.id) {
    return {
      error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }

  const loginAt = session.user.loginAt ?? null;
  // #5 / §2.9 — invalidation de session (`User.sessionsValidFrom`, posé au reset
  // de mot de passe / désactivation 2FA) : la borne est désormais appliquée EN
  // AMONT, dans le callback `jwt` de lib/auth.ts — donc pour TOUT consommateur
  // de `auth()`, pages comprises, et plus seulement pour `requireUser`. Un token
  // révoqué arrive ici SANS `id` et tombe sur le 401 ci-dessus. NE PAS
  // réintroduire le check ici sans retirer celui du callback (double requête).

  return {
    user: {
      id: session.user.id,
      email: session.user.email ?? "",
      role: session.user.role,
      loginAt,
      origin: session.user.origin ?? null,
    },
    // Mono-tenant : pas de tenant. Champ porté à null pour que le code
    // SaaS coulé verbatim (qui lit `.tenantSlug`) compile sans overlay.
    tenantSlug: null as string | null,
  };
}

/**
 * Returns the slug of the user's "current" organization.
 *
 * Resolution: cookie `sv-current-org` if it points to an org the user is a
 * member of, otherwise the user's first org by creation date. Returns null
 * only if the user has no membership at all (which shouldn't happen — every
 * user gets an org on signup).
 */
export async function getCurrentOrgSlug(userId: string): Promise<string | null> {
  const jar = await cookies();
  const fromCookie = jar.get(CURRENT_ORG_COOKIE)?.value;

  if (fromCookie) {
    const ok = await prisma.orgMember.findFirst({
      where: { userId, organization: { slug: fromCookie } },
    });
    if (ok) return fromCookie;
  }

  const fallback = await prisma.orgMember.findFirst({
    where: { userId },
    include: { organization: { select: { slug: true } } },
    orderBy: { createdAt: "asc" },
  });
  return fallback?.organization.slug ?? null;
}

/**
 * Options communes à `requireOrgMember` / `requireProjectMember`.
 *
 * `feature` — dans la version SaaS, nom de la fonctionnalité que la route
 * consomme ; le helper y refuse l'accès si le plan du tenant ne la couvre pas.
 * En self-host il n'y a **ni plans ni tenants** : l'option est acceptée pour
 * que les routes coulées verbatim compilent, et volontairement IGNORÉE.
 *
 * Typée `string` (et non l'union `PlanFeature`) parce que `lib/plans.ts` est
 * denylisté du build public : l'union n'existe pas ici.
 */
export type AccessOptions = { feature?: string };

export async function requireOrgMember(
  slug: string,
  requiredRole: OrgRole = "MEMBER",
  _opts?: AccessOptions,
) {
  const userRes = await requireUser();
  if ("error" in userRes) return userRes;
  const { user } = userRes;

  const organization = await prisma.organization.findUnique({
    where: { slug },
    include: {
      members: { where: { userId: user.id } },
    },
  });
  if (!organization) {
    return {
      error: NextResponse.json({ error: "Not found" }, { status: 404 }),
    };
  }

  const membership = organization.members[0];
  // Global admin (ADMIN ou SUPERADMIN) = OWNER on every org.
  const effectiveRole: OrgRole | null = membership
    ? membership.role
    : isPlatformAdmin(user.role)
      ? "OWNER"
      : null;

  if (!effectiveRole || ORG_ROLE_RANK[effectiveRole] < ORG_ROLE_RANK[requiredRole]) {
    return {
      error: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    };
  }

  return { user, organization, role: effectiveRole, tenantSlug: null as string | null };
}

/**
 * Project access: a user has access to a project if they're either a project
 * member OR an org ADMIN/OWNER of the project's organization. Org ADMIN/OWNER
 * grants project OWNER-equivalent access (full R/W).
 */
export async function requireProjectMember(
  slug: string,
  requiredRole: ProjectRole = "VIEWER",
  _opts?: AccessOptions,
) {
  const userRes = await requireUser();
  if ("error" in userRes) return userRes;
  const { user } = userRes;

  const project = await prisma.project.findUnique({
    where: { slug },
    include: {
      members: { where: { userId: user.id } },
      organization: {
        include: { members: { where: { userId: user.id } } },
      },
    },
  });
  if (!project) {
    return {
      error: NextResponse.json({ error: "Not found" }, { status: 404 }),
    };
  }

  const projectMembership = project.members[0];
  const orgMembership = project.organization.members[0];
  const orgRole: OrgRole | null = orgMembership
    ? orgMembership.role
    : isPlatformAdmin(user.role)
      ? "OWNER"
      : null;

  // RBAC effectif — les 6 règles vivent dans lib/project-access.ts, avec les
  // deux autres formes des mêmes règles et la matrice qui les force à
  // s'accorder (§4). Ne PAS re-dériver ici.
  const effectiveRole = effectiveProjectRole({
    orgRole,
    membership: projectMembership ?? null,
  });

  if (!hasProjectRole(effectiveRole, requiredRole)) {
    return {
      error: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    };
  }

  return { user, project, role: effectiveRole, orgRole, tenantSlug: null as string | null };
}

export async function requireEnvironment(
  slug: string,
  envName: string,
  requiredRole: ProjectRole = "VIEWER",
  opts?: AccessOptions,
) {
  const access = await requireProjectMember(slug, requiredRole, opts);
  if ("error" in access) return access;

  const environment = await prisma.environment.findUnique({
    where: { projectId_name: { projectId: access.project.id, name: envName } },
  });
  if (!environment) {
    return {
      error: NextResponse.json({ error: "Not found" }, { status: 404 }),
    };
  }
  return { ...access, environment };
}

// Re-export des helpers de validation depuis lib/validation.ts (séparé pour
// permettre le test unitaire sans charger la stack NextAuth/Prisma).
export {
  slugify,
  isValidClientSlug,
  isValidSecretKey,
  isValidEnvName,
  isValidEmail,
  isValidServerName,
  isValidServerHost,
  isValidSshUser,
  isValidSshPrivateKey,
  isValidGithubRepo,
  isValidWorkflowFile,
  isValidGitBranch,
  defaultDeployPath,
  isValidDeployPath,
} from "./validation";

export async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}
