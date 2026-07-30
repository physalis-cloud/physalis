// POST /api/plugin/auth
//
// Authentification de l'extension navigateur. Body : { email, password,
// totp, ttl? }. Retourne un sessionToken `sv_plugin_<hex>`
// valide PLUGIN_SESSION_TTL secondes (defaut 4h). Le token n'est PAS
// renouvelable — il faut re-saisir le TOTP a expiration.
//
// Architecture self-host single-tenant : le tenantSlug n'est plus requis.
//
// Securite :
//   - Aucune session NextAuth requise (cf. design decision #1) : l'extension
//     n'a pas de cookie partage avec le vault web.
//   - 2FA OBLIGATOIRE : si l'utilisateur n'a pas active sa 2FA, on refuse
//     explicitement avec un message demandant l'activation.
//   - Rate-limit : 5 tentatives / 15 min / IP (meme pression qu'un login web).
//   - Audit `PLUGIN_AUTH_SUCCESS` / `PLUGIN_AUTH_FAILURE`.
//   - CORS strict via `PLUGIN_ALLOWED_ORIGIN` (cf. lib/plugin-cors.ts).

import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { decrypt } from "@/lib/crypto";
import { verifyTotp, findBackupCodeIndex, consumeTotpTimeStep } from "@/lib/totp";
import {
  generatePluginToken,
  hashPluginToken,
  getPluginSessionTtl,
  isAllowedTtl,
  ALLOWED_TTLS,
} from "@/lib/plugin-token";
import {
  checkPluginOrigin,
  preflightResponse,
  withCors,
} from "@/lib/plugin-cors";
import { rateLimit } from "@/lib/rate-limit";
import { readJson, isValidEmail } from "@/lib/api";
import { logAction } from "@/lib/audit";

export const runtime = "nodejs";

const RATE_LIMIT = { max: 5, windowMs: 15 * 60_000 };

export async function OPTIONS(req: Request) {
  return preflightResponse(req);
}

