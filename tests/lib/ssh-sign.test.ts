// C-0050 (agent-ssh), phase 3 — lib/ssh-sign.ts. Le blob de signature est
// vérifié par OpenSSH LUI-MÊME : on l'emballe au format SSHSIG (celui de
// `ssh-keygen -Y sign`, PROTOCOL.sshsig) et on le fait vérifier par
// `ssh-keygen -Y check-novalidate`. Sauté si ssh-keygen manque.

import { describe, it, expect, beforeAll } from "vitest";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSshKey, importSshKey, loadStoredSshKey } from "@/lib/ssh-keys";
import {
  publicKeyBlobOf,
  fingerprintOfBlob,
  signForAgent,
  sshUserOf,
  SshSignError,
  SSH_AGENT_RSA_SHA2_256,
  SSH_AGENT_RSA_SHA2_512,
} from "@/lib/ssh-sign";

// RSA 3072 via ssh-keygen : lent sous la charge de la suite complète.
const RSA_TIMEOUT = 60_000;
const HAS_SSH_KEYGEN = !spawnSync("ssh-keygen", ["-?"], { stdio: "ignore" }).error;
let dir = "";

const str = (b: Buffer | string) => {
  const buf = Buffer.isBuffer(b) ? b : Buffer.from(b);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(buf.length);
  return Buffer.concat([len, buf]);
};

/**
 * Vérifie `message` signé par notre agent, avec ssh-keygen. Les données à
 * signer sont celles de PROTOCOL.sshsig ; c'est signForAgent qui produit le
 * blob de signature, exactement comme pour une connexion.
 */
function opensshAccepts(privatePem: string, publicKey: string, flags: number): boolean {
  const ns = "physalis-test";
  const message = Buffer.from("message à signer\n");
  const hashAlg = "sha512";
  const toSign = Buffer.concat([
    Buffer.from("SSHSIG"),
    str(ns),
    str(""),
    str(hashAlg),
    str(createHash(hashAlg).update(message).digest()),
  ]);
  const sigBlob = signForAgent(loadStoredSshKey(privatePem), toSign, flags);
  const envelope = Buffer.concat([
    Buffer.from("SSHSIG"),
    Buffer.from([0, 0, 0, 1]),
    str(publicKeyBlobOf(publicKey)),
    str(ns),
    str(""),
    str(hashAlg),
    str(sigBlob),
  ]);
  const armored =
    "-----BEGIN SSH SIGNATURE-----\n" +
    envelope.toString("base64").replace(/(.{70})/g, "$1\n") +
    "\n-----END SSH SIGNATURE-----\n";
  const sigPath = join(dir, `sig-${Math.random().toString(36).slice(2)}`);
  writeFileSync(sigPath, armored);
  const res = spawnSync("ssh-keygen", ["-Y", "check-novalidate", "-n", ns, "-s", sigPath], {
    input: message,
  });
  return res.status === 0;
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "ssh-sign-"));
});

describe("blob de clé publique et empreinte", () => {
  it("l'empreinte recalculée depuis le blob est celle stockée", () => {
    const k = generateSshKey("x");
    expect(fingerprintOfBlob(publicKeyBlobOf(k.publicKey))).toBe(k.fingerprint);
  });
});

describe.skipIf(!HAS_SSH_KEYGEN)("signatures vérifiées par OpenSSH", () => {
  it("ed25519 : OpenSSH accepte la signature", () => {
    const k = generateSshKey("agent");
    expect(opensshAccepts(k.privateKeyPem, k.publicKey, 0)).toBe(true);
  });

  it("une signature d'une AUTRE clé est rejetée (le test sait dire non)", () => {
    const a = generateSshKey("a");
    const b = generateSshKey("b");
    expect(opensshAccepts(a.privateKeyPem, b.publicKey, 0)).toBe(false);
  });

  it("RSA : rsa-sha2-512 et rsa-sha2-256 acceptés par OpenSSH", () => {
    const path = join(dir, "rsa");
    execFileSync("ssh-keygen", ["-q", "-t", "rsa", "-b", "3072", "-N", "", "-f", path]);
    const k = importSshKey(readFileSync(path, "utf8"));
    expect(opensshAccepts(k.privateKeyPem, k.publicKey, SSH_AGENT_RSA_SHA2_512)).toBe(true);
    expect(opensshAccepts(k.privateKeyPem, k.publicKey, SSH_AGENT_RSA_SHA2_256)).toBe(true);
  }, RSA_TIMEOUT);
});

describe("refus", () => {
  it.skipIf(!HAS_SSH_KEYGEN)("RSA sans drapeau SHA-2 = ssh-rsa (SHA-1) : refusé", () => {
    const path = join(dir, "rsa-sha1");
    execFileSync("ssh-keygen", ["-q", "-t", "rsa", "-b", "3072", "-N", "", "-f", path]);
    const k = importSshKey(readFileSync(path, "utf8"));
    expect(() => signForAgent(loadStoredSshKey(k.privateKeyPem), Buffer.from("x"), 0)).toThrow(SshSignError);
  }, RSA_TIMEOUT);

  it("données trop grandes : refusé", () => {
    const k = generateSshKey();
    expect(() => signForAgent(loadStoredSshKey(k.privateKeyPem), Buffer.alloc(17 * 1024), 0)).toThrow(
      /data_too_large/,
    );
  });
});

describe("sshUserOf — le compte visé, pour le journal", () => {
  const userauth = (user: string, service = "ssh-connection", method = "publickey") =>
    Buffer.concat([str(Buffer.alloc(32, 7)), Buffer.from([50]), str(user), str(service), str(method), Buffer.from([1])]);

  it("lit l'utilisateur d'une demande d'authentification par clé", () => {
    expect(sshUserOf(userauth("deploy"))).toBe("deploy");
  });

  it("rend null pour autre chose qu'une authentification (signature de commit…)", () => {
    expect(sshUserOf(Buffer.from("SSHSIG blabla"))).toBeNull();
    expect(sshUserOf(userauth("deploy", "autre"))).toBeNull();
    expect(sshUserOf(userauth("deploy", "ssh-connection", "password"))).toBeNull();
    expect(sshUserOf(userauth("a\nb"))).toBeNull();
  });
});
