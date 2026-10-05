// Session CLI par flux d'appareil — chantier C-0050 (agent-ssh), phase 2.
//
// Cycle de vie (contrat figé côté CLI dans physalis-cli/src/device.ts) :
//
//   1. POST /api/cli/device/start → une CliDeviceAuthorization PENDING. La CLI
//      reçoit le code appareil (on n'en garde que le hash) et affiche le code
//      court à l'utilisateur.
//   2. L'utilisateur, connecté dans le navigateur, ouvre /account/cli et
//      approuve ou refuse (status APPROVED | DENIED, userId posé).
//   3. POST /api/cli/device/poll → au premier poll après l'approbation, la
//      demande passe CONSUMED et la CliSession est créée DANS LA MÊME
//      TRANSACTION. Le jeton `sv_cli_…` n'existe qu'à cet instant et n'est
//      rendu qu'une fois ; seul son hash est stocké.
//   4. Bearer `sv_cli_…` → validateCliSession (révocation, expiration 12 h,
//      borne `sessionsValidFrom` : un reset de mot de passe coupe aussi la CLI).
//
// Pourquoi pas PluginToken : un PluginToken s'ÉCHANGE contre une session web
// (provider Credentials `pluginToken`). Une session CLI ne doit ouvrir que
// l'API, jamais le navigateur.
//
// Tout accès à la base passe par ce module (et `lib/cli-tenant.ts` pour le
// tenant) : les routes `/api/cli/*` n'appellent jamais withTenantSchema.

import { createHash, randomBytes, randomInt } from "crypto";
import type { Prisma } from "@prisma/client";
import { withTenantSchema } from "./tenant";
import { isSessionInvalidated } from "./session-validity";
import { tenantOfCliToken, indexCliToken } from "./cli-tenant";

export const CLI_TOKEN_PREFIX = "sv_cli_";
/** Durée d'une session CLI (scénario S3 du plan) : une approbation par jour. */
export const CLI_SESSION_TTL_SECONDS = 12 * 3600;
/** Durée de vie d'une demande de connexion non approuvée. */
export const DEVICE_CODE_TTL_SECONDS = 600;
/** Intervalle de poll annoncé à la CLI ; `slow_down` l'allonge de 5 s. */
export const DEVICE_POLL_INTERVAL_SECONDS = 5;

export type CliSessionKind = "HUMAN" | "AI";

// Code court : 8 lettres sans voyelles ni caractères ambigus (pas de mot
// involontaire, pas de 0/O ni 1/I). 20^8 ≈ 2,6·10^10 combinaisons, pour une
// demande qui vit 10 minutes derrière une session web authentifiée.
const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";

export function generateCliToken(): string {
  return CLI_TOKEN_PREFIX + randomBytes(32).toString("hex");
}

export function hashCliToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function isCliTokenFormat(value: string): boolean {
  return /^sv_cli_[0-9a-f]{64}$/.test(value);
}

export function generateDeviceCode(): string {
  return randomBytes(32).toString("hex");
}

export function generateUserCode(): string {
  let code = "";
  for (let i = 0; i < 8; i++) {
    code += USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)];
  }
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** `abcd efgh`, `ABCDEFGH`, `abcd-efgh` → `ABCD-EFGH` ; null si ce n'en est pas un. */
export function normalizeUserCode(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const letters = input.toUpperCase().replace(/[^A-Z]/g, "");
  if (letters.length !== 8) return null;
  for (const c of letters) if (!USER_CODE_ALPHABET.includes(c)) return null;
  return `${letters.slice(0, 4)}-${letters.slice(4)}`;
}

function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const v = value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max);
  return v || null;
}

// ─── 1. Démarrer ─────────────────────────────────────────────────────────────

export type DeviceStartInput = {
  deviceName: unknown;
  /** "AI" pour une session agent IA (phase 2d) ; tout le reste = "HUMAN". */
  kind?: unknown;
  userAgent: string | null;
  ip: string | null;
};

