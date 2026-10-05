// API de l'agent SSH — chantier C-0050 (agent-ssh), phase 3.
//
//   GET  /api/agent/ssh/keys  → clés publiques de l'utilisateur (Bearer sv_cli_)
//   POST /api/agent/ssh/sign  → { fingerprint, data, flags } → { signature }
//
// La clé privée est déchiffrée le temps d'UNE signature, côté serveur, puis
// oubliée (arbitrage A1). La session est revalidée à chaque requête : la couper
// dans /account coupe l'agent à la connexion suivante, sans redémarrer quoi que
// ce soit. Chaque signature est journalisée (SSH_KEY_SIGN) — c'est le serveur
// qui l'écrit, donc le journal fait foi.
//
// Session « agent IA » : refusée pour l'instant. Son périmètre (lib/cli-ai-scope.ts)
// ne couvre que des couples projet/environnement ; ouvrir à un agent TOUTES les
// clés SSH de l'humain serait l'inverse du scénario S4. À rouvrir quand
// l'approbation saura cocher des clés précises.
//
// Tout l'accès base passe par ici : les routes n'appellent jamais withTenantSchema.

import { NextResponse } from "next/server";
import { decrypt } from "./crypto";
import { logAction } from "./audit";
import { withTenantSchema } from "./tenant";
import { maybeRunWithTenant } from "./tenant-context";
import { isPlatformAdmin } from "./roles";
import { seatFrozenForUser } from "./feature-guard";
import { rateLimit } from "./rate-limit";
import { validateCliSession, type ValidCliSession } from "./cli-session";
import { SSH_KEY_ENTRY_TYPE } from "./vault-entry-types";
import { loadStoredSshKey } from "./ssh-keys";
import {
  publicKeyBlobOf,
  signForAgent,
  sshUserOf,
  SshSignError,
  SSH_SIGN_DATA_MAX,
} from "./ssh-sign";

type Gate = { ok: true; session: ValidCliSession } | { ok: false; response: NextResponse };

/** Commun aux deux routes : Bearer valide, humain, siège non gelé, débit borné. */
async function gate(req: Request, scope: string): Promise<Gate> {
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const session = await validateCliSession(token);
  if (!session) {
    return { ok: false, response: NextResponse.json({ error: "Invalid token" }, { status: 401 }) };
  }
  if (session.kind !== "HUMAN") {
    return {
      ok: false,
      response: NextResponse.json({ error: "Forbidden", reason: "ai_ssh_not_granted" }, { status: 403 }),
    };
  }
  const frozen = await maybeRunWithTenant(session.tenantSlug, () =>
    seatFrozenForUser({
      tenantSlug: session.tenantSlug,
      userId: session.user.id,
      isPlatformAdmin: isPlatformAdmin(session.user.role),
    }),
  );
  if (frozen) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Forbidden", reason: "seat_frozen" }, { status: 403 }),
    };
  }
  // Une connexion SSH = une signature ; 120/min couvre un script qui boucle
  // sur une centaine de serveurs, et bride une session volée.
  const limited = rateLimit(req, scope, { max: 120, windowMs: 60_000 }, session.id);
  if (limited) return { ok: false, response: limited };
  return { ok: true, session };
}

export async function handleListSshKeys(req: Request): Promise<NextResponse> {
  const g = await gate(req, "agent-ssh-keys");
  if (!g.ok) return g.response;
  const { session } = g;

  const keys = await withTenantSchema(session.tenantSlug, (tx) =>
    tx.vaultEntry.findMany({
      where: { userId: session.user.id, type: SSH_KEY_ENTRY_TYPE, sshPublicKey: { not: null } },
      select: { name: true, sshPublicKey: true, sshFingerprint: true },
      orderBy: { name: "asc" },
    }),
  );

  return NextResponse.json({
    keys: keys.map((k) => ({
      name: k.name,
      fingerprint: k.sshFingerprint,
      // Le blob, en base64 : ce que l'agent renvoie tel quel dans
      // SSH_AGENT_IDENTITIES_ANSWER. Le nom de l'entrée sert de commentaire.
      publicKey: publicKeyBlobOf(k.sshPublicKey!).toString("base64"),
      algorithm: k.sshPublicKey!.split(" ")[0],
    })),
  });
}

export async function handleSshSign(req: Request): Promise<NextResponse> {
  const g = await gate(req, "agent-ssh-sign");
  if (!g.ok) return g.response;
  const { session } = g;

  const body = (await req.json().catch(() => null)) as
    | { fingerprint?: unknown; data?: unknown; flags?: unknown }
    | null;
  const fingerprint = typeof body?.fingerprint === "string" ? body.fingerprint : "";
  const dataB64 = typeof body?.data === "string" ? body.data : "";
  const flags = typeof body?.flags === "number" && Number.isInteger(body.flags) ? body.flags : 0;
  if (!/^SHA256:[A-Za-z0-9+/]{43}$/.test(fingerprint) || !dataB64) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const data = Buffer.from(dataB64, "base64");
  if (data.length === 0 || data.length > SSH_SIGN_DATA_MAX) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const entry = await withTenantSchema(session.tenantSlug, (tx) =>
    tx.vaultEntry.findFirst({
      where: { userId: session.user.id, type: SSH_KEY_ENTRY_TYPE, sshFingerprint: fingerprint },
      select: { id: true, name: true, encryptedData: true, dataIv: true, dataTag: true },
    }),
  );
  if (!entry || !entry.encryptedData || !entry.dataIv || !entry.dataTag) {
    // Clé supprimée du coffre, ou qui n'a jamais été à cet utilisateur.
    return NextResponse.json({ error: "unknown_key" }, { status: 404 });
  }

  let signature: Buffer;
  try {
    const { sshPrivateKey } = JSON.parse(
      decrypt({ encryptedValue: entry.encryptedData, iv: entry.dataIv, tag: entry.dataTag }),
    ) as { sshPrivateKey: string };
    signature = signForAgent(loadStoredSshKey(sshPrivateKey), data, flags);
  } catch (err) {
    if (err instanceof SshSignError) {
      logAction({
        action: "TOKEN_USE_FAILED",
        actor: { kind: "user", userId: session.user.id, email: session.user.email },
        targetType: "VaultEntry",
        targetId: entry.id,
        metadata: { reason: `ssh_sign_${err.code}`, fingerprint, via: "cli_session", cliSessionId: session.id },
        req,
        tenantSlug: session.tenantSlug,
      });
      return NextResponse.json({ error: err.code }, { status: 400 });
    }
    throw err;
  }

  logAction({
    action: "SSH_KEY_SIGN",
    actor: { kind: "user", userId: session.user.id, email: session.user.email },
    targetType: "VaultEntry",
    targetId: entry.id,
    metadata: {
      keyName: entry.name,
      fingerprint,
      sshUser: sshUserOf(data),
      via: "cli_session",
      cliSessionId: session.id,
      deviceName: session.deviceName,
    },
    req,
    tenantSlug: session.tenantSlug,
  });

  return NextResponse.json({ signature: signature.toString("base64") });
}
