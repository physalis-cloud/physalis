// GET /api/cli/device?code=ABCD-EFGH — page d'approbation (C-0050, phase 2).
//
// Session web requise. Rend ce qu'il faut pour que l'utilisateur reconnaisse
// SA demande avant de l'approuver : nom de l'appareil, IP, heure. Pour une
// demande « agent IA » (phase 2d), rend aussi ce que l'humain peut lui ouvrir :
// ses projets et leurs environnements de dev. Lecture seule
// (tests/lib/csrf-get-no-mutation).

import { NextResponse } from "next/server";
import { requireUser } from "@/lib/api";
import { cliTenantOfWebSession } from "@/lib/cli-tenant";
import { findPendingDevice, normalizeUserCode } from "@/lib/cli-session";
import { listAiSelectableProjects } from "@/lib/cli-ai-scope";

export async function GET(req: Request) {
  const userRes = await requireUser();
  if ("error" in userRes) return userRes.error;

  const tenant = cliTenantOfWebSession(userRes.tenantSlug);
  if (!tenant.ok) {
    return NextResponse.json({ error: tenant.error }, { status: tenant.status });
  }

  const userCode = normalizeUserCode(new URL(req.url).searchParams.get("code"));
  if (!userCode) {
    return NextResponse.json({ error: "invalid_code" }, { status: 400 });
  }

  const pending = await findPendingDevice(tenant.tenantSlug, userCode);
  if (!pending) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (pending.kind !== "AI") return NextResponse.json({ device: pending });

  const selectable = await listAiSelectableProjects(
    tenant.tenantSlug,
    userRes.user.id,
    userRes.user.role,
  );
  return NextResponse.json({
    device: pending,
    selectable: selectable.map(({ slug, name, environments }) => ({ slug, name, environments })),
  });
}
