// C-0050 (agent-ssh), phase 1 — lib/ssh-keys.ts contre de VRAIES clés produites
// par ssh-keygen : formats, phrases de passe, et empreintes / clés publiques
// comparées octet par octet à celles d'OpenSSH. Sauté si ssh-keygen manque.

import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicKey, sign, verify } from "node:crypto";
import {
  generateSshKey,
  importSshKey,
  loadStoredSshKey,
  SshKeyImportError,
} from "@/lib/ssh-keys";

// Générer une RSA 3072 avec ssh-keygen prend ~0,5 s au calme, bien plus sous
// la charge de la suite complète : délai généreux, sinon test instable.
const RSA_TIMEOUT = 60_000;
const HAS_SSH_KEYGEN = !spawnSync("ssh-keygen", ["-?"], { stdio: "ignore" }).error;
let dir = "";

/** Fabrique une clé avec ssh-keygen ; rend { priv, pub, fp } tels qu'OpenSSH les voit. */
function keygen(name: string, args: string[], passphrase = ""): { priv: string; pub: string; fp: string } {
  const path = join(dir, name);
  execFileSync("ssh-keygen", ["-q", "-f", path, "-N", passphrase, "-C", `test-${name}`, ...args]);
  const fp = execFileSync("ssh-keygen", ["-l", "-E", "sha256", "-f", `${path}.pub`]).toString().split(" ")[1]!;
  return { priv: readFileSync(path, "utf8"), pub: readFileSync(`${path}.pub`, "utf8").trim(), fp };
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
    return "ok";
  } catch (e) {
    return e instanceof SshKeyImportError ? e.code : `autre: ${(e as Error).message}`;
  }
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "ssh-keys-"));
});

describe("génération ed25519", () => {
  it("rend une clé publique OpenSSH et une empreinte que ssh-keygen reconnaît", () => {
    const k = generateSshKey("gael@poste");
    expect(k.algorithm).toBe("ssh-ed25519");
    expect(k.publicKey).toMatch(/^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA[A-Za-z0-9+/]+ gael@poste$/);
    expect(k.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    expect(k.privateKeyPem).toContain("BEGIN PRIVATE KEY");
    if (HAS_SSH_KEYGEN) {
      const pubPath = join(dir, "gen.pub");
      writeFileSync(pubPath, k.publicKey + "\n");
      const fp = execFileSync("ssh-keygen", ["-l", "-E", "sha256", "-f", pubPath]).toString().split(" ")[1];
      expect(fp).toBe(k.fingerprint);
    }
  });

  it("la clé stockée signe, et la signature se vérifie avec la clé publique", () => {
    const k = generateSshKey();
    const data = Buffer.from("challenge");
    const signature = sign(null, data, loadStoredSshKey(k.privateKeyPem));
    expect(verify(null, data, createPublicKey(k.privateKeyPem), signature)).toBe(true);
  });

  it("deux générations donnent deux clés", () => {
    expect(generateSshKey().fingerprint).not.toBe(generateSshKey().fingerprint);
  });

  it("le commentaire est nettoyé (pas de retour à la ligne dans authorized_keys)", () => {
    expect(generateSshKey("a\nb\tc").publicKey.endsWith(" abc")).toBe(true);
  });
});

describe.skipIf(!HAS_SSH_KEYGEN)("import de clés produites par ssh-keygen", () => {
  it("ed25519, format OpenSSH, sans phrase de passe : même clé publique, même empreinte", () => {
    const k = keygen("ed", ["-t", "ed25519"]);
    const m = importSshKey(k.priv);
    expect(m.publicKey).toBe(k.pub);
    expect(m.fingerprint).toBe(k.fp);
  });

  it("ed25519 protégée par une phrase de passe (bcrypt + aes256-ctr)", () => {
    const k = keygen("ed-pass", ["-t", "ed25519"], "correct horse");
    expect(codeOf(() => importSshKey(k.priv))).toBe("passphrase_required");
    expect(codeOf(() => importSshKey(k.priv, "mauvaise"))).toBe("wrong_passphrase");
    expect(importSshKey(k.priv, "correct horse").fingerprint).toBe(k.fp);
  }, RSA_TIMEOUT);

  it("RSA 3072, format OpenSSH, avec phrase de passe", () => {
    const k = keygen("rsa", ["-t", "rsa", "-b", "3072"], "secret-rsa");
    const m = importSshKey(k.priv, "secret-rsa");
    expect(m.algorithm).toBe("ssh-rsa");
    expect(m.publicKey).toBe(k.pub);
    expect(m.fingerprint).toBe(k.fp);
    // La clé reconstruite (dp, dq calculés) signe correctement.
    const sig = sign("sha256", Buffer.from("x"), loadStoredSshKey(m.privateKeyPem));
    expect(verify("sha256", Buffer.from("x"), createPublicKey(m.privateKeyPem), sig)).toBe(true);
  }, RSA_TIMEOUT);

  it("RSA 3072 au format PEM (PKCS#1), chiffrée ou non", () => {
    const plain = keygen("rsa-pem", ["-t", "rsa", "-b", "3072", "-m", "PEM"]);
    expect(importSshKey(plain.priv).fingerprint).toBe(plain.fp);
    const enc = keygen("rsa-pem-enc", ["-t", "rsa", "-b", "3072", "-m", "PEM"], "pem-pass");
    expect(codeOf(() => importSshKey(enc.priv))).toBe("passphrase_required");
    expect(importSshKey(enc.priv, "pem-pass").fingerprint).toBe(enc.fp);
  }, RSA_TIMEOUT);

  it("ed25519 au format PKCS#8", () => {
    const k = keygen("ed-pkcs8", ["-t", "ed25519", "-m", "PKCS8"]);
    expect(importSshKey(k.priv).fingerprint).toBe(k.fp);
  });

  it("refuse RSA 2048, ECDSA et un texte quelconque", () => {
    expect(codeOf(() => importSshKey(keygen("rsa2k", ["-t", "rsa", "-b", "2048"]).priv))).toBe("rsa_too_short");
    expect(codeOf(() => importSshKey(keygen("ec", ["-t", "ecdsa"]).priv))).toBe("unsupported_algorithm");
    expect(codeOf(() => importSshKey(keygen("ec-pem", ["-t", "ecdsa", "-m", "PEM"]).priv))).toBe("unsupported_algorithm");
    expect(codeOf(() => importSshKey("bonjour"))).toBe("unrecognized_format");
    expect(codeOf(() => importSshKey(""))).toBe("unrecognized_format");
  }, RSA_TIMEOUT);

  it("refuse une clé dont le KDF demande trop de tours (bloquerait le serveur)", () => {
    const k = keygen("ed-rounds", ["-t", "ed25519", "-a", "200"], "phrase");
    expect(codeOf(() => importSshKey(k.priv, "phrase"))).toBe("kdf_rounds_too_high");
    // …et ce, AVANT tout calcul : le refus est immédiat.
    const t = Date.now();
    expect(codeOf(() => importSshKey(k.priv, "phrase"))).toBe("kdf_rounds_too_high");
    expect(Date.now() - t).toBeLessThan(500);
  });

  it("refuse une clé publique collée à la place de la clé privée", () => {
    expect(codeOf(() => importSshKey(keygen("pub-only", ["-t", "ed25519"]).pub))).toBe("unrecognized_format");
  });
});
