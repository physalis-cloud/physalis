import NextAuth, { CredentialsSignin } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { DUMMY_PASSWORD_HASH } from "./password-hash";
import { prisma } from "./prisma";
import { decrypt } from "./crypto";
import { findBackupCodeIndex, verifyTotp, consumeTotpTimeStep } from "./totp";
import { logAction } from "./audit";
import { isSessionInvalidated } from "./session-validity";
import { authConfig } from "./auth.config";
import { resetRateLimit, rateLimit } from "./rate-limit";

class TwoFactorRequired extends CredentialsSignin {
  code = "2fa_required";
}
class TwoFactorInvalid extends CredentialsSignin {
  code = "2fa_invalid";
}

// Rate-limit du login à deux étages — cf. §2.10. Mono-tenant : la clé du
// bucket compte est l'email seul (pas de tenantSlug ici).
const LOGIN_IP_LIMIT = { max: 30, windowMs: 15 * 60_000 };
const LOGIN_ACCOUNT_LIMIT = { max: 5, windowMs: 15 * 60_000 };
const LOGIN_ACCOUNT_SCOPE = "login:acct";

// Hash factice anti-timing : importé de lib/password-hash.ts pour porter le
// MÊME coût que les hashs réels (il était en coût 10 face à des hashs en coût
// 12 → ~225 ms d'écart, soit l'oracle que la mitigation devait effacer, cf.
// rapport-security.md F3.1). Ne pas ré-inliner un `hashSync` ici.
async function rejectWithConstantTime(password: string): Promise<null> {
  await bcrypt.compare(password, DUMMY_PASSWORD_HASH);
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

        // Rate-limit à deux étages (§2.10).
        // - IP : backstop anti-spraying, large (NAT partagé) et jamais resetté.
        // - Compte : le vrai frein au credential stuffing, resetté au seul
        //   login réussi de CE compte. Il n'existe aucun verrouillage en base.
        if (req) {
          const limited = rateLimit(req, "login", LOGIN_IP_LIMIT);
          if (limited) return null;
        }
        if (rateLimit(req, LOGIN_ACCOUNT_SCOPE, LOGIN_ACCOUNT_LIMIT, email)) {
          logAction({
            action: "LOGIN_FAILURE",
            actor: { kind: "anonymous" },
            metadata: { reason: "rate_limited_account", email },
            req,
          });
          return null;
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
          // §2.17 — anti-rejeu TOTP : afterTimeStep rejette un code déjà consommé,
          // le CAS atomique refuse une soumission concurrente du même pas.
          const totpRes = await verifyTotp(
            totpCode,
            secretPlain,
            user.lastTotpTimeStep,
          );
          if (
            totpRes.valid &&
            totpRes.timeStep != null &&
            (await consumeTotpTimeStep(
              (a) => prisma.user.updateMany(a),
              user.id,
              totpRes.timeStep,
            ))
          ) {
            acceptedVia = "totp";
          } else {
            const idx = await findBackupCodeIndex(totpCode, user.backupCodes);
            if (idx >= 0) {
              // §2.20c — consommation ATOMIQUE (array_remove) au lieu du
              // read-modify-write (course entre deux codes différents concurrents).
              await prisma.$executeRaw`UPDATE "User" SET "backupCodes" = array_remove("backupCodes", ${user.backupCodes[idx]}) WHERE "id" = ${user.id}`;
              acceptedVia = "backup";
              logAction({
                action: "BACKUP_CODE_USED",
                actor: { kind: "user", userId: user.id, email: user.email },
                organizationId: primaryOrgId,
                metadata: { remaining: user.backupCodes.length - 1 },
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

        // Reset scopé au compte, et APRÈS la 2FA : resetté avant, un mot de
        // passe valide suffisait à purger le compteur en boucle et à rendre le
        // second facteur devinable sans limite.
        resetRateLimit(req, LOGIN_ACCOUNT_SCOPE, email);

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
  callbacks: {
    ...authConfig.callbacks,
    // ── Révocation de session, centralisée (§2.9) ──────────────────────
    // `sessionsValidFrom` (posé au reset de mot de passe et à la désactivation
    // de la 2FA) n'était appliqué QUE dans `requireUser` — donc pas aux pages
    // du dashboard, qui consomment `auth()` en direct : un reset de mot de
    // passe n'évinçait pas réellement une session volée. On applique la borne
    // ICI, au seul point que TOUT consommateur de `auth()` traverse.
    //
    // Uniquement sur les LECTURES de session (`user` absent) : au sign-in le
    // token vient d'être émis, il ne peut pas précéder la borne. `loginAt`
    // null = token legacy (antérieur au champ) → laissé vivre jusqu'à son
    // expiration naturelle.
    //
    // Pas de `catch` volontairement : si la base est indisponible, l'app l'est
    // de toute façon — mieux vaut ça qu'un fail-open sur une garde de sécurité.
    async jwt(params) {
      const t = await authConfig.callbacks!.jwt!(params);
      if (!params.user && t) {
        const uid = typeof t.id === "string" ? t.id : null;
        const loginAt = typeof t.loginAt === "number" ? t.loginAt : null;
        if (uid && loginAt != null) {
          const dbUser = await prisma.user.findUnique({
            where: { id: uid },
            select: { sessionsValidFrom: true },
          });
          if (isSessionInvalidated(loginAt, dbUser?.sessionsValidFrom)) {
            // On retire l'identité du token : `session.user.id` devient
            // undefined et tout consommateur (`session?.user?.id`) voit une
            // session anonyme — pages comprises.
            delete (t as { id?: unknown }).id;
          }
        }
      }
      return t;
    },
  },
});
