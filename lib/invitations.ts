import { createHash, randomBytes } from "crypto";
import { physalisBaseUrl } from "./app-url";

export const INVITATION_TTL_MS = 48 * 60 * 60_000; // 48h

export function generateInvitationToken(): string {
  return randomBytes(32).toString("hex");
}

export function hashInvitationToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Builds the acceptance URL for an invitation. If a request is provided,
 * the origin is derived from it (so links match whichever host the inviter
 * connected from — useful in dev where the IP changes, and behind reverse
 * proxies where the configured URL may be wrong). Falls back to PHYSALIS_URL
 * (cf. lib/app-url, chaîne PHYSALIS_URL → NEXTAUTH_URL → AUTH_URL).
 */
export function buildAcceptUrl(token: string, req?: Request): string {
  if (req) {
    const xfProto = req.headers.get("x-forwarded-proto");
    const xfHost = req.headers.get("x-forwarded-host");
    const host = xfHost ?? req.headers.get("host");
    if (host) {
      const proto = xfProto ?? new URL(req.url).protocol.replace(":", "");
      return `${proto}://${host}/invite/${token}`;
    }
  }
  return `${physalisBaseUrl()}/invite/${token}`;
}
