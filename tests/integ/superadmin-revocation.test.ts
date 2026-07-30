// §2.9-corollaire — Le SUPERADMIN plateforme (tenantSlug=null) était IRRÉVOCABLE :
// la borne `sessionsValidFrom` (le kill-switch des sessions) était enfermée dans
// `if (slug)` du callback jwt, or un SUPERADMIN porte `tenantSlug=null`. Et le
// layout /admin ne passe pas par requireUser — il lit `session.user.id`.
//
// Fix : le callback jwt applique aussi la borne au cas `tenantSlug=null`, via
// basePrisma (public.User) ; quand la session est révoquée, `session.user.id`
// devient undefined → le layout /admin (`if (!session?.user?.id)`) redirige.
//
// Cellule matrice §4bis : jwt_web × explicit_revoke (DERNIER trou).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { loginAs } from "./helpers/api";
import { execSql } from "./helpers/db";

const SUFFIX = `${Date.now()}`;
const SA_EMAIL = `superadmin-rev-${SUFFIX}@test.local`;
const SA_PW = "superadmin-pw-123456";
const SA_ID = "cksa" + randomBytes(10).toString("hex");
// Page SUPERADMIN (RSC) : rendue (200) si la session est valide, redirigée (3xx)
// vers /login si `session.user.id` a sauté.
const ADMIN_PATH = "/fr/admin";

beforeAll(async () => {
  const hash = bcrypt.hashSync(SA_PW, 10);
  await execSql(
    `INSERT INTO public."User" (id, email, password, role, "twoFactorEnabled", "createdAt")
     VALUES ('${SA_ID}', '${SA_EMAIL}', '${hash}', 'SUPERADMIN', false, NOW())`,
  );
});

afterAll(async () => {
  await execSql(`DELETE FROM public."User" WHERE id = '${SA_ID}'`).catch(() => {});
});

async function bumpSaSessionsValidFrom(): Promise<void> {
  // Postérieur au loginAt du JWT (émis avant, à la connexion) → invalide la session.
  await execSql(
    `UPDATE public."User" SET "sessionsValidFrom" = NOW() + interval '2 seconds' WHERE id = '${SA_ID}'`,
  );
}

describe("§2.9-corollaire — le SUPERADMIN est désormais révocable", () => {
  it("session SUPERADMIN valide → /admin rendu (pas de redirection login)", async () => {
    const sa = await loginAs(SA_EMAIL, SA_PW, undefined, null); // tenantSlug=null
    const res = await sa.fetch(ADMIN_PATH);
    // 200 = le layout a rendu (id présent, role SUPERADMIN, tenantSlug null).
    expect(res.status).toBe(200);
  });

  it("après bump sessionsValidFrom → la MÊME session est révoquée (redirigée hors /admin)", async () => {
    const sa = await loginAs(SA_EMAIL, SA_PW, undefined, null);
    // Sanity : accès avant révocation.
    expect((await sa.fetch(ADMIN_PATH)).status).toBe(200);
    // Révocation (ce que me/2fa ÉCRIT déjà pour un SUPERADMIN, mais qui
    // n'était pas APPLIQUÉ avant ce fix).
    await bumpSaSessionsValidFrom();
    const res = await sa.fetch(ADMIN_PATH);
    // session.user.id supprimé par le callback jwt → le layout redirige.
    // (307/308/302 selon Next ; l'essentiel : plus 200.)
    expect(res.status).not.toBe(200);
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);
  });
});