export async function startDeviceAuthorization(
  tenantSlug: string | null,
  input: DeviceStartInput,
  now: Date = new Date(),
): Promise<{ deviceCode: string; userCode: string; expiresIn: number; interval: number }> {
  const deviceCode = generateDeviceCode();
  const expiresAt = new Date(now.getTime() + DEVICE_CODE_TTL_SECONDS * 1000);

  // Collision de code court : improbable, mais l'index est UNIQUE. Trois essais.
  for (let attempt = 0; ; attempt++) {
    const userCode = generateUserCode();
    try {
      await withTenantSchema(tenantSlug, (tx) =>
        tx.cliDeviceAuthorization.create({
          data: {
            deviceCodeHash: hashCliToken(deviceCode),
            userCode,
            kind: input.kind === "AI" ? "AI" : "HUMAN",
            deviceName: cleanText(input.deviceName, 100),
            userAgent: input.userAgent?.slice(0, 500) ?? null,
            ip: input.ip,
            interval: DEVICE_POLL_INTERVAL_SECONDS,
            expiresAt,
          },
          select: { id: true },
        }),
      );
      return {
        deviceCode,
        userCode,
        expiresIn: DEVICE_CODE_TTL_SECONDS,
        interval: DEVICE_POLL_INTERVAL_SECONDS,
      };
    } catch (err) {
      if (attempt >= 2 || (err as { code?: string }).code !== "P2002") throw err;
    }
  }
}

// ─── 2. Approuver ou refuser (navigateur, session web) ───────────────────────

export type PendingDevice = {
  userCode: string;
  kind: CliSessionKind;
  deviceName: string | null;
  userAgent: string | null;
  ip: string | null;
  createdAt: Date;
  expiresAt: Date;
};

/** Ce que la page d'approbation montre, pour que l'utilisateur reconnaisse SA demande. */
export async function findPendingDevice(
  tenantSlug: string | null,
  userCode: string,
  now: Date = new Date(),
): Promise<PendingDevice | null> {
  const row = await withTenantSchema(tenantSlug, (tx) =>
    tx.cliDeviceAuthorization.findUnique({
      where: { userCode },
      select: {
        userCode: true,
        kind: true,
        deviceName: true,
        userAgent: true,
        ip: true,
        status: true,
        createdAt: true,
        expiresAt: true,
      },
    }),
  );
  if (!row) return null;
  const { status, kind, ...pending } = row;
  if (status !== "PENDING" || pending.expiresAt <= now) return null;
  return { ...pending, kind: kind === "AI" ? "AI" : "HUMAN" };
}

/**
 * Pose la décision. Ne touche qu'une demande PENDING et non expirée : une
 * demande déjà décidée ne se re-décide pas (ni se ré-attribue à un autre
 * utilisateur). Rend l'id de la demande, ou null si rien n'a été décidé.
 */
export async function decideDevice(
  tenantSlug: string | null,
  userCode: string,
  userId: string,
  approve: boolean,
  /** Session IA approuvée : le périmètre coché par l'humain (déjà validé). */
  scope: Prisma.InputJsonValue | null = null,
  now: Date = new Date(),
): Promise<{ id: string; deviceName: string | null; kind: CliSessionKind } | null> {
  return withTenantSchema(tenantSlug, async (tx) => {
    const row = await tx.cliDeviceAuthorization.findUnique({
      where: { userCode },
      select: { id: true, deviceName: true, kind: true },
    });
    if (!row) return null;
    const kind: CliSessionKind = row.kind === "AI" ? "AI" : "HUMAN";
    // Une session IA ne s'approuve JAMAIS sans périmètre : sans lui, elle
    // n'aurait accès à rien (refus à la lecture) — autant refuser ici.
    if (approve && kind === "AI" && !scope) return null;
    const { count } = await tx.cliDeviceAuthorization.updateMany({
      where: { id: row.id, status: "PENDING", expiresAt: { gt: now } },
      data: {
        status: approve ? "APPROVED" : "DENIED",
        userId,
        decidedAt: now,
        ...(approve && kind === "AI" && scope ? { scope } : {}),
      },
    });
    return count === 1 ? { id: row.id, deviceName: row.deviceName, kind } : null;
  });
}

// ─── 3. Poll (CLI) ───────────────────────────────────────────────────────────

export type PollResult =
  | { status: "pending" }
  | { status: "slow_down" }
  | { status: "denied" }
  | { status: "expired" }
  | {
      status: "approved";
      token: string;
      expiresAt: Date;
      sessionId: string;
      userId: string;
      email: string;
      deviceName: string | null;
    };

