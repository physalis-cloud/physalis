// Signature SSH côté serveur — chantier C-0050 (agent-ssh), phase 3.
//
// `physalis ssh-agent` (sur le poste) reçoit du client `ssh` une demande
// SSH_AGENTC_SIGN_REQUEST et la transmet ici : la clé privée ne quitte jamais
// Physalis (arbitrage A1). Ce module fabrique la réponse au format attendu par
// le protocole d'agent (draft-miller-ssh-agent §4.5) :
//
//   string  nom de l'algorithme de signature
//   string  signature brute
//
// RSA : seules les variantes SHA-2 (rsa-sha2-256 / rsa-sha2-512, RFC 8332) sont
// produites. Une demande sans ces drapeaux voudrait `ssh-rsa`, donc SHA-1 :
// refusée, comme OpenSSH le fait par défaut depuis la 8.8.

import { createHash, sign, type KeyObject } from "crypto";

/** Drapeaux de SSH_AGENTC_SIGN_REQUEST (draft-miller-ssh-agent §4.5.1). */
export const SSH_AGENT_RSA_SHA2_256 = 0x02;
export const SSH_AGENT_RSA_SHA2_512 = 0x04;

/** Plafond des données à signer : une authentification en fait < 1 Ko. */
export const SSH_SIGN_DATA_MAX = 16 * 1024;

export type SignError = "sha1_refused" | "unsupported_algorithm" | "data_too_large";

export class SshSignError extends Error {
  constructor(readonly code: SignError) {
    super(code);
    this.name = "SshSignError";
  }
}

function sshString(buf: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(buf.length);
  return Buffer.concat([len, buf]);
}

function readString(buf: Buffer, offset: number): { value: Buffer; next: number } | null {
  if (offset + 4 > buf.length) return null;
  const len = buf.readUInt32BE(offset);
  if (offset + 4 + len > buf.length) return null;
  return { value: buf.subarray(offset + 4, offset + 4 + len), next: offset + 4 + len };
}

/** Le blob d'une clé publique OpenSSH (`ssh-ed25519 AAAA… commentaire` → octets). */
export function publicKeyBlobOf(sshPublicKey: string): Buffer {
  const b64 = sshPublicKey.trim().split(/\s+/)[1];
  if (!b64) throw new SshSignError("unsupported_algorithm");
  return Buffer.from(b64, "base64");
}

export function fingerprintOfBlob(blob: Buffer): string {
  return "SHA256:" + createHash("sha256").update(blob).digest("base64").replace(/=+$/, "");
}

/**
 * Signe `data` pour l'agent. Rend le blob de signature SSH (nom d'algorithme +
 * signature), à renvoyer tel quel dans SSH_AGENT_SIGN_RESPONSE.
 */
export function signForAgent(key: KeyObject, data: Buffer, flags: number): Buffer {
  if (data.length > SSH_SIGN_DATA_MAX) throw new SshSignError("data_too_large");

  if (key.asymmetricKeyType === "ed25519") {
    return Buffer.concat([sshString(Buffer.from("ssh-ed25519")), sshString(sign(null, data, key))]);
  }

  if (key.asymmetricKeyType === "rsa") {
    // SHA-512 si demandé, sinon SHA-256 ; ni l'un ni l'autre → ssh-rsa (SHA-1), refusé.
    const [name, hash] =
      flags & SSH_AGENT_RSA_SHA2_512
        ? ["rsa-sha2-512", "sha512"]
        : flags & SSH_AGENT_RSA_SHA2_256
          ? ["rsa-sha2-256", "sha256"]
          : [null, null];
    if (!name || !hash) throw new SshSignError("sha1_refused");
    return Buffer.concat([sshString(Buffer.from(name)), sshString(sign(hash, data, key))]);
  }

  throw new SshSignError("unsupported_algorithm");
}

/**
 * Le compte visé, lu dans une demande d'authentification SSH (RFC 4252 §7) :
 *   string session_id · byte 50 · string user · string service · string "publickey" …
 * Pour le journal seulement (« qui s'est connecté en tant que deploy »). null si
 * les données ne sont pas une authentification (ex. signature de commit git).
 */
export function sshUserOf(data: Buffer): string | null {
  const session = readString(data, 0);
  if (!session || data[session.next] !== 50) return null;
  const user = readString(data, session.next + 1);
  if (!user) return null;
  const service = readString(data, user.next);
  if (!service || service.value.toString() !== "ssh-connection") return null;
  const method = readString(data, service.next);
  if (!method || method.value.toString() !== "publickey") return null;
  const name = user.value.toString("utf8");
  return /^[\x20-\x7e]{1,64}$/.test(name) ? name : null;
}
