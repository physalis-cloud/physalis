import { NextResponse } from "next/server";
import { requireUser } from "@/lib/api";
import { supportConfigured, getTicket, ownsTicket, SupportError } from "@/lib/support";

type Params = { params: Promise<{ ref: string }> };

// GET /api/support/tickets/:ref — détail d'un ticket appartenant au user.
export async function GET(_req: Request, { params }: Params) {
  const userRes = await requireUser();
  if ("error" in userRes) return userRes.error;
  if (!supportConfigured()) {
    return NextResponse.json({ error: "support_unavailable" }, { status: 503 });
  }
  const { user } = userRes;
  const { ref } = await params;

  try {
    const data = await getTicket(ref);
    // Garde-fou anti-énumération : on ne renvoie que les tickets du user.
    if (!ownsTicket(data.ticket, user)) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return NextResponse.json(data);
  } catch (e) {
    if (e instanceof SupportError && e.status === 404) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    const status = e instanceof SupportError ? 502 : 500;
    return NextResponse.json({ error: "support_error" }, { status });
  }
}