export async function POST(req: Request) {
  const cors = checkPluginOrigin(req);
  if (!cors.ok) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const allowOrigin = cors.allowOrigin;

  const limited = rateLimit(req, "plugin-auth", RATE_LIMIT);
  if (limited) return withCors(limited, allowOrigin);

  const body = (await readJson(req)) as
    | {
        email?: string;
        password?: string;
        totp?: string;
        tenantSlug?: string;
        ttl?: number;
      }
    | null;
  if (
    !body ||
    typeof body.email !== "string" ||
    typeof body.password !== "string" ||
    typeof body.totp !== "string"
  ) {
    return withCors(
      NextResponse.json(
        { error: "email, password and totp are required" },
        { status: 400 },
      ),
      allowOrigin,
    );
  }

  const email = body.email.trim().toLowerCase();
  const password = body.password;
  const totp = body.totp.trim();

  if (!isValidEmail(email)) {
    return withCors(
      NextResponse.json({ error: "Invalid email" }, { status: 400 }),
      allowOrigin,
    );
  }

  // TTL : si l'extension demande une duree explicite, doit appartenir a
  // la liste fermee ALLOWED_TTLS (1h / 4h / 8h). Sinon → defaut env.
  let ttlSeconds = getPluginSessionTtl();
  if (body.ttl !== undefined) {
    if (!isAllowedTtl(body.ttl)) {
      return withCors(
        NextResponse.json(
          {
            error: `ttl must be one of: ${ALLOWED_TTLS.join(", ")} (seconds)`,
          },
          { status: 400 },
        ),
        allowOrigin,
      );
    }
    ttlSeconds = body.ttl;
  }

  type AuthFailure = {
    reason: string;
    httpStatus: number;
    errorBody: { error: string; reason?: string };
    actor: "anonymous" | { userId: string; email: string };
    organizationId: string | null;
  };
  type AuthSuccess = {
    user: { id: string; email: string };
    organizationId: string | null;
    pluginTokenId: string;
    acceptedVia: "totp" | "backup";
  };

  const userAgent = req.headers.get("user-agent")?.slice(0, 500) ?? null;
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
  const token = generatePluginToken();
  const tokenHash = hashPluginToken(token);

  const result: AuthFailure | AuthSuccess = await prisma.$transaction(
    async (tx) => {
      const user = await tx.user.findUnique({
        where: { email },
        include: {
          organizations: {
            select: { organizationId: true },
            orderBy: { createdAt: "asc" },
            take: 1,
          },
        },
      });
      const primaryOrgId = user?.organizations[0]?.organizationId ?? null;

      if (!user) {
        return {
          reason: "user_not_found",
          httpStatus: 401,
          errorBody: { error: "Invalid credentials" },
          actor: "anonymous",
          organizationId: null,
        } satisfies AuthFailure;
      }

      // password nullable (user invité/SSO sans mot de passe Physalis) → refus.
      const passwordOk = user.password
        ? await bcrypt.compare(password, user.password)
        : false;
      if (!passwordOk) {
        return {
          reason: "invalid_password",
          httpStatus: 401,
          errorBody: { error: "Invalid credentials" },
          actor: "anonymous",
          organizationId: primaryOrgId,
        } satisfies AuthFailure;
      }

      // 2FA OBLIGATOIRE pour le plugin (decision #4 de la spec).
      if (!user.twoFactorEnabled) {
        return {
          reason: "2fa_not_enabled",
          httpStatus: 403,
          errorBody: {
            error:
              "Plugin requires 2FA. Enable 2FA in /settings/security first, then retry.",
            reason: "2fa_required_setup",
          },
          actor: { userId: user.id, email: user.email },
          organizationId: primaryOrgId,
        } satisfies AuthFailure;
      }

      if (!user.twoFactorSecret || !user.twoFactorIv || !user.twoFactorTag) {
        return {
          reason: "2fa_state_inconsistent",
          httpStatus: 500,
          errorBody: { error: "2FA misconfigured" },
          actor: "anonymous",
          organizationId: primaryOrgId,
        } satisfies AuthFailure;
      }

      const secretPlain = decrypt({
        encryptedValue: user.twoFactorSecret,
        iv: user.twoFactorIv,
        tag: user.twoFactorTag,
      });

      let acceptedVia: "totp" | "backup" | null = null;
      // §2.17 — anti-rejeu TOTP (afterTimeStep + CAS atomique).
      const totpRes = await verifyTotp(totp, secretPlain, user.lastTotpTimeStep);
      if (
        totpRes.valid &&
        totpRes.timeStep != null &&
        (await consumeTotpTimeStep(
          (a) => tx.user.updateMany(a),
          user.id,
          totpRes.timeStep,
        ))
      ) {
        acceptedVia = "totp";
      } else {
        const idx = await findBackupCodeIndex(totp, user.backupCodes);
        if (idx >= 0) {
          // §2.20c — consommation ATOMIQUE (array_remove) au lieu du
          // read-modify-write (course entre deux codes différents concurrents).
          await tx.$executeRaw`UPDATE "User" SET "backupCodes" = array_remove("backupCodes", ${user.backupCodes[idx]}) WHERE "id" = ${user.id}`;
          acceptedVia = "backup";
        }
      }

      if (!acceptedVia) {
        return {
          reason: "invalid_totp",
          httpStatus: 401,
          errorBody: { error: "Invalid TOTP" },
          actor: { userId: user.id, email: user.email },
          organizationId: primaryOrgId,
        } satisfies AuthFailure;
      }

      const created = await tx.pluginToken.create({
        data: {
          tokenHash,
          userId: user.id,
          expiresAt,
          userAgent,
        },
        select: { id: true },
      });

      return {
        user: { id: user.id, email: user.email },
        organizationId: primaryOrgId,
        pluginTokenId: created.id,
        acceptedVia,
      } satisfies AuthSuccess;
    },
  );

  if ("reason" in result) {
    logAction({
      action: "PLUGIN_AUTH_FAILURE",
      actor:
        result.actor === "anonymous"
          ? { kind: "anonymous" }
          : { kind: "user", userId: result.actor.userId, email: result.actor.email },
      organizationId: result.organizationId,
      metadata: { reason: result.reason, email },
      req,
    });
    return withCors(
      NextResponse.json(result.errorBody, { status: result.httpStatus }),
      allowOrigin,
    );
  }

  if (result.acceptedVia === "backup") {
    logAction({
      action: "BACKUP_CODE_USED",
      actor: { kind: "user", userId: result.user.id, email: result.user.email },
      organizationId: result.organizationId,
      metadata: { source: "plugin" },
      req,
    });
  }

  const ttlSource: "body" | "env" = body.ttl !== undefined ? "body" : "env";
  logAction({
    action: "PLUGIN_AUTH_SUCCESS",
    actor: { kind: "user", userId: result.user.id, email: result.user.email },
    organizationId: result.organizationId,
    targetType: "PluginToken",
    targetId: result.pluginTokenId,
    metadata: {
      acceptedVia: result.acceptedVia,
      ttlSeconds,
      ttlSource,
    },
    req,
  });

  return withCors(
    NextResponse.json({
      sessionToken: token,
      expiresAt: Math.floor(expiresAt.getTime() / 1000),
    }),
    allowOrigin,
  );
}
