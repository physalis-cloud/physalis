"use server";

import { hashPassword } from "@/lib/password-hash";
import { prisma } from "@/lib/prisma";
import { isValidClientSlug, isValidEmail } from "@/lib/validation";
import { rateLimit } from "@/lib/rate-limit";
import { headers } from "next/headers";
import { RESERVED_SIGNUP_SLUGS } from "@/lib/signup-reserved-slugs";

export type SignupResult =
  | { ok: true; slug: string; adminEmail: string }
  | { ok: false; error: string };

export async function signupTenant(
  _prev: SignupResult | null,
  formData: FormData,
): Promise<SignupResult> {
  if (process.env.ALLOW_REGISTRATION !== "true") {
    return { ok: false, error: "Les inscriptions sont désactivées." };
  }

  const reqHeaders = await headers();
  const fakeReq = new Request("http://localhost", { headers: reqHeaders });
  const limited = rateLimit(fakeReq, "signup", { max: 5, windowMs: 60 * 60_000 });
  if (limited) return { ok: false, error: "Trop de tentatives, réessayez dans une heure." };

  const name = String(formData.get("name") ?? "").trim();
  const slug = String(formData.get("slug") ?? "").trim().toLowerCase();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");

  if (!name || name.length > 255)
    return { ok: false, error: "Le nom est requis (1-255 caractères)." };
  if (!isValidClientSlug(slug))
    return { ok: false, error: "Slug invalide. Lowercase, alphanumérique et tirets, 1-50 caractères." };
  if (RESERVED_SIGNUP_SLUGS.has(slug))
    return { ok: false, error: `Le slug "${slug}" est réservé.` };
  if (!isValidEmail(email))
    return { ok: false, error: "Email invalide." };
  if (password.length < 12)
    return { ok: false, error: "Mot de passe de 12 caractères minimum requis." };

  const existing = await prisma.organization.findUnique({ where: { slug }, select: { id: true } });
  if (existing) return { ok: false, error: `Le slug "${slug}" est déjà utilisé.` };

  const emailExists = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (emailExists) return { ok: false, error: "Un compte existe déjà avec cet email." };

  const passwordHash = await hashPassword(password);

  await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: { email, password: passwordHash, role: "MEMBER" },
    });
    await tx.organization.create({
      data: {
        name,
        slug,
        members: { create: { userId: user.id, role: "OWNER" } },
      },
    });
  });

  return { ok: true, slug, adminEmail: email };
}