export async function pollDevice(
  tenantSlug: string | null,
  deviceCode: string,
  meta: { userAgent: string | null; ip: string | null },
  now: Date = new Date(),
): Promise<PollResult> {
  const result = await withTenantSchema(tenantSlug, async (tx): Promise<PollResult> => {
    const row = await tx.cliDeviceAuthorization.findUnique({
      where: { deviceCodeHash: hashCliToken(deviceCode) },
    });
    if (!row || row.status === "CONSUMED" || row.expiresAt <= now) {
      return { status: "expired" };
    }

    // Trop rapide : RFC 8628 §3.5, l'intervalle grandit de 5 s. Une seconde de
    // tolérance pour la gigue réseau.
    if (row.lastPolledAt && now.getTime() - row.lastPolledAt.getTime() < row.interval * 1000 - 1000) {
      await tx.cliDeviceAuthorization.update({
        where: { id: row.id },
        data: { interval: row.interval + 5, lastPolledAt: now },
      });
      return { status: "slow_down" };
    }

    if (row.status === "PENDING") {
      await tx.cliDeviceAuthorization.update({
        where: { id: row.id },
        data: { lastPolledAt: now },
      });
      return { status: "pending" };
    }
    if (row.status === "DENIED" || !row.userId) {
      await tx.cliDeviceAuthorization.update({
        where: { id: row.id },
        data: { status: "CONSUMED", lastPolledAt: now },
      });
      return { status: "denied" };
    }

    // APPROVED → CONSUMED, conditionnel : deux polls simultanés ne frappent
    // pas deux sessions.
    const { count } = await tx.cliDeviceAuthorization.updateMany({
      where: { id: row.id, status: "APPROVED" },
      data: { status: "CONSUMED", lastPolledAt: now },
    });
    if (count !== 1) return { status: "expired" };

    const user = await tx.user.findUnique({
      where: { id: row.userId },
      select: { id: true, email: true, deletionRequestedAt: true },
    });
    if (!user || user.deletionRequestedAt) return { status: "denied" };

    const token = generateCliToken();
    const expiresAt = new Date(now.getTime() + CLI_SESSION_TTL_SECONDS * 1000);
    const session = await tx.cliSession.create({
      data: {
        tokenHash: hashCliToken(token),
        userId: user.id,
        kind: row.kind,
        scope: row.scope ?? undefined,
        deviceName: row.deviceName,
        userAgent: meta.userAgent?.slice(0, 500) ?? row.userAgent,
        ip: meta.ip ?? row.ip,
        expiresAt,
      },
      select: { id: true },
    });
    return {
      status: "approved",
      token,
      expiresAt,
      sessionId: session.id,
      userId: user.id,
      email: user.email,
      deviceName: row.deviceName,
    };
  });

  if (result.status === "approved") {
    await indexCliToken(hashCliToken(result.token), tenantSlug);
  }
  return result;
}

// ─── 4. Valider un Bearer ────────────────────────────────────────────────────

export type ValidCliSession = {
  id: string;
  kind: CliSessionKind;
  scope: unknown;
  deviceName: string | null;
  expiresAt: Date;
  user: { id: string; email: string; role: string };
  tenantSlug: string | null;
};

/**
 * Résout un Bearer `sv_cli_…`. null si le format, l'index, la révocation,
 * l'expiration ou la borne `sessionsValidFrom` le refusent. Met `lastUsedAt` à
 * jour sans attendre.
 */
export async function validateCliSession(
  token: string,
  now: Date = new Date(),
): Promise<ValidCliSession | null> {
  if (!isCliTokenFormat(token)) return null;
  const tokenHash = hashCliToken(token);
  const tenant = await tenantOfCliToken(tokenHash);
  if (!tenant) return null;

  const row = await withTenantSchema(tenant.tenantSlug, (tx) =>
    tx.cliSession.findUnique({
      where: { tokenHash },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            role: true,
            sessionsValidFrom: true,
            deletionRequestedAt: true,
          },
        },
      },
    }),
  );
  if (!row || row.revokedAt || row.expiresAt <= now) return null;
  if (row.user.deletionRequestedAt) return null;
  if (isSessionInvalidated(row.createdAt.getTime(), row.user.sessionsValidFrom)) return null;

  withTenantSchema(tenant.tenantSlug, (tx) =>
    tx.cliSession.update({ where: { id: row.id }, data: { lastUsedAt: now } }),
  ).catch((err) => console.error("[cli-session] lastUsedAt update failed:", err));

  return {
    id: row.id,
    kind: row.kind === "AI" ? "AI" : "HUMAN",
    scope: row.scope,
    deviceName: row.deviceName,
    expiresAt: row.expiresAt,
    user: { id: row.user.id, email: row.user.email, role: row.user.role },
    tenantSlug: tenant.tenantSlug,
  };
}

/** Révocation par la session elle-même (`physalis logout`). Idempotente. */
export async function revokeCliSession(
  tenantSlug: string | null,
  sessionId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const { count } = await withTenantSchema(tenantSlug, (tx) =>
    tx.cliSession.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: now },
    }),
  );
  return count === 1;
}
