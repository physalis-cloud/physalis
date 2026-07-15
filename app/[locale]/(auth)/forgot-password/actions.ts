"use server";

import { headers } from "next/headers";
import { rateLimit } from "@/lib/rate-limit";
import { isValidEmail } from "@/lib/validation";
import { prisma } from "@/lib/prisma";
import { createResetToken } from "@/lib/password-reset";
import { sendPasswordResetEmail } from "@/lib/email";

export type ForgotResult = { ok: true } | { ok: false; error: string };

export async function requestPasswordReset(
  _prev: ForgotResult | null,
  formData: FormData,
): Promise<ForgotResult> {
  const reqHeaders = await headers();
  const fakeReq = new Request("http://localhost", { headers: reqHeaders });
  const limited = rateLimit(fakeReq, "forgot-password", {
    max: 5,
    windowMs: 60 * 60_000,
  });
  if (limited) {
    return {
      ok: false,
      error: "Trop de tentatives, réessayez dans une heure.",
    };
  }

  const email = String(formData.get("email") ?? "")
    .trim()
    .toLowerCase();
  if (!isValidEmail(email)) {
    return { ok: false, error: "Email invalide." };
  }

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true },
  });

  if (user) {
    try {
      const token = await createResetToken({
        tenantSlug: null,
        userId: user.id,
        email: user.email,
      });

      // PHYSALIS_URL prioritaire (cf. lib/app-url) ; fallback NEXTAUTH_URL pour
      // rétro-compat. Chaîne inline car l'overlay self-host est un build séparé.
      const baseUrl = (
        process.env.PHYSALIS_URL ??
        process.env.NEXTAUTH_URL ??
        "http://localhost:3000"
      ).replace(/\/$/, "");
      const resetUrl = `${baseUrl}/reset-password/${token}`;

      await sendPasswordResetEmail({
        to: user.email,
        resetUrl,
        expiresAt: new Date(Date.now() + 60 * 60_000),
      });
    } catch (err) {
      console.error("[forgot-password] failed to send reset email:", err);
    }
  }

  return { ok: true };
}
