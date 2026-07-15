import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { auth } from "./auth";
import { prisma } from "./prisma";
import type { OrgRole, ProjectRole, Role } from "@prisma/client";
import { isPlatformAdmin, hasDevPrivileges } from "./roles";
import { isSessionInvalidated } from "./session-validity";

export type AuthedUser = {
  id: string;
  email: string;
  role: Role;
  /** #5 — instant d'émission du JWT (ms epoch), null si token legacy. */
  loginAt: number | null;
};

const ORG_ROLE_RANK: Record<OrgRole, number> = {
  MEMBER: 1,
  DEV: 2,
  ADMIN_DEV: 3,
  ADMIN: 4,
  OWNER: 5,
};

const PROJECT_ROLE_RANK: Record<ProjectRole, number> = {
  VIEWER: 1,
  EDITOR: 2,
  OWNER: 3,
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

  // #5 — invalidation de session : rejette un JWT émis AVANT que l'user ait
  // reset son mdp ou désactivé sa 2FA (User.sessionsValidFrom). `loginAt`
  // null = token legacy (émis avant l'introduction du champ) → on le laisse
  // vivre jusqu'à expiration naturelle.
  const loginAt = session.user.loginAt ?? null;
  if (loginAt != null) {
    const dbUser = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { sessionsValidFrom: true },
    });
    if (isSessionInvalidated(loginAt, dbUser?.sessionsValidFrom)) {
      return {
        error: NextResponse.json({ error: "Session expired" }, { status: 401 }),
      };
    }
  }

  return {
    user: {
      id: session.user.id,
      email: session.user.email ?? "",
      role: session.user.role,
      loginAt,
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

export async function requireOrgMember(
  slug: string,
  requiredRole: OrgRole = "MEMBER",
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

  // RBAC effectif (cf. ProjectMember dans schema.prisma) :
  //   1. Global ADMIN ou OrgADMIN/OWNER → OWNER (le hidden flag est ignore)
  //   2. ProjectMember.hidden=true → 403 (le projet est masque pour ce user)
  //   3. ProjectMember.hidden=false → role explicite
  //   4. Pas de row + OrgRole=DEV → EDITOR implicite
  //   5. Pas de row + OrgRole=MEMBER → 403 (le MEMBER doit être ajouté
  //      explicitement comme ProjectMember pour voir un projet)
  //   6. Pas OrgMember → 403
  let effectiveRole: ProjectRole | null = null;
  if (orgRole === "OWNER" || orgRole === "ADMIN") {
    effectiveRole = "OWNER";
  } else if (projectMembership) {
    if (projectMembership.hidden) {
      return {
        error: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
      };
    }
    effectiveRole = projectMembership.role;
  } else if (hasDevPrivileges(orgRole)) {
    effectiveRole = "EDITOR";
  }
  // MEMBER sans ProjectMember explicite → effectiveRole reste null → 403.

  if (!effectiveRole || PROJECT_ROLE_RANK[effectiveRole] < PROJECT_ROLE_RANK[requiredRole]) {
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
) {
  const access = await requireProjectMember(slug, requiredRole);
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
} from "./validation";

export async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}
