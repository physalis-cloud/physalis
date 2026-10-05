// Clés SSH du coffre personnel — chantier C-0050 (agent-ssh), phase 1.
//
// Ce module ne touche pas la base : il fabrique et lit des clés.
//   - generateSshKey  : ed25519, le chemin recommandé (la clé n'a jamais existé
//                       sur aucun disque) ;
//   - importSshKey    : ed25519 et RSA ≥ 3072, aux formats `openssh-key-v1`
//                       (celui de ssh-keygen), PKCS#8 et PEM RSA, chiffrés ou non.
// Dans les deux cas il rend la clé privée en PKCS#8 (à chiffrer par l'appelant
// dans `encryptedData`), la clé publique au format OpenSSH (une ligne, celle
// d'`authorized_keys`) et l'empreinte SHA256 (celle de `ssh-keygen -lf`).
//
// Décision A4 du plan : refuser une clé chiffrée pousserait l'utilisateur à
// faire `ssh-keygen -p` sans phrase de passe, donc à ÉCRIRE la clé en clair sur
// son disque — l'inverse du but. D'où `bcrypt-pbkdf` (le KDF d'OpenSSH).
// Refusés : ECDSA (conversion de signature DER→SSH, peu demandé), DSA, RSA < 3072.

import {
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
} from "crypto";
import { pbkdf as bcryptPbkdf } from "bcrypt-pbkdf";

export type SshKeyAlgorithm = "ssh-ed25519" | "ssh-rsa";

export type SshKeyMaterial = {
  algorithm: SshKeyAlgorithm;
  /** Clé privée PKCS#8 PEM — à chiffrer, jamais à renvoyer au navigateur. */
  privateKeyPem: string;
  /** `ssh-ed25519 AAAA… commentaire` */
  publicKey: string;
  /** `SHA256:…` (sans `=` final, comme ssh-keygen). */
  fingerprint: string;
};

export type SshKeyError =
  | "unrecognized_format"
  | "passphrase_required"
  | "wrong_passphrase"
  | "unsupported_algorithm"
  | "rsa_too_short"
  | "unsupported_cipher"
  | "kdf_rounds_too_high";

export class SshKeyImportError extends Error {
  constructor(readonly code: SshKeyError) {
    super(code);
    this.name = "SshKeyImportError";
  }
}

export const RSA_MIN_BITS = 3072;
/**
 * Plafond des tours de bcrypt-pbkdf. Le nombre de tours vient DE LA CLÉ : sans
 * plafond, une clé forgée (1e9 tours) bloquerait la boucle d'événements de Node
 * — donc tout le serveur — indéfiniment. Mesuré en JS pur : 16 tours (défaut de
 * ssh-keygen) ≈ 0,4 s, 64 ≈ 1,5 s ; 128 ≈ 3 s couvre `ssh-keygen -a 100`.
 */
export const KDF_ROUNDS_MAX = 128;
/** Plafond de taille d'une clé collée (une RSA 16384 en PEM fait ~13 Ko). */
export const SSH_PRIVATE_KEY_MAX = 20_000;
const COMMENT_MAX = 100;

// ─── Encodage « fil SSH » (RFC 4251 §5) ──────────────────────────────────────

function sshString(buf: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(buf.length);
  return Buffer.concat([len, buf]);
}

