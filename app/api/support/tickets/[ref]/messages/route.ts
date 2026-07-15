import { NextResponse } from "next/server";
import { requireUser, readJson } from "@/lib/api";
import {
  supportConfigured,
  getTicket,
  replyTicket,
  ownsTicket,
  SupportError,
} from "@/lib/support";

type Params = { params: Promise<{ ref: string }> };

// POST /api/support/tickets/:ref/messages — réponse du user sur SON ticket.
export async function POST(req: Request, { params }: Params) {
  const userRes = await requireUser();
  if ("error" in userRes) return userRes.error;
  if (!supportConfigured()) {
    return NextResponse.json({ error: "support_unavailable" }, { status: 503 });
  }
  const { user } = userRes;
  const { ref } = await params;

  const body = (await readJson(req)) as { message?: string } | null;
  const message = body?.message?.trim() ?? "";
  if (message.length < 1) {
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }

  try {
    // Verifie la propriete avant d'autoriser la reponse.
    const { ticket } = await getTicket(ref);
    if (!ownsTicket(ticket, user)) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    const res = await replyTicket(ref, { message, userId: user.id, email: user.email });
    return NextResponse.json(res, { status: 201 });
  } catch (e) {
    if (e instanceof SupportError && e.status === 404) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    const status = e instanceof SupportError ? 502 : 500;
    return NextResponse.json({ error: "support_error" }, { status });
  }
}
