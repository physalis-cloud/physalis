import NextAuth, { CredentialsSignin } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { prisma } from "./prisma";
import { decrypt } from "./crypto";
import { findBackupCodeIndex, verifyTotp } from "./totp";
import { logAction } from "./audit";
import { authConfig } from "./auth.config";
import { resetRateLimit, rateLimit, getClientIp } from "./rate-limit";

class TwoFactorRequired extends CredentialsSignin {
  code = "2fa_required";
}
class TwoFactorInvalid extends CredentialsSignin {
  code = "2fa_invalid";
}

const DUMMY_BCRYPT_HASH = bcrypt.hashSync("dummy-anti-timing-attack-payload", 10);

async function rejectWithConstantTime(password: string): Promise<null> {
  await bcrypt.compare(password, DUMMY_BCRYPT_HASH);
  return null;
}

export const { handlers, signIn, signOut, auth } = NextAuth({
  ...authConfig,
  providers: [
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
        totpCode: { label: "TOTP", type: "text" },
      },
      authorize: async (credentials, request) => {
        const email = String(credentials?.email ?? "").toLowerCase().trim();
        const password = String(credentials?.password ?? "");
        const totpCode = String(credentials?.totpCode ?? "").trim();
        const req = request instanceof Request ? request : undefined;

        if (!email || !password) return null;

        // Rate-limit : 5 tentatives / 15 min / IP.
        if (req) {
          const limited = rateLimit(req, "login", { max: 5, windowMs: 15 * 60_000 });
          if (limited) return null;
        }

        const user = await prisma.user.findUnique({
          where: { email },
          include: {
            organizations: {
              orderBy: { createdAt: "asc" },
              take: 1,
              select: { organizationId: true },
            },
          },
        });

        if (!user) {
          logAction({
            action: "LOGIN_FAILURE",
            actor: { kind: "anonymous" },
            metadata: { reason: "user_not_found", email },
            req,
          });
          return rejectWithConstantTime(password);
        }

        // password nullable : un user invité/SSO peut n'avoir aucun mot de
        // passe Physalis → Credentials refuse (temps constant, pas d'oracle).
        if (!user.password) return rejectWithConstantTime(password);
        const ok = await bcrypt.compare(password, user.password);
        if (!ok) {
          logAction({
            action: "LOGIN_FAILURE",
            actor: { kind: "anonymous" },
            metadata: { reason: "invalid_password", email },
            req,
          });
          return null;
        }

        // Réinitialise le bucket rate-limit après succès credentials.
        if (req) resetRateLimit(req, "login");

        const primaryOrgId = user.organizations[0]?.organizationId ?? null;

        if (user.twoFactorEnabled) {
          if (!totpCode) throw new TwoFactorRequired();
          if (!user.twoFactorSecret || !user.twoFactorIv || !user.twoFactorTag) {
            throw new TwoFactorInvalid();
          }

          const secretPlain = decrypt({
            encryptedValue: user.twoFactorSecret,
            iv: user.twoFactorIv,
            tag: user.twoFactorTag,
          });

          let acceptedVia: "totp" | "backup" | null = null;
          if (await verifyTotp(totpCode, secretPlain)) {
            acceptedVia = "totp";
          } else {
            const idx = await findBackupCodeIndex(totpCode, user.backupCodes);
            if (idx >= 0) {
              const remaining = [...user.backupCodes];
              remaining.splice(idx, 1);
              await prisma.user.update({
                where: { id: user.id },
                data: { backupCodes: remaining },
                select: { id: true },
              });
              acceptedVia = "backup";
              logAction({
                action: "BACKUP_CODE_USED",
                actor: { kind: "user", userId: user.id, email: user.email },
                organizationId: primaryOrgId,
                metadata: { remaining: remaining.length },
                req,
              });
            }
          }

          if (!acceptedVia) {
            logAction({
              action: "TWO_FACTOR_FAILURE",
              actor: { kind: "anonymous" },
              organizationId: primaryOrgId,
              metadata: { reason: "invalid_totp_or_backup", email },
              req,
            });
            throw new TwoFactorInvalid();
          }

          logAction({
            action: "TWO_FACTOR_SUCCESS",
            actor: { kind: "user", userId: user.id, email: user.email },
            organizationId: primaryOrgId,
            metadata: { acceptedVia },
            req,
          });
        }

        logAction({
          action: "LOGIN_SUCCESS",
          actor: { kind: "user", userId: user.id, email: user.email },
          organizationId: primaryOrgId,
          metadata: { provider: "credentials", twoFactor: user.twoFactorEnabled },
          req,
        });

        return { id: user.id, email: user.email, role: user.role, tenantSlug: null };
      },
    }),
  ],
});
