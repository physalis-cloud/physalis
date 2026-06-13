import { createHash, randomBytes } from "crypto";
import { prisma } from "./prisma";

const TOKEN_PREFIX = "sv_";

export function generateToken(): string {
  return TOKEN_PREFIX + randomBytes(32).toString("hex");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Validation d'un machine token — version SELF-HOST (mono-DB).
 *
 * Pas de `token_index` (routage multi-tenant SaaS) ni de withTenantSchema :
 * base unique → lookup DIRECT dans MachineToken par hash.
 *
 * Retourne `{ ...machineToken, tenantSlug: null }` (tenantSlug conservé pour
 * compat de signature avec les callers ; null = schéma public).
 */
export async function validateToken(token: string) {
  if (!token.startsWith(TOKEN_PREFIX)) return null;
  const tokenHash = hashToken(token);

  const machineToken = await prisma.machineToken.findUnique({
    where: { tokenHash },
    include: { project: true, environment: true },
  });
  if (!machineToken || machineToken.revokedAt) return null;

  prisma.machineToken
    .update({
      where: { id: machineToken.id },
      data: { lastUsedAt: new Date() },
    })
    .catch((err) => console.error("Failed to update lastUsedAt", err));

  return { ...machineToken, tenantSlug: null };
}
