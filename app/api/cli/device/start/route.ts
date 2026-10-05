// POST /api/cli/device/start — `physalis login`, étape 1 (C-0050, phase 2).
//
// Sans authentification : ouvre une demande de connexion PENDING et rend le
// code appareil (gardé par la CLI) et le code court (affiché à l'utilisateur,
// qui l'approuve dans le navigateur). Contrat : physalis-cli/src/device.ts.
// Le tenant se lit sur l'hôte (lib/cli-tenant.ts).

import { NextResponse } from "next/server";
import { rateLimit, getClientIp } from "@/lib/rate-limit";
import { resolveCliTenant } from "@/lib/cli-tenant";
import { startDeviceAuthorization } from "@/lib/cli-session";
import { originePubliqueDesEnTetes } from "@/lib/origine-publique";

export async function POST(req: Request) {
  const limited = rateLimit(req, "cli-device-start", { max: 10, windowMs: 15 * 60_000 });
  if (limited) return limited;

  const body = (await req.json().catch(() => null)) as
    | { deviceName?: unknown; kind?: unknown; tenantSlug?: unknown }
    | null;

  const tenant = await resolveCliTenant(req, body?.tenantSlug);
  if (!tenant.ok) {
    return NextResponse.json({ error: tenant.error }, { status: tenant.status });
  }

  const started = await startDeviceAuthorization(tenant.tenantSlug, {
    deviceName: body?.deviceName,
    kind: body?.kind,
    userAgent: req.headers.get("user-agent"),
    ip: getClientIp(req),
  });

  const origin = originePubliqueDesEnTetes(req.headers) ?? new URL(req.url).origin;
  const verificationUri = `${origin}/account/cli`;
  return NextResponse.json({
    deviceCode: started.deviceCode,
    userCode: started.userCode,
    verificationUri,
    verificationUriComplete: `${verificationUri}?code=${encodeURIComponent(started.userCode)}`,
    expiresIn: started.expiresIn,
    interval: started.interval,
  });
}
