// Validation d'accréditation du matériel mobile (lib/mobile-inspect.ts +
// lib/mobile-verify.ts). Cf. documentation/plans/deploiement-mobile.md §7.
//
// Même parti pris que mobile-expiry.test.ts : les fixtures sont FABRIQUÉES à
// l'exécution avec openssl, jamais commitées. Un `.p12` en dépôt vieillit
// (son notAfter finit dans le passé et le test rougit sans qu'aucun code
// n'ait changé), et du matériel de signature même jetable n'a rien à faire
// dans un dépôt de gestionnaire de secrets.
//
// Ce qui est réellement exercé ici, c'est la classe d'erreur que la Phase 2
// visait : un keystore dont l'alias déclaré n'existe pas, un profil qui ne
// couvre pas le bundle id, un profil qui n'embarque pas le certificat déposé.
// Toutes échouaient jusqu'ici AU PREMIER DÉPLOIEMENT, dans un log de CI.
//
// Les sondes réseau (Google/Apple) sont volontairement HORS test : les
// exercer demanderait des identifiants réels. On vérifie à la place qu'elles
// se déclarent `skipped` sans réseau — et surtout qu'un contrôle sauté ne se
// confond jamais avec un contrôle réussi.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { encrypt } from "@/lib/crypto";
import {
  inspectPkcs12,
  inspectProvisioningProfile,
  profileCoversBundleId,
} from "@/lib/mobile-inspect";
import { verifyMobileApp } from "@/lib/mobile-verify";
import type { MobileCheck } from "@/lib/mobile-verify";

const run = promisify(execFile);

const PASSPHRASE = "correct horse battery staple";
const ALIAS = "upload";
const BUNDLE_ID = "fr.argoweb.exemple";

let dir: string;
let keystore: Buffer;
let p12: Buffer;
let profileMatching: Buffer;
let profileOtherBundle: Buffer;
let certSha256: string;

/** Fabrique un `.mobileprovision` : un plist signé CMS, non chiffré. */
async function signProfile(name: string, plist: string): Promise<Buffer> {
  const plistPath = join(dir, `${name}.plist`);
  const outPath = join(dir, `${name}.mobileprovision`);
  await writeFile(plistPath, plist);
  await run("openssl", [
    "smime", "-sign", "-in", plistPath, "-out", outPath,
    "-signer", join(dir, "cert.pem"), "-inkey", join(dir, "key.pem"),
    "-outform", "der", "-nodetach",
  ]);
  return readFile(outPath);
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "mobile-verify-test-"));
  const keyPath = join(dir, "key.pem");
  const certPath = join(dir, "cert.pem");

  await run("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", keyPath, "-out", certPath,
    "-days", "365",
    "-subj", "/CN=Physalis Test Distribution",
  ]);

  // Keystore Android : un PKCS12 dont le sac porte un `friendlyName` — c'est
  // exactement ce que keytool appelle un « alias ».
  const keystorePath = join(dir, "upload.keystore");
  await run("openssl", [
    "pkcs12", "-export", "-out", keystorePath,
    "-inkey", keyPath, "-in", certPath,
    "-name", ALIAS,
    "-passout", `pass:${PASSPHRASE}`,
  ]);
  keystore = await readFile(keystorePath);

  // Certificat de distribution iOS : même conteneur, sans alias nommé.
  const p12Path = join(dir, "dist.p12");
  await run("openssl", [
    "pkcs12", "-export", "-out", p12Path,
    "-inkey", keyPath, "-in", certPath,
    "-passout", `pass:${PASSPHRASE}`,
  ]);
  p12 = await readFile(p12Path);

  // Le DER du certificat, tel qu'un profil de provisioning l'embarque dans
  // `DeveloperCertificates` — c'est ce qui permet la corrélation profil↔.p12.
  const derPath = join(dir, "cert.der");
  await run("openssl", [
    "x509", "-in", certPath, "-outform", "der", "-out", derPath,
  ]);
  const certDerB64 = (await readFile(derPath)).toString("base64");

  const plist = (appId: string, extra = "") => `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>Name</key><string>Physalis Test Profile</string>
  <key>ExpirationDate</key><date>2027-03-04T10:20:30Z</date>
  <key>TeamIdentifier</key><array><string>ABCDE12345</string></array>
  <key>DeveloperCertificates</key><array><data>${certDerB64}</data></array>
  <key>Entitlements</key><dict>
    <key>application-identifier</key><string>ABCDE12345.${appId}</string>
  </dict>${extra}
</dict></plist>`;

  profileMatching = await signProfile("ok", plist(BUNDLE_ID));
  profileOtherBundle = await signProfile("other", plist("com.autre.app"));

  const info = await inspectPkcs12(p12, PASSPHRASE);
  certSha256 = info.sha256!;
}, 90_000);

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

