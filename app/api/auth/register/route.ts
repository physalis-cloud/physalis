import { NextResponse } from "next/server";
import { hashPassword } from "@/lib/password-hash";
// Register legacy : crée un user dans `public.User`. Pas de tenant context
// (le signup tenant passe par /signup → provisionClientSchema).
import { basePrisma as prisma } from "@/lib/prisma";
import { rateLimit } from "@/lib/rate-limit";
import { createDefaultOrgForUser } from "@/lib/orgs";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(req: Request) {
  // 3 / hour per IP — applied BEFORE the registration toggle check so an
  // attacker can't hammer the endpoint when registration is disabled.
  const limited = rateLimit(req, "register", {
    max: 3,
    windowMs: 60 * 60_000,
  });
  if (limited) return limited;

  if (process.env.ALLOW_REGISTRATION !== "true") {
    return NextResponse.json(
      { error: "Registration is disabled" },
      { status: 403 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { email, password } = (body as { email?: string; password?: string }) ?? {};
  const normalizedEmail = String(email ?? "").toLowerCase().trim();

  if (!EMAIL_RE.test(normalizedEmail)) {
    return NextResponse.json({ error: "Invalid email" }, { status: 400 });
  }
  if (!password || password.length < 12) {
    return NextResponse.json(
      { error: "Password must be at least 12 characters" },
      { status: 400 },
    );
  }

  const existing = await prisma.user.findUnique({
    where: { email: normalizedEmail },
  });
  if (existing) {
    return NextResponse.json(
      { error: "Email already registered" },
      { status: 409 },
    );
  }

  const hash = await hashPassword(password);
  const user = await prisma.user.create({
    data: { email: normalizedEmail, password: hash },
    select: { id: true, email: true, role: true },
  });

  // Auto-create the user's personal organization. They become OWNER.
  await createDefaultOrgForUser({
    userId: user.id,
    userEmail: normalizedEmail,
  });

  return NextResponse.json({ user }, { status: 201 });
}