/** mpint : entier positif big-endian, octet nul ajouté si le bit de poids fort est mis. */
function sshMpint(buf: Buffer): Buffer {
  let i = 0;
  while (i < buf.length - 1 && buf[i] === 0) i++;
  let b = buf.subarray(i);
  if (b[0]! & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return sshString(b);
}

class Reader {
  private pos = 0;
  constructor(private readonly buf: Buffer) {}
  uint32(): number {
    if (this.pos + 4 > this.buf.length) throw new SshKeyImportError("unrecognized_format");
    const v = this.buf.readUInt32BE(this.pos);
    this.pos += 4;
    return v;
  }
  bytes(): Buffer {
    const len = this.uint32();
    if (this.pos + len > this.buf.length) throw new SshKeyImportError("unrecognized_format");
    const v = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return v;
  }
  text(): string {
    return this.bytes().toString("utf8");
  }
}

const b64url = (b: Buffer) => b.toString("base64url");
const fromB64url = (s: string) => Buffer.from(s, "base64url");

// ─── Clé publique et empreinte ───────────────────────────────────────────────

function publicKeyBlob(key: KeyObject): { algorithm: SshKeyAlgorithm; blob: Buffer } {
  const jwk = key.export({ format: "jwk" }) as { kty: string; crv?: string; x?: string; n?: string; e?: string };
  if (jwk.kty === "OKP" && jwk.crv === "Ed25519" && jwk.x) {
    return {
      algorithm: "ssh-ed25519",
      blob: Buffer.concat([sshString(Buffer.from("ssh-ed25519")), sshString(fromB64url(jwk.x))]),
    };
  }
  if (jwk.kty === "RSA" && jwk.n && jwk.e) {
    return {
      algorithm: "ssh-rsa",
      blob: Buffer.concat([
        sshString(Buffer.from("ssh-rsa")),
        sshMpint(fromB64url(jwk.e)),
        sshMpint(fromB64url(jwk.n)),
      ]),
    };
  }
  throw new SshKeyImportError("unsupported_algorithm");
}

export function sshFingerprint(blob: Buffer): string {
  return "SHA256:" + createHash("sha256").update(blob).digest("base64").replace(/=+$/, "");
}

function cleanComment(comment: string | undefined): string {
  return (comment ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, COMMENT_MAX);
}

/** Vérifie l'algorithme et la taille, puis fabrique le matériel à stocker. */
function materialFrom(privateKey: KeyObject, comment?: string): SshKeyMaterial {
  if (privateKey.asymmetricKeyType === "rsa") {
    const bits = privateKey.asymmetricKeyDetails?.modulusLength ?? 0;
    if (bits < RSA_MIN_BITS) throw new SshKeyImportError("rsa_too_short");
  } else if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new SshKeyImportError("unsupported_algorithm");
  }
  const { algorithm, blob } = publicKeyBlob(createPublicKey(privateKey));
  const c = cleanComment(comment);
  return {
    algorithm,
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    publicKey: `${algorithm} ${blob.toString("base64")}${c ? ` ${c}` : ""}`,
    fingerprint: sshFingerprint(blob),
  };
}

// ─── Génération ──────────────────────────────────────────────────────────────

export function generateSshKey(comment?: string): SshKeyMaterial {
  const { privateKey } = generateKeyPairSync("ed25519");
  return materialFrom(privateKey, comment);
}

/** Relit une clé déjà stockée (PKCS#8) — pour la signature, phase 3. */
export function loadStoredSshKey(privateKeyPem: string): KeyObject {
  return createPrivateKey(privateKeyPem);
}

// ─── Import ──────────────────────────────────────────────────────────────────

const OPENSSH_MAGIC = Buffer.from("openssh-key-v1\0");