// ── Inspection locale ──────────────────────────────────────────────────────

describe("inspectPkcs12", () => {
  it("remonte l'alias (friendlyName) et l'empreinte du certificat", async () => {
    const info = await inspectPkcs12(keystore, PASSPHRASE);
    expect(info.readable).toBe(true);
    expect(info.aliases).toContain(ALIAS);
    expect(info.sha256).toMatch(/^[0-9A-F]{64}$/);
    expect(info.notAfter).toBeInstanceOf(Date);
  });

  it("rend readable:false sur une mauvaise passphrase, sans lever", async () => {
    const info = await inspectPkcs12(keystore, "mauvaise");
    expect(info.readable).toBe(false);
    expect(info.aliases).toEqual([]);
  });

  it("rend readable:false sur un fichier qui n'est pas un PKCS12", async () => {
    const info = await inspectPkcs12(Buffer.from("pas un keystore"), PASSPHRASE);
    expect(info.readable).toBe(false);
  });
});

describe("inspectProvisioningProfile", () => {
  it("lit le bundle id, le Team ID et les certificats embarqués", async () => {
    const info = await inspectProvisioningProfile(profileMatching);
    expect(info.readable).toBe(true);
    // Le Team ID est un PRÉFIXE de `application-identifier`, pas une partie du
    // bundle id — c'est ce découpage qui est vérifié ici.
    expect(info.appIdPattern).toBe(BUNDLE_ID);
    expect(info.teamId).toBe("ABCDE12345");
    expect(info.certificateSha256).toContain(certSha256);
    expect(info.expiresAt?.toISOString()).toBe("2027-03-04T10:20:30.000Z");
    expect(info.hasProvisionedDevices).toBe(false);
    expect(info.isDevelopment).toBe(false);
  });

  it("repère un profil de développement et un profil ad hoc", async () => {
    const dev = await signProfile(
      "dev",
      `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>Entitlements</key><dict>
    <key>application-identifier</key><string>ABCDE12345.${BUNDLE_ID}</string>
    <key>get-task-allow</key><true/>
  </dict>
  <key>ProvisionedDevices</key><array><string>0001</string></array>
</dict></plist>`,
    );
    const info = await inspectProvisioningProfile(dev);
    expect(info.isDevelopment).toBe(true);
    expect(info.hasProvisionedDevices).toBe(true);
  });

  it("rend readable:false sur un fichier qui n'est pas un CMS", async () => {
    const info = await inspectProvisioningProfile(Buffer.from("<plist/>"));
    expect(info.readable).toBe(false);
  });
});

