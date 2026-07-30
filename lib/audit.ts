import { Prisma, type AccessAction } from "@prisma/client";
import { getClientIp } from "./rate-limit";
import { prisma } from "./prisma";

export type AuditActor =
  | { kind: "user"; userId: string; email?: string | null }
  | { kind: "token"; tokenId: string; tokenName?: string | null }
  | { kind: "anonymous" };

export type AuditEntry = {
  action: AccessAction;
  actor: AuditActor;
  organizationId?: string | null;
  projectId?: string | null;
  environmentId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  secretKey?: string | null;
  metadata?: Prisma.InputJsonValue;
  req?: Request;
  /** Mono-tenant : ignoré (toujours null/absent). Présent pour que le code
   *  SaaS coulé verbatim, qui renseigne `tenantSlug`, compile sans overlay. */
  tenantSlug?: string | null;
};

/** Borne défensive de la metadata d'audit (P5 — docs/failles.md §40).
 *  Miroir du `userAgent.slice(0, 500)` : une metadata anormalement grande — ou
 *  non sérialisable (ex. BigInt) — ne doit jamais pouvoir faire échouer/gonfler
 *  l'écriture d'audit (le seul vecteur théorique d'échec silencieux du log,
 *  puisque toutes les colonnes AccessLog sont `text`/`jsonb` sans limite). Les
 *  metadata légitimes font < 1 KB ; au-delà du cap on écrit un marqueur, ce qui
 *  PRÉSERVE l'entrée d'audit (l'action reste tracée) au lieu de risquer sa
 *  perte. On ne conserve PAS le contenu tronqué (évite de persister par accident
 *  un fragment volumineux non prévu). */
const AUDIT_METADATA_MAX_CHARS = 16_384;

export function capAuditMetadata(
  metadata: AuditEntry["metadata"],
): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  if (metadata === undefined || metadata === null) return Prisma.JsonNull;
  let serialized: string;
  try {
    serialized = JSON.stringify(metadata);
  } catch {
    // Non sérialisable (BigInt, cycle…) → marqueur, jamais un throw.
    return { _audit: "metadata_unserializable" };
  }
  if (serialized.length > AUDIT_METADATA_MAX_CHARS) {
    return { _audit: "metadata_truncated", _bytes: serialized.length };
  }
  return metadata;
}

/**
 * Records an audit log entry. Non-blocking: if the write fails, the error is
 * logged but the caller's request is not affected — auditing must never break
 * the operation it records.
 */
export async function logAction(entry: AuditEntry): Promise<void> {
  const ipAddress = entry.req ? getClientIp(entry.req) : null;
  const userAgent = entry.req?.headers.get("user-agent") ?? null;

  const actorUserId = entry.actor.kind === "user" ? entry.actor.userId : null;
  const actorUserEmail =
    entry.actor.kind === "user" ? (entry.actor.email ?? null) : null;
  const actorTokenId =
    entry.actor.kind === "token" ? entry.actor.tokenId : null;
  const actorTokenName =
    entry.actor.kind === "token" ? (entry.actor.tokenName ?? null) : null;

  const data = {
    action: entry.action,
    organizationId: entry.organizationId ?? null,
    projectId: entry.projectId ?? null,
    environmentId: entry.environmentId ?? null,
    actorUserId,
    actorUserEmail,
    actorTokenId,
    actorTokenName,
    targetType: entry.targetType ?? null,
    targetId: entry.targetId ?? null,
    secretKey: entry.secretKey ?? null,
    ipAddress: ipAddress === "unknown" ? null : ipAddress,
    userAgent: userAgent ? userAgent.slice(0, 500) : null,
    metadata: capAuditMetadata(entry.metadata),
  };

  try {
    await prisma.accessLog.create({ data });
  } catch (err) {
    console.error("[audit] failed to record action:", err);
  }
}

const CSV_HEADERS = [
  "timestamp",
  "action",
  "actor_user_email",
  "actor_token_name",
  "ip_address",
  "organization_id",
  "project_id",
  "environment_id",
  "secret_key",
  "target_type",
  "target_id",
  "metadata",
] as const;

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  const str =
    typeof value === "string"
      ? value
      : value instanceof Date
        ? value.toISOString()
        : JSON.stringify(value);
  // RFC 4180: wrap in double quotes if contains ", \n, or comma. Escape " as "".
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export type CsvRow = {
  createdAt: Date;
  action: string;
  actorUserEmail: string | null;
  actorTokenName: string | null;
  ipAddress: string | null;
  organizationId: string | null;
  projectId: string | null;
  environmentId: string | null;
  secretKey: string | null;
  targetType: string | null;
  targetId: string | null;
  metadata: Prisma.JsonValue | null;
};

export function rowsToCsv(rows: CsvRow[]): string {
  const lines = [CSV_HEADERS.join(",")];
  for (const row of rows) {
    lines.push(
      [
        csvEscape(row.createdAt),
        csvEscape(row.action),
        csvEscape(row.actorUserEmail),
        csvEscape(row.actorTokenName),
        csvEscape(row.ipAddress),
        csvEscape(row.organizationId),
        csvEscape(row.projectId),
        csvEscape(row.environmentId),
        csvEscape(row.secretKey),
        csvEscape(row.targetType),
        csvEscape(row.targetId),
        csvEscape(row.metadata),
      ].join(","),
    );
  }
  return lines.join("\n") + "\n";
}
