import { prisma } from "./prisma";
import { slugify } from "./api";

/**
 * Generates an organization slug that's unique in DB. If the candidate is
 * already taken, appends `-2`, `-3`, ... up to 50 tries.
 */
export async function uniqueOrgSlug(candidate: string): Promise<string> {
  const base = slugify(candidate) || "org";
  let slug = base;
  let n = 2;
  while (await prisma.organization.findUnique({ where: { slug } })) {
    slug = `${base}-${n}`;
    n += 1;
    if (n > 50) {
      slug = `${base}-${Date.now().toString(36)}`;
      break;
    }
  }
  return slug;
}

/**
 * Creates an organization and adds the given user as OWNER. Used at signup
 * and at admin bootstrap.
 *
 * Mono-tenant : contrairement au SaaS (où chaque signup = un nouveau schéma
 * tenant, donc exactement une org principale par schéma), `/api/auth/register`
 * peut être appelé plusieurs fois sur la même base. On ne marque `isPrimary`
 * que si AUCUNE org ne l'est déjà — la première org créée reste l'org
 * principale. Sans ce marqueur, aucune ligne n'est jamais `isPrimary` en
 * self-host : /account n'a plus de nom de compte à afficher et le garde-fou
 * de suppression d'org (app/api/orgs/[slug]/route.ts) ne se déclenche jamais.
 */
export async function createDefaultOrgForUser(params: {
  userId: string;
  userEmail: string;
}): Promise<{ id: string; slug: string }> {
  const handle = params.userEmail.split("@")[0] ?? "org";
  const slug = await uniqueOrgSlug(handle);
  const hasPrimary =
    (await prisma.organization.count({ where: { isPrimary: true } })) > 0;
  const org = await prisma.organization.create({
    data: {
      name: `${handle}'s organization`,
      slug,
      isPrimary: !hasPrimary,
      members: { create: { userId: params.userId, role: "OWNER" } },
    },
    select: { id: true, slug: true },
  });
  return org;
}