describe("profileCoversBundleId", () => {
  it("accepte l'égalité stricte et les jokers de SUFFIXE uniquement", () => {
    expect(profileCoversBundleId("fr.argoweb.exemple", BUNDLE_ID)).toBe(true);
    expect(profileCoversBundleId("*", BUNDLE_ID)).toBe(true);
    expect(profileCoversBundleId("fr.argoweb.*", BUNDLE_ID)).toBe(true);
    expect(profileCoversBundleId("fr.autre.*", BUNDLE_ID)).toBe(false);
    expect(profileCoversBundleId("com.autre.app", BUNDLE_ID)).toBe(false);
    expect(profileCoversBundleId(null, BUNDLE_ID)).toBe(false);
  });

  it("ne traite pas le motif comme une expression régulière", () => {
    // Le motif vient d'un fichier IMPORTÉ : s'il était compilé en regex, un
    // `.` y matcherait n'importe quel caractère et un profil « fr.argowebX »
    // couvrirait « fr.argoweb.exemple ».
    expect(profileCoversBundleId("fr.argoweb.exempl.", BUNDLE_ID)).toBe(false);
    expect(profileCoversBundleId(".*", BUNDLE_ID)).toBe(false);
  });
});

// ── Rapport complet ────────────────────────────────────────────────────────

/** Client Prisma minimal : `verifyMobileApp` ne lit qu'une table. */
function fakeDb(creds: Record<string, Buffer | string>) {
  const rows = Object.entries(creds).map(([kind, value]) => {
    const base64 = Buffer.isBuffer(value)
      ? value.toString("base64")
      : Buffer.from(value, "utf8").toString("base64");
    return { kind, ...encrypt(base64) };
  });
  return {
    mobileCredential: { findMany: async () => rows },
  } as unknown as Parameters<typeof verifyMobileApp>[0];
}

function find(checks: MobileCheck[], code: string): MobileCheck | undefined {
  return checks.find((c) => c.code === code);
}

const ANDROID_APP = {
  id: "app_android",
  platform: "android",
  bundleId: BUNDLE_ID,
  vendorTeamId: null,
};
const IOS_APP = {
  id: "app_ios",
  platform: "ios",
  bundleId: BUNDLE_ID,
  vendorTeamId: "ABCDE12345",
};

describe("verifyMobileApp — Android", () => {
  it("valide un keystore dont l'alias déclaré existe", async () => {
    const db = fakeDb({
      android_keystore: keystore,
      android_keystore_password: PASSPHRASE,
      android_key_alias: ALIAS,
      play_service_account: "{}",
    });
    const report = await verifyMobileApp(db, ANDROID_APP, { network: false });
    expect(find(report.checks, "complete")?.status).toBe("ok");
    expect(find(report.checks, "keystore_alias_ok")?.status).toBe("ok");
  });

  it("attrape l'alias absent du keystore — le cas qui cassait au build", async () => {
    const db = fakeDb({
      android_keystore: keystore,
      android_keystore_password: PASSPHRASE,
      android_key_alias: "inexistant",
      play_service_account: "{}",
    });
    const report = await verifyMobileApp(db, ANDROID_APP, { network: false });
    const check = find(report.checks, "keystore_alias_absent");
    expect(check?.status).toBe("fail");
    // Le message doit dire ce qui EXISTE, sinon l'utilisateur ne sait pas quoi
    // corriger — c'est toute la différence avec « échec de signature ».
    expect(String(check?.params?.found)).toContain(ALIAS);
  });

  it("tolère la casse de l'alias (keytool normalise en minuscules)", async () => {
    const db = fakeDb({
      android_keystore: keystore,
      android_keystore_password: PASSPHRASE,
      android_key_alias: ALIAS.toUpperCase(),
      play_service_account: "{}",
    });
    const report = await verifyMobileApp(db, ANDROID_APP, { network: false });
    expect(find(report.checks, "keystore_alias_ok")?.status).toBe("ok");
  });

  it("avertit quand le mot de passe de clé diffère de celui du magasin", async () => {
    const db = fakeDb({
      android_keystore: keystore,
      android_keystore_password: PASSPHRASE,
      android_key_password: "autre chose",
      android_key_alias: ALIAS,
      play_service_account: "{}",
    });
    const report = await verifyMobileApp(db, ANDROID_APP, { network: false });
    expect(find(report.checks, "keystore_key_password_differs")?.status).toBe("warn");
  });

  it("liste le matériel manquant plutôt que de se taire", async () => {
    const report = await verifyMobileApp(fakeDb({}), ANDROID_APP, {
      network: false,
    });
    const missing = find(report.checks, "missing");
    expect(missing?.status).toBe("fail");
    expect(String(missing?.params?.kinds)).toContain("android_keystore");
  });
});

