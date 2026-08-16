// Extraction d'`expiresAt` à l'import d'un MobileCredential (lib/mobile-expiry.ts).
//
// Ce module est le PREMIER `execFile` de `lib/`/`app/` — le plan
// (deploiement-mobile.md §5.4) affirmait `node:crypto` suffisant, ce qui est
// faux pour désenvelopper un PKCS12 ou un CMS. Le shell-out vers `openssl`
// méritait donc d'être exercé sur du vrai matériel plutôt que relu.
//
// Les fixtures sont FABRIQUÉES à l'exécution, pas commitées : un `.p12` en
// dépôt vieillit (sa date d'expiration finit par tomber dans le passé et le
// test devient rouge sans qu'aucun code n'ait changé), et un certificat même
// jetable dans un gestionnaire de secrets envoie un mauvais signal.
//
// `openssl` est une dépendance assumée : c'est l'objet même du test, et le
// binaire est présent dans l'image runtime (Dockerfile, stage `base`).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  extractExpiresAt,
  extractP12Expiry,
  extractMobileProvisionExpiry,
} from "@/lib/mobile-expiry";

const run = promisify(execFile);

const PASSPHRASE = "correct horse battery staple";
const VALIDITY_DAYS = 365;

let dir: string;
let p12: Buffer;
let legacyP12: Buffer;
let noPassP12: Buffer;
let profile: Buffer;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "mobile-expiry-test-"));
  const keyPath = join(dir, "key.pem");
  const certPath = join(dir, "cert.pem");
  const p12Path = join(dir, "cert.p12");

  // Certificat auto-signé — l'équivalent jetable d'un certificat de
  // distribution Apple pour ce qui nous intéresse : un X.509 avec un notAfter.
  await run("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", keyPath, "-out", certPath,
    "-days", String(VALIDITY_DAYS),
    "-subj", "/CN=Physalis Test Distribution",
  ]);
  await run("openssl", [
    "pkcs12", "-export", "-out", p12Path,
    "-inkey", keyPath, "-in", certPath,
    "-passout", `pass:${PASSPHRASE}`,
  ]);
  p12 = await readFile(p12Path);

  // Le cas NOMINAL d'Apple : un `.p12` sorti du Trousseau macOS est chiffré en
  // RC2-40-CBC, qu'OpenSSL 3 refuse sans `-legacy`. C'est ce qui faisait
  // remonter une date pour le profil de provisioning et aucune pour le
  // certificat de distribution.
  const legacyPath = join(dir, "legacy.p12");
  await run("openssl", [
    "pkcs12", "-export", "-legacy", "-out", legacyPath,
    "-inkey", keyPath, "-in", certPath,
    "-passout", `pass:${PASSPHRASE}`,
  ]);
  legacyP12 = await readFile(legacyPath);

  // PKCS12 sans mot de passe : l'import ne doit pas renoncer à lire la date
  // sous prétexte qu'aucune passphrase n'a été saisie.
  const noPassPath = join(dir, "nopass.p12");
  await run("openssl", [
    "pkcs12", "-export", "-out", noPassPath,
    "-inkey", keyPath, "-in", certPath,
    "-passout", "pass:",
  ]);
  noPassP12 = await readFile(noPassPath);

  // Profil de provisioning : un plist signé CMS non chiffré — exactement la
  // forme d'un `.mobileprovision`, que l'app lit avec `smime -verify -noverify`.
  const plistPath = join(dir, "profile.plist");
  await writeFile(
    plistPath,
    `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>Name</key><string>Physalis Test Profile</string>
  <key>ExpirationDate</key><date>2027-03-04T10:20:30Z</date>
</dict></plist>`,
  );
  const signedPath = join(dir, "profile.mobileprovision");
  await run("openssl", [
    "smime", "-sign", "-in", plistPath, "-out", signedPath,
    "-signer", certPath, "-inkey", keyPath,
    "-outform", "der", "-nodetach",
  ]);
  profile = await readFile(signedPath);
}, 60_000);

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("extractP12Expiry", () => {
  it("lit le notAfter du certificat de distribution", async () => {
    const got = await extractP12Expiry(p12, PASSPHRASE);
    expect(got).toBeInstanceOf(Date);
    const expected = Date.now() + VALIDITY_DAYS * 86_400_000;
    // Tolérance d'un jour : openssl arrondit à la seconde, pas le test.
    expect(Math.abs(got!.getTime() - expected)).toBeLessThan(86_400_000);
  });

  it("lit un PKCS12 chiffré en RC2-40 (export Trousseau macOS) via -legacy", async () => {
    const got = await extractP12Expiry(legacyP12, PASSPHRASE);
    expect(got).toBeInstanceOf(Date);
  });

  it("lit un PKCS12 sans mot de passe (passphrase vide)", async () => {
    await expect(extractP12Expiry(noPassP12, "")).resolves.toBeInstanceOf(Date);
  });

  it("rend null sur une mauvaise passphrase, sans lever", async () => {
    await expect(extractP12Expiry(p12, "mauvaise")).resolves.toBeNull();
  });

  it("rend null sur un fichier qui n'est pas un PKCS12", async () => {
    const garbage = Buffer.from("ceci n'est pas un keystore", "utf8");
    await expect(extractP12Expiry(garbage, PASSPHRASE)).resolves.toBeNull();
  });
});

describe("extractMobileProvisionExpiry", () => {
  it("lit ExpirationDate dans le plist signé CMS", async () => {
    const got = await extractMobileProvisionExpiry(profile);
    expect(got?.toISOString()).toBe("2027-03-04T10:20:30.000Z");
  });

  it("rend null sur un fichier qui n'est pas un CMS", async () => {
    await expect(
      extractMobileProvisionExpiry(Buffer.from("<plist/>", "utf8")),
    ).resolves.toBeNull();
  });
});

describe("extractExpiresAt — dispatch par kind", () => {
  it("android_keystore et ios_p12 passent par le PKCS12", async () => {
    for (const kind of ["android_keystore", "ios_p12"]) {
      const got = await extractExpiresAt(kind, p12, PASSPHRASE);
      expect(got, kind).toBeInstanceOf(Date);
    }
  });

  it("sans passphrase saisie, tente quand même la passphrase vide", async () => {
    // Protégé par un p12 SANS mot de passe : la date doit remonter.
    await expect(extractExpiresAt("ios_p12", noPassP12)).resolves.toBeInstanceOf(Date);
    // Et sur un p12 protégé, l'absence de passphrase reste un null silencieux.
    await expect(extractExpiresAt("ios_p12", p12)).resolves.toBeNull();
  });

  it("ios_profile lit le profil", async () => {
    await expect(extractExpiresAt("ios_profile", profile)).resolves.toBeInstanceOf(Date);
  });

  it("les kinds sans notion d'expiration rendent null", async () => {
    for (const kind of [
      "asc_api_key",
      "asc_key_id",
      "asc_issuer_id",
      "ios_p12_password",
      "android_key_alias",
      "play_service_account",
    ]) {
      await expect(extractExpiresAt(kind, p12, PASSPHRASE), kind).resolves.toBeNull();
    }
  });
});