/** Format `-----BEGIN OPENSSH PRIVATE KEY-----` (PROTOCOL.key d'OpenSSH). */
function parseOpenSshKey(pem: string, passphrase: string | undefined): { key: KeyObject; comment: string } {
  const body = pem
    .replace(/-----(BEGIN|END) OPENSSH PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");
  const raw = Buffer.from(body, "base64");
  if (!raw.subarray(0, OPENSSH_MAGIC.length).equals(OPENSSH_MAGIC)) {
    throw new SshKeyImportError("unrecognized_format");
  }
  const r = new Reader(raw.subarray(OPENSSH_MAGIC.length));
  const cipher = r.text();
  const kdf = r.text();
  const kdfOptions = r.bytes();
  if (r.uint32() !== 1) throw new SshKeyImportError("unrecognized_format");
  r.bytes(); // clé publique, redondante avec la section privée
  let privSection = r.bytes();

  if (cipher !== "none") {
    if (!passphrase) throw new SshKeyImportError("passphrase_required");
    if (kdf !== "bcrypt" || cipher !== "aes256-ctr") throw new SshKeyImportError("unsupported_cipher");
    const opts = new Reader(kdfOptions);
    const salt = opts.bytes();
    const rounds = opts.uint32();
    if (rounds > KDF_ROUNDS_MAX) throw new SshKeyImportError("kdf_rounds_too_high");
    const pass = Buffer.from(passphrase, "utf8");
    const derived = Buffer.alloc(48);
    bcryptPbkdf(pass, pass.length, salt, salt.length, derived, derived.length, rounds);
    const decipher = createDecipheriv("aes-256-ctr", derived.subarray(0, 32), derived.subarray(32, 48));
    privSection = Buffer.concat([decipher.update(privSection), decipher.final()]);
  }

  const p = new Reader(privSection);
  // Deux entiers égaux : leur différence est le seul signe d'une mauvaise phrase de passe.
  if (p.uint32() !== p.uint32()) throw new SshKeyImportError("wrong_passphrase");
  const type = p.text();

  if (type === "ssh-ed25519") {
    const pub = p.bytes();
    const priv = p.bytes(); // graine (32) || publique (32)
    const comment = p.text();
    const key = createPrivateKey({
      key: { kty: "OKP", crv: "Ed25519", d: b64url(priv.subarray(0, 32)), x: b64url(pub) },
      format: "jwk",
    });
    return { key, comment };
  }

  if (type === "ssh-rsa") {
    const n = p.bytes();
    const e = p.bytes();
    const d = p.bytes();
    const iqmp = p.bytes();
    const pp = p.bytes();
    const q = p.bytes();
    const comment = p.text();
    const big = (b: Buffer) => BigInt("0x" + (b.toString("hex") || "0"));
    const toBuf = (v: bigint) => {
      let hex = v.toString(16);
      if (hex.length % 2) hex = "0" + hex;
      return Buffer.from(hex, "hex");
    };
    const dv = big(d);
    const key = createPrivateKey({
      key: {
        kty: "RSA",
        n: b64url(toBuf(big(n))),
        e: b64url(toBuf(big(e))),
        d: b64url(toBuf(dv)),
        p: b64url(toBuf(big(pp))),
        q: b64url(toBuf(big(q))),
        dp: b64url(toBuf(dv % (big(pp) - BigInt(1)))),
        dq: b64url(toBuf(dv % (big(q) - BigInt(1)))),
        qi: b64url(toBuf(big(iqmp))),
      },
      format: "jwk",
    });
    return { key, comment };
  }

  throw new SshKeyImportError("unsupported_algorithm");
}

/**
 * Importe une clé privée collée par l'utilisateur. `comment` remplace le
 * commentaire de la clé s'il est fourni.
 */
export function importSshKey(text: string, passphrase?: string, comment?: string): SshKeyMaterial {
  const pem = text.trim();
  if (!pem || pem.length > SSH_PRIVATE_KEY_MAX) throw new SshKeyImportError("unrecognized_format");

  if (pem.includes("BEGIN OPENSSH PRIVATE KEY")) {
    const parsed = parseOpenSshKey(pem, passphrase);
    return materialFrom(parsed.key, comment ?? parsed.comment);
  }

  if (!/-----BEGIN (RSA |ENCRYPTED )?PRIVATE KEY-----/.test(pem)) {
    // ECDSA (`BEGIN EC PRIVATE KEY`), DSA, PuTTY… : formats non pris en charge.
    if (/-----BEGIN (EC|DSA) PRIVATE KEY-----/.test(pem)) {
      throw new SshKeyImportError("unsupported_algorithm");
    }
    throw new SshKeyImportError("unrecognized_format");
  }

  let key: KeyObject;
  try {
    key = createPrivateKey(passphrase ? { key: pem, passphrase } : { key: pem });
  } catch (err) {
    const msg = String((err as Error).message);
    if (/passphrase|bad decrypt|interrupted or cancelled/i.test(msg)) {
      throw new SshKeyImportError(passphrase ? "wrong_passphrase" : "passphrase_required");
    }
    throw new SshKeyImportError("unrecognized_format");
  }
  return materialFrom(key, comment);
}
