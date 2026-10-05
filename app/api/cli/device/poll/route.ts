// POST /api/cli/device/poll — `physalis login`, étape 3 (C-0050, phase 2).
//
// La CLI interroge avec son code appareil jusqu'à la décision. Réponses sur le
// modèle de RFC 8628 §3.5 : 400 + `authorization_pending` | `slow_down` |
// `access_denied` | `expired_token`, ou 200 + le jeton `sv_cli_…`, rendu UNE
// fois (la session est créée à ce poll-là, cf. lib/cli-session.ts).
// POST et pas GET : le poll modifie l'état (tests/lib/csrf-get-no-mutation).

import { NextResponse } from "next/server";
import { rateLimit, getClientIp } from "@/lib/rate-limit";
import { resolveCliTenant } from "@/lib/cli-tenant";
import { pollDevice } from "@/lib/cli-session";

const ERRORS = {
  pending: "authorization_pending",
  slow_down: "slow_down",
  denied: "access_denied",
  expired: "expired_token",
} as const;

export async function POST(req: Request) {
  // Au rythme annoncé (5 s), 10 minutes de demande = 120 polls.
  const limited = rateLimit(req, "cli-device-poll", { max: 150, windowMs: 10 * 60_000 });
  if (limited) return limited;

  const body = (await req.json().catch(() => null)) as
    | { deviceCode?: unknown; tenantSlug?: unknown }
    | null;
  const deviceCode = typeof body?.deviceCode === "string" ? body.deviceCode : "";
  if (!/^[0-9a-f]{64}$/.test(deviceCode)) {
    return NextResponse.json({ error: "expired_token" }, { status: 400 });
  }

  const tenant = await resolveCliTenant(req, body?.tenantSlug);
  if (!tenant.ok) {
    return NextResponse.json({ error: tenant.error }, { status: tenant.status });
  }

  const result = await pollDevice(tenant.tenantSlug, deviceCode, {
    userAgent: req.headers.get("user-agent"),
    ip: getClientIp(req),
  });

  if (result.status !== "approved") {
    return NextResponse.json({ error: ERRORS[result.status] }, { status: 400 });
  }
  return NextResponse.json({
    token: result.token,
    expiresAt: Math.floor(result.expiresAt.getTime() / 1000),
    email: result.email,
  });
}
