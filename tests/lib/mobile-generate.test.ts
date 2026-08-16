// Génération du matériel de signature (lib/mobile-generate.ts) — Phase 7,
// cf. documentation/plans/deploiement-mobile.md §5.5.
//
// Seule la moitié LOCALE est exercée ici : keystore Android (autonome), paire +
// CSR iOS, et assemblage du `.p12`. Les deux appels Apple (émission du
// certificat, création du profil) demandent un compte réel — ils suivront la
// même règle que le reste du chantier : un test de fumée sur du vrai matériel,
// pas un mock qui se contenterait de confirmer nos hypothèses.
//
// Ce qui compte le plus ici : ce que la génération produit doit être relisible
// par la chaîne d'inspection déjà livrée (Phase 2). On ne teste donc pas
// « openssl a écrit un fichier », on teste que `verifyMobileApp` valide ce qui
// vient d'être généré — l'aller-retour complet.

import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assembleIosP12,
  generateAndroidUploadKeystore,
  generateIosCsr,
  sanitizeDnValue,
} from "@/lib/mobile-generate";
import { inspectPkcs12 } from "@/lib/mobile-inspect";

const run = promisify(execFile);

function valueOf(creds: Array<{ kind: string; valueBase64: string }>, kind: string): string {
  const c = creds.find((x) => x.kind === kind);
  if (!c) throw new Error(`credential ${kind} absent`);
  return Buffer.from(c.valueBase64, "base64").toString("utf8");
}

describe("sanitizeDnValue", () => {
  it("retire les séparateurs de RDN — pas d'injection de DN", () => {
    // `execFile` bloque l'injection SHELL, pas l'injection de DN : sans ce
    // nettoyage, ce nom d'app ajouterait une organisation au certificat.
    expect(sanitizeDnValue("Mon App/O=Autre", "fallback")).toBe("Mon App O Autre");
    expect(sanitizeDnValue("a,b+c<d>e;f", "fallback")).toBe("a b c d e f");
  });

  it("borne à 64 caractères (limite d'une valeur X.509)", () => {
    expect(sanitizeDnValue("x".repeat(200), "fallback")).toHaveLength(64);
  });

  it("retombe sur le fallback quand il ne reste rien", () => {
    expect(sanitizeDnValue("///", "fr.argoweb.app")).toBe("fr.argoweb.app");
    expect(sanitizeDnValue("   ", "fr.argoweb.app")).toBe("fr.argoweb.app");
  });
});

describe("generateAndroidUploadKeystore", () => {
  it("produit les quatre credentials attendus par le CI", async () => {
    const r = await generateAndroidUploadKeystore({
      displayName: "Mon Application",
      bundleId: "fr.argoweb.exemple",
    });
    expect(r.credentials.map((c) => c.kind).sort()).toEqual([
      "android_key_alias",
      "android_key_password",
      "android_keystore",
      "android_keystore_password",
    ]);
  }, 30_000);

  it("le keystore s'ouvre avec le mot de passe généré, sous l'alias déclaré", async () => {
    const r = await generateAndroidUploadKeystore({
      displayName: "Mon Application",
      bundleId: "fr.argoweb.exemple",
      alias: "upload",
    });
    const p12 = Buffer.from(
      r.credentials.find((c) => c.kind === "android_keystore")!.valueBase64,
      "base64",
    );
    const info = await inspectPkcs12(p12, valueOf(r.credentials, "android_keystore_password"));
    expect(info.readable).toBe(true);
    expect(info.aliases).toContain("upload");
    expect(info.sha256).toBe(r.summary.certificateSha256);
  }, 30_000);

  it("mot de passe de clé = mot de passe de magasin (un PKCS12 n'en admet qu'un)", async () => {
    const r = await generateAndroidUploadKeystore({
      displayName: "App",
      bundleId: "fr.argoweb.exemple",
    });
    expect(valueOf(r.credentials, "android_key_password")).toBe(
      valueOf(r.credentials, "android_keystore_password"),
    );
  }, 30_000);

  it("le certificat vit ~27 ans — Play refuse une clé d'upload à courte validité", async () => {
    const r = await generateAndroidUploadKeystore({
      displayName: "App",
      bundleId: "fr.argoweb.exemple",
    });
    const years =
      (new Date(r.summary.validUntil).getTime() - Date.now()) / (365.25 * 86_400_000);
    expect(years).toBeGreaterThan(25);
  }, 30_000);

  it("normalise l'alias en minuscules (keytool le fait aussi)", async () => {
    const r = await generateAndroidUploadKeystore({
      displayName: "App",
      bundleId: "fr.argoweb.exemple",
      alias: "MonAlias",
    });
    expect(r.summary.alias).toBe("monalias");
  }, 30_000);

  it("deux générations ne partagent ni clé ni mot de passe", async () => {
    const [a, b] = await Promise.all([
      generateAndroidUploadKeystore({ displayName: "App", bundleId: "fr.a.b" }),
      generateAndroidUploadKeystore({ displayName: "App", bundleId: "fr.a.b" }),
    ]);
    expect(a.summary.certificateSha256).not.toBe(b.summary.certificateSha256);
    expect(valueOf(a.credentials, "android_keystore_password")).not.toBe(
      valueOf(b.credentials, "android_keystore_password"),
    );
  }, 45_000);
});

describe("generateIosCsr", () => {
  it("produit une CSR que openssl relit, avec le bon CN", async () => {
    const { csrPem, privateKeyPem } = await generateIosCsr({
      displayName: "Mon Application",
      bundleId: "fr.argoweb.exemple",
    });
    expect(csrPem).toContain("BEGIN CERTIFICATE REQUEST");
    expect(privateKeyPem).toContain("PRIVATE KEY");

    const dir = await mkdtemp(join(tmpdir(), "csr-test-"));
    try {
      const p = join(dir, "req.csr");
      await writeFile(p, csrPem);
      // `-verify` : la CSR doit être auto-cohérente (signature valide sur la
      // clé publique qu'elle porte). C'est ce qu'Apple vérifiera en premier.
      const { stdout } = await run("openssl", ["req", "-in", p, "-noout", "-subject", "-verify"]);
      expect(stdout).toContain("Mon Application");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("assembleIosP12", () => {
  it("recombine clé privée et certificat en un .p12 relisible", async () => {
    // On simule le retour d'Apple : un certificat DER émis pour NOTRE clé.
    // Apple renvoie du DER, jamais du PEM — c'est la conversion qui est testée.
    const { privateKeyPem } = await generateIosCsr({
      displayName: "Distribution",
      bundleId: "fr.argoweb.exemple",
    });
    const dir = await mkdtemp(join(tmpdir(), "p12-test-"));
    try {
      const keyPath = join(dir, "key.pem");
      const certPath = join(dir, "cert.der");
      await writeFile(keyPath, privateKeyPem);
      await run("openssl", [
        "req", "-x509", "-key", keyPath, "-out", certPath,
        "-outform", "der", "-days", "365",
        "-subj", "/CN=Physalis Test Distribution",
      ]);

      const { readFile } = await import("node:fs/promises");
      const der = await readFile(certPath);
      const out = await assembleIosP12(privateKeyPem, der);

      const info = await inspectPkcs12(Buffer.from(out.p12Base64, "base64"), out.passphrase);
      expect(info.readable).toBe(true);
      expect(info.subject).toContain("Physalis Test Distribution");
      // L'empreinte annoncée doit être celle du certificat réellement scellé —
      // sinon la corrélation profil↔certificat de la Phase 2 mentirait.
      expect(info.sha256).toBe(out.sha256);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