describe("verifyMobileApp — iOS", () => {
  const base = () => ({
    ios_p12: p12,
    ios_p12_password: PASSPHRASE,
    asc_api_key: "-----BEGIN PRIVATE KEY-----",
    asc_key_id: "ABC123",
    asc_issuer_id: "0000-1111",
  });

  it("corrèle le certificat déposé avec ceux du profil", async () => {
    const db = fakeDb({ ...base(), ios_profile: profileMatching });
    const report = await verifyMobileApp(db, IOS_APP, { network: false });
    expect(find(report.checks, "profile_bundle_ok")?.status).toBe("ok");
    expect(find(report.checks, "profile_cert_match")?.status).toBe("ok");
  });

  it("attrape un profil qui ne couvre pas ce bundle id", async () => {
    const db = fakeDb({ ...base(), ios_profile: profileOtherBundle });
    const report = await verifyMobileApp(db, IOS_APP, { network: false });
    const check = find(report.checks, "profile_bundle_mismatch");
    expect(check?.status).toBe("fail");
    expect(check?.params?.pattern).toBe("com.autre.app");
  });

  it("attrape un profil qui n'embarque pas le certificat déposé", async () => {
    // Un second certificat, sans rapport : le profil de référence ne le
    // contient pas. C'est le classique « certificat renouvelé, profil oublié ».
    const otherKey = join(dir, "other-key.pem");
    const otherCert = join(dir, "other-cert.pem");
    const otherP12 = join(dir, "other.p12");
    await run("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", otherKey, "-out", otherCert,
      "-days", "365", "-subj", "/CN=Autre Certificat",
    ]);
    await run("openssl", [
      "pkcs12", "-export", "-out", otherP12,
      "-inkey", otherKey, "-in", otherCert,
      "-passout", `pass:${PASSPHRASE}`,
    ]);

    const db = fakeDb({
      ...base(),
      ios_p12: await readFile(otherP12),
      ios_profile: profileMatching,
    });
    const report = await verifyMobileApp(db, IOS_APP, { network: false });
    expect(find(report.checks, "profile_cert_mismatch")?.status).toBe("fail");
  }, 30_000);
});

describe("verifyMobileApp — invariants du rapport", () => {
  it("un contrôle sauté n'est JAMAIS un contrôle réussi", async () => {
    // La leçon du `.p12` sans date (§5.4) : sans réseau, les sondes magasin
    // doivent se déclarer `skipped`, jamais `ok`.
    const db = fakeDb({
      android_keystore: keystore,
      android_keystore_password: PASSPHRASE,
      android_key_alias: ALIAS,
      play_service_account: "{}",
    });
    const report = await verifyMobileApp(db, ANDROID_APP, { network: false });
    expect(report.network).toBe(false);
    const play = report.checks.filter((c) => c.id === "play");
    expect(play).toHaveLength(1);
    expect(play[0].status).toBe("skipped");
    expect(play[0].code).toBe("play_offline");
  });

  it("ne lève jamais, même sans aucun credential", async () => {
    await expect(
      verifyMobileApp(fakeDb({}), IOS_APP, { network: false }),
    ).resolves.toMatchObject({ network: false });
  });

  it("une plateforme inconnue rend un rapport, pas une erreur", async () => {
    const report = await verifyMobileApp(
      fakeDb({}),
      { ...ANDROID_APP, platform: "windows" },
      { network: false },
    );
    // Pas de matériel requis connu → complétude « ok » par vacuité, et aucune
    // vérification de plateforme. Le rapport reste bien formé.
    expect(find(report.checks, "complete")?.status).toBe("ok");
  });
});
