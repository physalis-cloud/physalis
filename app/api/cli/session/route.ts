// DELETE /api/cli/session — `physalis logout` (C-0050, phase 2).
//
// Bearer `sv_cli_…` : la session se révoque elle-même. Toujours 204 pour un
// jeton valide ; 401 sinon (rien à révoquer, et on ne dit pas pourquoi).

import { NextResponse } from "next/server";
import { logAction } from "@/lib/audit";
import { validateCliSession, revokeCliSession } from "@/lib/cli-session";

export async function DELETE(req: Request) {
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const session = await validateCliSession(token);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const revoked = await revokeCliSession(session.tenantSlug, session.id);
  if (revoked) {
    logAction({
      action: "CLI_SESSION_REVOKED",
      actor: { kind: "user", userId: session.user.id, email: session.user.email },
      targetType: "CliSession",
      targetId: session.id,
      metadata: { via: "cli_logout", deviceName: session.deviceName },
      req,
      tenantSlug: session.tenantSlug,
    });
  }
  return new NextResponse(null, { status: 204 });
}
