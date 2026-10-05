// POST /api/vault/ssh-keys — crée une clé SSH dans le coffre PERSONNEL
// (chantier C-0050, phase 1).
//
//   { name, mode: "generate", comment? }                    → ed25519 neuve
//   { name, mode: "import", privateKey, passphrase?, comment? }
//   + tags?, favorite?, collectionId?
//
// La clé privée est chiffrée dans `encryptedData` (même ENCRYPTION_KEY que le
// reste du coffre, couverte par le re-keying) et ne repart JAMAIS : la réponse,
// la liste, la révélation et l'export RGPD ne rendent que la clé publique et
// l'empreinte. Seule la signature côté serveur (phase 3) la lira.
//
// Route dédiée plutôt qu'un 5ᵉ type du POST générique : SSH_KEY est hors de
// VAULT_ENTRY_TYPES, partagé avec le coffre d'équipe (lib/vault-entry-types.ts).

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { encrypt } from "@/lib/crypto";
import { readJson, requireUser } from "@/lib/api";
import { logAction } from "@/lib/audit";
import { rateLimit } from "@/lib/rate-limit";
import {
  generateSshKey,
  importSshKey,
  SshKeyImportError,
  SSH_PRIVATE_KEY_MAX,
  type SshKeyMaterial,
} from "@/lib/ssh-keys";
import {
  normalizeVaultTags,
  SSH_KEY_ENTRY_TYPE,
  VAULT_TAGS_ERROR,
} from "@/lib/vault-entry-types";

const NAME_MAX = 200;
const PASSPHRASE_MAX = 1024;

export async function POST(req: Request) {
  const userRes = await requireUser();
  if ("error" in userRes) return userRes.error;
  const { user } = userRes;

  // Une génération RSA serait coûteuse ; ed25519 ne l'est pas, mais une
  // boucle d'imports (bcrypt-pbkdf, volontairement lent) l'est.
  const limited = rateLimit(req, "vault-ssh-keys", { max: 30, windowMs: 15 * 60_000 }, user.id);
  if (limited) return limited;

  const body = (await readJson(req)) as
    | {
        name?: unknown;
        mode?: unknown;
        privateKey?: unknown;
        passphrase?: unknown;
        comment?: unknown;
        tags?: unknown;
        favorite?: unknown;
        collectionId?: unknown;
      }
    | null;
  if (!body || typeof body.name !== "string") {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }
  const name = body.name.trim();
  if (!name || name.length > NAME_MAX) {
    return NextResponse.json({ error: `name must be 1-${NAME_MAX} chars` }, { status: 400 });
  }
  const tags = normalizeVaultTags(body.tags);
  if (tags === null) {
    return NextResponse.json({ error: VAULT_TAGS_ERROR }, { status: 400 });
  }
  const comment = typeof body.comment === "string" ? body.comment : undefined;

  let collectionId: string | null = null;
  if (typeof body.collectionId === "string" && body.collectionId.length > 0) {
    const col = await prisma.vaultCollection.findFirst({
      where: { id: body.collectionId, userId: user.id },
      select: { id: true },
    });
    if (!col) {
      return NextResponse.json({ error: "collectionId not found" }, { status: 400 });
    }
    collectionId = col.id;
  }

  let material: SshKeyMaterial;
  if (body.mode === "generate") {
    material = generateSshKey(comment ?? name);
  } else if (body.mode === "import") {
    if (typeof body.privateKey !== "string" || body.privateKey.length > SSH_PRIVATE_KEY_MAX) {
      return NextResponse.json({ error: "privateKey is required", code: "unrecognized_format" }, { status: 400 });
    }
    const passphrase =
      typeof body.passphrase === "string" && body.passphrase.length > 0
        ? body.passphrase.slice(0, PASSPHRASE_MAX)
        : undefined;
    try {
      material = importSshKey(body.privateKey, passphrase, comment);
    } catch (err) {
      if (err instanceof SshKeyImportError) {
        return NextResponse.json({ error: "import refused", code: err.code }, { status: 400 });
      }
      throw err;
    }
  } else {
    return NextResponse.json({ error: 'mode must be "generate" or "import"' }, { status: 400 });
  }

  // La même clé deux fois dans le coffre : refus explicite plutôt qu'un doublon
  // dont on ne saurait plus lequel l'agent utilise.
  const duplicate = await prisma.vaultEntry.findFirst({
    where: { userId: user.id, type: SSH_KEY_ENTRY_TYPE, sshFingerprint: material.fingerprint },
    select: { id: true, name: true },
  });
  if (duplicate) {
    return NextResponse.json(
      { error: "Cette clé est déjà dans ton coffre.", code: "duplicate_key", entryId: duplicate.id },
      { status: 409 },
    );
  }

  const sealed = encrypt(JSON.stringify({ sshPrivateKey: material.privateKeyPem }));
  const entry = await prisma.vaultEntry.create({
    data: {
      userId: user.id,
      type: SSH_KEY_ENTRY_TYPE,
      name,
      sshPublicKey: material.publicKey,
      sshFingerprint: material.fingerprint,
      encryptedData: sealed.encryptedValue,
      dataIv: sealed.iv,
      dataTag: sealed.tag,
      tags,
      favorite: body.favorite === true,
      collectionId,
    },
    select: {
      id: true,
      type: true,
      name: true,
      sshPublicKey: true,
      sshFingerprint: true,
      tags: true,
      favorite: true,
      collectionId: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  logAction({
    action: "VAULT_ENTRY_CREATE",
    actor: { kind: "user", userId: user.id, email: user.email },
    targetType: "VaultEntry",
    targetId: entry.id,
    metadata: {
      source: "personal",
      type: SSH_KEY_ENTRY_TYPE,
      origin: body.mode,
      algorithm: material.algorithm,
      fingerprint: material.fingerprint,
    },
    req,
  });

  return NextResponse.json({ entry }, { status: 201 });
}
