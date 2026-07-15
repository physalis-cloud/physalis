import { NextResponse } from "next/server";
import { requireUser, readJson } from "@/lib/api";
import {
  supportConfigured,
  createTicket,
  listTicketsByUser,
  SupportError,
} from "@/lib/support";

// GET /api/support/tickets — liste les tickets du user connecté.
export async function GET() {
  const userRes = await requireUser();
  if ("error" in userRes) return userRes.error;
  if (!supportConfigured()) {
    return NextResponse.json({ error: "support_unavailable" }, { status: 503 });
  }
  const { user } = userRes;

  try {
    const { tickets } = await listTicketsByUser(user.id);
    return NextResponse.json({ tickets });
  } catch (e) {
    const status = e instanceof SupportError ? 502 : 500;
    return NextResponse.json({ error: "support_error" }, { status });
  }
}

// POST /api/support/tickets — crée un ticket. Le sujet + le message viennent du
// client ; l'identité (email, user, tenant) vient de la SESSION (jamais du body).
export async function POST(req: Request) {
  const userRes = await requireUser();
  if ("error" in userRes) return userRes.error;
  if (!supportConfigured()) {
    return NextResponse.json({ error: "support_unavailable" }, { status: 503 });
  }
  const { user, tenantSlug } = userRes;

  const body = (await readJson(req)) as
    | { subject?: string; message?: string; locale?: string }
    | null;
  const subject = body?.subject?.trim() ?? "";
  const message = body?.message?.trim() ?? "";
  if (subject.length < 3 || message.length < 1) {
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }
  const locale = ["en", "fr", "es"].includes(body?.locale ?? "")
    ? body!.locale
    : undefined;

  try {
    const { ref } = await createTicket({
      subject,
      message,
      email: user.email,
      clientSlug: tenantSlug,
      userId: user.id,
      locale,
    });
    return NextResponse.json({ ref }, { status: 201 });
  } catch (e) {
    const status = e instanceof SupportError ? 502 : 500;
    return NextResponse.json({ error: "support_error" }, { status });
  }
}
