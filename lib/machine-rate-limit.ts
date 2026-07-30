// Rate-limit PAR TOKEN pour les endpoints de fetch machine (Bearer) :
// GET /api/secrets/[slug]/[env], /api/compose/[slug]/[env],
// /api/integrations/credentials.
//
// 120 req/min/token. Le brute-force d'un `sv_*` (256 bits) est impraticable —
// l'objectif n'est donc PAS l'anti-bruteforce mais de **brider un token
// COMPROMIS qui martèle** (exfiltration en boucle) et de le rendre **visible
// dans l'audit**. Le bucket est keyé sur l'ID du token (pas l'IP : CI/agents
// partagent souvent une IP en NAT) → chaque token a son propre quota, sans
// impacter les autres consommateurs.
//
// Sur déclenchement : 429 (avec en-têtes standard, posés par `rateLimit`) +
// une entrée d'audit `TOKEN_USE_FAILED{reason:"rate_limited"}` portant le
// contexte tenant, pour que l'abus soit traçable sans page d'admin dédiée.

import type { NextResponse } from "next/server";
import { rateLimit } from "./rate-limit";
import { logAction } from "./audit";

const MACHINE_FETCH_SCOPE = "machine-fetch";
const MACHINE_FETCH_LIMIT = { max: 120, windowMs: 60_000 };

export interface MachineTokenAudit {
  tokenId: string;
  tokenName?: string | null;
  tenantSlug: string;
  organizationId?: string | null;
  projectId?: string | null;
}

/**
 * Applique le plafond par token. Retourne une réponse 429 prête à renvoyer si
 * le token dépasse la limite (et journalise l'événement), sinon `null` pour
 * laisser le handler poursuivre. À appeler APRÈS la validation du token (on a
 * alors son id + son tenant) et AVANT le fetch/déchiffrement.
 */
export function machineFetchRateLimited(
  req: Request,
  audit: MachineTokenAudit,
): NextResponse | null {
  const limited = rateLimit(
    req,
    MACHINE_FETCH_SCOPE,
    MACHINE_FETCH_LIMIT,
    audit.tokenId,
  );
  if (!limited) return null;
  void logAction({
    action: "TOKEN_USE_FAILED",
    actor: {
      kind: "token",
      tokenId: audit.tokenId,
      tokenName: audit.tokenName ?? null,
    },
    organizationId: audit.organizationId ?? null,
    projectId: audit.projectId ?? null,
    metadata: { reason: "rate_limited", limitPerMin: MACHINE_FETCH_LIMIT.max },
    req,
    tenantSlug: audit.tenantSlug,
  });
  return limited;
}
