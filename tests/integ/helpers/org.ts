// Helpers de seed pour les tests integ qui ont besoin d'une org + de membres.
// Mêmes conventions que access-revocation/role-change (INSERT SQL direct via
// le conteneur DB), factorisées pour les fichiers récents.

import { randomBytes, createHash } from "node:crypto";
import { execSql } from "./db";
import { TENANT_SCHEMA } from "./api";

/** Identifiant façon cuid (préfixe + hex) pour les INSERT directs. */
export function cuid(): string {
  return "ck" + randomBytes(11).toString("hex");
}

/** Crée une Organization + un OrgMember OWNER. Retourne l'id de l'org. */
export async function provisionOrg(slug: string, ownerId: string): Promise<string> {
  const id = cuid();
  await execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."Organization" (id, name, slug, "createdAt")
     VALUES ('${id}', '${slug}', '${slug}', NOW())`,
  );
  await execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."OrgMember" (id, "userId", "organizationId", role, "createdAt")
     VALUES ('${cuid()}', '${ownerId}', '${id}', 'OWNER', NOW())`,
  );
  return id;
}

/** Seed une Invitation email-based (pending). Retourne le token BRUT (pour
 *  appeler register-and-accept), le hash étant stocké en base. */
export async function seedInvitation(
  orgId: string,
  email: string,
  role: string,
  invitedById: string,
): Promise<string> {
  const token = "iv_" + randomBytes(32).toString("hex");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000)
    .toISOString()
    .replace("Z", "+00");
  await execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."Invitation" (id, email, "organizationId", role, "tokenHash", "expiresAt", "invitedById", "createdAt")
     VALUES ('${cuid()}', '${email}', '${orgId}', '${role}', '${tokenHash}', '${expiresAt}', '${invitedById}', NOW())`,
  );
  return token;
}
