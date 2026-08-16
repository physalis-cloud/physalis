// Chantier "Déploiement mobile" — Phase 7 : GÉNÉRER le matériel de signature,
// pas seulement le déposer. Cf. documentation/plans/deploiement-mobile.md §5.5.
//
// C'est le prolongement de §5.2 : on ne remplace plus le coffre de `match`, on
// remplace `match` entier (`cert` + `sigh`). Et le mythe à tuer d'abord : **un
// Mac n'est PAS nécessaire pour GÉNÉRER du matériel iOS**, seulement pour
// COMPILER. Toute la chaîne de signature est de l'openssl et de l'API App Store
// Connect — exactement ce que fait `match`, qui ne tourne pas sur un Mac.
//
// ⚠️ L'argument de sécurité qui vend, et qu'il ne faut pas éroder : **la clé
// privée ne quitte jamais le vault**. `match` la range dans un dépôt git chiffré
// par une passphrase d'équipe (sans RBAC, sans audit, sans révocation
// individuelle) ; ici elle naît dans un fichier temporaire 0600, repart chiffrée
// sous `ENCRYPTION_KEY`, et le temporaire est détruit en `finally`. Aucune
// fonction de ce module ne retourne, ne logge ni ne met en cache une clé privée
// en clair.
//
// ⚠️ SERVER-ONLY (lib/openssl.ts → node:child_process).

import { X509Certificate } from "node:crypto";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePassword } from "./generate-password";
import { runOpenssl } from "./openssl";
import { inspectPkcs12 } from "./mobile-inspect";
import {
  AscApiError,
  ascCreateAppStoreProfile,
  ascCreateDistributionCertificate,
  ascFindBundleIdResource,
  ascListDistributionCertificates,
} from "./mobile-store-api";
import type { AscAuth, AscCertificate } from "./mobile-store-api";

/**
 * Validité du certificat d'une clé d'UPLOAD Android.
 *
 * 10 000 jours (~27 ans) est la valeur canonique de la documentation Android
 * (`keytool -validity 10000`), et ce n'est pas cosmétique : Google Play EXIGE
 * une clé d'upload dont le certificat reste valide très au-delà de la durée de
 * vie de l'application. Un certificat court condamnerait l'app à un reset de
 * clé chez Google — une procédure manuelle, avec délai.
 */
const ANDROID_VALIDITY_DAYS = 10_000;

/** Longueur de la passphrase générée. Elle n'est jamais tapée par un humain :
 *  elle voyage chiffrée jusqu'au CI, qui la reçoit dans le bundle. */
const PASSPHRASE_LENGTH = 32;

/**
 * Nettoie une valeur destinée à un composant de DN X.509 (`-subj`).
 *
 * `execFile` interdit déjà l'injection SHELL (argv en tableau, pas de
 * `/bin/sh`), mais PAS l'injection de DN : un nom d'application valant
 * `Mon App/O=Autre` ajouterait une organisation au certificat. On retire donc
 * les séparateurs de RDN, et on borne la longueur (une valeur X.509 est
 * plafonnée à 64 caractères).
 */
export function sanitizeDnValue(value: string, fallback: string): string {
  const cleaned = value
    .replace(/[/=,+<>;"\\\r\n\t]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 64);
  return cleaned || fallback;
}

/** Une entrée à écrire dans `MobileCredential`, produite par une génération. */
export type GeneratedCredential = {
  kind: string;
  /** TOUJOURS du base64 — même contrat de stockage qu'à l'import (§4.4). */
  valueBase64: string;
  filename: string | null;
};

export type GeneratedKeystore = {
  credentials: GeneratedCredential[];
  /** Métadonnées affichables. Ne contient JAMAIS la clé ni la passphrase. */
  summary: {
    alias: string;
    validUntil: string;
    /** Empreinte SHA-256 du certificat — celle que Google affichera. */
    certificateSha256: string;
  };
};

/**
 * Génère un keystore d'UPLOAD Android, en autonomie complète (aucun compte,
 * aucun appel réseau — un keystore n'est que du crypto).
 *
 * ⚠️ Bien distinguer, et le dire à l'utilisateur (§6.1) : ceci est la clé
 * d'**upload**, celle que Play App Signing permet de RÉINITIALISER si elle est
 * perdue. La clé de **signature d'app**, elle, reste chez Google et n'est pas
 * exportable. Générer une clé d'upload est donc une opération récupérable —
 * c'est précisément ce qui la rend sûre à automatiser, contrairement à une clé
 * de signature d'app hors Play App Signing, dont la perte est définitive.
 */
export async function generateAndroidUploadKeystore(opts: {
  /** Sert de CN et de nom de fichier — assaini avant d'entrer dans le DN. */
  displayName: string;
  bundleId: string;
  alias?: string;
}): Promise<GeneratedKeystore> {
  const alias = (opts.alias?.trim() || "upload").toLowerCase();
  const cn = sanitizeDnValue(opts.displayName, opts.bundleId);
  const passphrase = generatePassword(PASSPHRASE_LENGTH);

  const dir = await mkdtemp(join(tmpdir(), "mobile-gen-"));
  const keyPath = join(dir, "key.pem");
  const certPath = join(dir, "cert.pem");
  const p12Path = join(dir, "upload.p12");
  try {
    // Paire RSA + certificat auto-signé, en un appel. `-nodes` : la clé sort en
    // clair sur le disque temporaire, puis est immédiatement scellée dans le
    // PKCS12 sous passphrase. Elle n'existe en clair que le temps de ces deux
    // commandes, dans un répertoire détruit en `finally`.
    await runOpenssl([
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", keyPath, "-out", certPath,
      "-days", String(ANDROID_VALIDITY_DAYS),
      "-sha256",
      "-subj", `/CN=${cn}`,
    ]);

    // PKCS12 et non JKS : c'est le format que `keytool` produit lui-même depuis
    // Java 9, celui que Gradle lit, et le seul qu'openssl sache relire — donc
    // le seul dont l'inspection (lib/mobile-inspect.ts) et la surveillance
    // d'expiration fonctionneront ensuite. Un JKS legacy serait un angle mort.
    await runOpenssl(
      [
        "pkcs12", "-export",
        "-inkey", keyPath, "-in", certPath,
        "-name", alias,
        "-out", p12Path,
        "-passout", "env:MOBILE_GEN_PASSOUT",
      ],
      { env: { MOBILE_GEN_PASSOUT: passphrase } },
    );

    const p12 = await readFile(p12Path);
    const certPem = await readFile(certPath, "utf8");
    const { validUntil, sha256 } = describeCertificate(certPem);

    return {
      credentials: [
        {
          kind: "android_keystore",
          valueBase64: p12.toString("base64"),
          filename: `${alias}.p12`,
        },
        ...textCredential("android_keystore_password", passphrase),
        ...textCredential("android_key_alias", alias),
        // Un conteneur PKCS12 n'accepte qu'UN mot de passe : celui de la clé
        // est nécessairement celui du magasin. On l'écrit explicitement plutôt
        // que de laisser le CI deviner — et `verifyMobileApp` vérifie d'ailleurs
        // que les deux coïncident.
        ...textCredential("android_key_password", passphrase),
      ],
      summary: { alias, validUntil, certificateSha256: sha256 },
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function textCredential(kind: string, value: string): GeneratedCredential[] {
  return [
    { kind, valueBase64: Buffer.from(value, "utf8").toString("base64"), filename: null },
  ];
}

/** `notAfter` + empreinte SHA-256 d'un certificat PEM, via la stdlib (pas de
 *  shell-out : X509Certificate lit un PEM directement). */
function describeCertificate(pem: string): { validUntil: string; sha256: string } {
  const cert = new X509Certificate(pem);
  const notAfter = new Date(cert.validTo);
  return {
    validUntil: Number.isNaN(notAfter.getTime())
      ? "—"
      : notAfter.toISOString().slice(0, 10),
    sha256: cert.fingerprint256.replace(/:/g, "").toUpperCase(),
  };
}

// ── iOS : la paire et la CSR (l'étape purement locale de la chaîne) ─────────

export type GeneratedCsr = {
  /** CSR au format PEM — c'est ce que l'API App Store Connect attend. */
  csrPem: string;
  /** Clé privée PEM. ⚠️ NE JAMAIS journaliser ni retourner au client : elle
   *  n'a qu'un seul usage légitime, être recombinée avec le certificat
   *  qu'Apple renverra, puis scellée dans un `.p12`. */
  privateKeyPem: string;
};

/**
 * Étape 1 de la chaîne iOS (§5.5) : paire de clés + CSR, en pur openssl, sans
 * la moindre dépendance Apple. C'est l'étape que tout le monde croit réservée
 * à Xcode sur un Mac ; elle ne l'est pas.
 */
export async function generateIosCsr(opts: {
  displayName: string;
  bundleId: string;
}): Promise<GeneratedCsr> {
  const cn = sanitizeDnValue(opts.displayName, opts.bundleId);
  const dir = await mkdtemp(join(tmpdir(), "mobile-csr-"));
  const keyPath = join(dir, "key.pem");
  const csrPath = join(dir, "req.csr");
  try {
    await runOpenssl(["genrsa", "-out", keyPath, "2048"]);
    await runOpenssl([
      "req", "-new", "-key", keyPath, "-out", csrPath,
      "-sha256",
      "-subj", `/CN=${cn}`,
    ]);
    return {
      csrPem: await readFile(csrPath, "utf8"),
      privateKeyPem: await readFile(keyPath, "utf8"),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Étape 3 de la chaîne iOS : recombine la clé privée gardée en mémoire et le
 * certificat émis par Apple en un `.p12` — le format que le CI consomme.
 *
 * @param certificateDer le `certificateContent` renvoyé par l'API ASC (DER
 *   encodé en base64), converti ici en PEM. Apple ne renvoie jamais de PEM.
 */
export async function assembleIosP12(
  privateKeyPem: string,
  certificateDer: Buffer,
): Promise<{ p12Base64: string; passphrase: string; validUntil: string; sha256: string }> {
  const passphrase = generatePassword(PASSPHRASE_LENGTH);
  const dir = await mkdtemp(join(tmpdir(), "mobile-p12-"));
  const keyPath = join(dir, "key.pem");
  const certPath = join(dir, "cert.pem");
  const p12Path = join(dir, "dist.p12");
  try {
    await writeFile(keyPath, privateKeyPem, { mode: 0o600 });
    // DER → PEM. On passe par openssl plutôt que d'assembler les en-têtes à la
    // main : un base64 replié à la mauvaise largeur produit un PEM que certains
    // outils acceptent et d'autres non, et le bug ne se voit qu'au build.
    await writeFile(join(dir, "cert.der"), certificateDer, { mode: 0o600 });
    const pem = await runOpenssl([
      "x509", "-inform", "der", "-in", join(dir, "cert.der"),
    ]);
    await writeFile(certPath, pem, { mode: 0o600 });

    await runOpenssl(
      [
        "pkcs12", "-export",
        "-inkey", keyPath, "-in", certPath,
        "-out", p12Path,
        "-passout", "env:MOBILE_GEN_PASSOUT",
      ],
      { env: { MOBILE_GEN_PASSOUT: passphrase } },
    );

    const { validUntil, sha256 } = describeCertificate(pem);
    return {
      p12Base64: (await readFile(p12Path)).toString("base64"),
      passphrase,
      validUntil,
      sha256,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ── Chaîne iOS complète (§5.5, étapes 1 → 4) ───────────────────────────────

/**
 * Plafond de certificats de distribution côté Apple (2 pour un compte
 * individuel, 3 pour une organisation). On ne peut pas le lire par l'API : on
 * refuse donc de créer AVANT d'avoir cogné le mur, en laissant l'utilisateur
 * choisir lequel révoquer. Cogner le mur renverrait une erreur Apple opaque,
 * après avoir déjà généré une paire de clés pour rien.
 */
const ASC_CERT_SOFT_CAP = 2;

export type IosGenerationBlocked = {
  ok: false;
  reason: "cert_cap_reached" | "bundle_id_not_registered";
  /** Certificats existants, pour que l'utilisateur puisse en révoquer un. */
  certificates?: Array<{ id: string; name: string; expiresAt: string | null }>;
};

export type IosGenerationDone = {
  ok: true;
  credentials: GeneratedCredential[];
  summary: {
    certificateId: string;
    certificateName: string;
    certificateSha256: string;
    validUntil: string;
    profileName: string;
  };
};

/**
 * Génère le matériel de signature iOS complet, sans Mac : paire + CSR
 * (openssl), certificat de distribution (API ASC), `.p12` (openssl), profil de
 * provisioning App Store (API ASC).
 *
 * ⚠️ La clé privée ne quitte jamais ce processus : elle est produite en étape 1,
 * gardée EN MÉMOIRE le temps de l'aller-retour Apple, scellée dans le `.p12` en
 * étape 3, puis abandonnée au GC. Elle n'est ni écrite en base en clair, ni
 * journalisée, ni renvoyée à l'appelant. C'est ce qui rend ce chemin
 * strictement meilleur que `match` (dépôt git + passphrase d'équipe).
 *
 * @throws AscApiError si Apple refuse — le message d'Apple est actionnable et
 *   remonte tel quel à l'utilisateur.
 */
export async function generateIosSigningMaterial(
  auth: AscAuth,
  app: { displayName: string; bundleId: string },
): Promise<IosGenerationDone | IosGenerationBlocked> {
  // Garde-fou AVANT tout travail : le plafond Apple, et l'App ID.
  const existing = await ascListDistributionCertificates(auth);
  const live = existing.filter(notExpired);
  if (live.length >= ASC_CERT_SOFT_CAP) {
    return {
      ok: false,
      reason: "cert_cap_reached",
      certificates: live.map((c) => ({ id: c.id, name: c.name, expiresAt: c.expiresAt })),
    };
  }

  // Un App ID non enregistré est LA cause n°1 d'échec de création de profil.
  // Le dire ici évite de brûler un slot de certificat pour rien.
  const bundleIdResourceId = await ascFindBundleIdResource(auth, app.bundleId);
  if (!bundleIdResourceId) {
    return { ok: false, reason: "bundle_id_not_registered" };
  }

  // 1. paire + CSR (local)
  const { csrPem, privateKeyPem } = await generateIosCsr(app);

  // 2. certificat de distribution (Apple)
  const cert = await ascCreateDistributionCertificate(auth, csrPem);

  // 3. .p12 = clé privée + certificat (local)
  const p12 = await assembleIosP12(privateKeyPem, cert.der!);

  // 4. profil de provisioning App Store (Apple)
  //
  // Le nom doit être unique dans le compte : Apple refuse un doublon avec un
  // 409. On l'horodate plutôt que de tenter une réutilisation — un profil de
  // trop est inoffensif, un échec en fin de chaîne coûterait le certificat
  // déjà émis.
  const profileName = `Physalis ${app.bundleId} ${new Date()
    .toISOString()
    .slice(0, 19)
    .replace(/[:T]/g, "-")}`;
  const profile = await ascCreateAppStoreProfile(auth, {
    name: profileName,
    bundleIdResourceId,
    certificateIds: [cert.id],
  });

  return {
    ok: true,
    credentials: [
      { kind: "ios_p12", valueBase64: p12.p12Base64, filename: "distribution.p12" },
      ...textCredential("ios_p12_password", p12.passphrase),
      {
        kind: "ios_profile",
        valueBase64: profile.content.toString("base64"),
        filename: `${profileName}.mobileprovision`,
      },
    ],
    summary: {
      certificateId: cert.id,
      certificateName: cert.name,
      certificateSha256: p12.sha256,
      validUntil: p12.validUntil,
      profileName: profile.name,
    },
  };
}

function notExpired(c: AscCertificate): boolean {
  if (!c.expiresAt) return true;
  const d = new Date(c.expiresAt);
  return Number.isNaN(d.getTime()) || d.getTime() > Date.now();
}

export { AscApiError };

// ── Réemploi et révocation (Phase 7, garde-fou du plafond Apple) ───────────
//
// Le plan (§5.5) demande de « lister les certificats existants, réutiliser
// quand c'est possible, et exposer la révocation (comme `match nuke`) ». Les
// deux vont ensemble : sans réemploi on cogne le plafond, et sans révocation on
// ne peut plus rien faire une fois cogné.
//
// ⚠️ Le danger de la révocation est de supprimer le certificat qu'on utilise —
// ce qui casse la publication sans prévenir. D'où `matchVaultCertificate` :
// avant de proposer de révoquer, on dit LEQUEL est en service.

/**
 * Retrouve, parmi les certificats du compte Apple, celui dont la clé privée est
 * dans le coffre.
 *
 * La comparaison se fait sur l'empreinte du CERTIFICAT (pas sur celle du
 * fichier `.p12`, qui change à chaque ré-export du même certificat). Il faut
 * donc ouvrir le conteneur — d'où la passphrase.
 *
 * @returns l'id ASC du certificat en service, ou null si aucun ne correspond
 *   (cas d'un `.p12` importé à la main dont le certificat a été révoqué, ou
 *   émis sur un autre compte).
 */
export async function matchVaultCertificate(
  certificates: AscCertificate[],
  p12: Buffer,
  passphrase: string,
): Promise<{ id: string; sha256: string } | null> {
  const info = await inspectPkcs12(p12, passphrase);
  if (!info.readable || !info.sha256) return null;

  for (const cert of certificates) {
    if (!cert.der) continue;
    try {
      const fp = new X509Certificate(cert.der).fingerprint256
        .replace(/:/g, "")
        .toUpperCase();
      if (fp === info.sha256) return { id: cert.id, sha256: fp };
    } catch {
      // Entrée illisible côté Apple : on continue, une autre correspondra.
    }
  }
  return null;
}

/**
 * Régénère UNIQUEMENT le profil de provisioning, en réutilisant le certificat
 * déjà en service.
 *
 * C'est le cas d'usage le plus fréquent, et celui qui évite de brûler un slot :
 * un profil vaut 1 an, un certificat aussi, mais leurs dates ne coïncident pas.
 * Quand seul le profil expire, régénérer TOUT consommerait un certificat pour
 * rien — et cognerait le plafond au bout de deux fois.
 *
 * @throws AscApiError si Apple refuse.
 */
export async function regenerateIosProfile(
  auth: AscAuth,
  app: { displayName: string; bundleId: string },
  certificateId: string,
): Promise<{ credentials: GeneratedCredential[]; summary: Record<string, string> }> {
  const bundleIdResourceId = await ascFindBundleIdResource(auth, app.bundleId);
  if (!bundleIdResourceId) {
    throw new AscApiError({
      status: 0,
      detail: `App ID ${app.bundleId} non enregistré dans le compte développeur`,
    });
  }

  const profileName = `Physalis ${app.bundleId} ${new Date()
    .toISOString()
    .slice(0, 19)
    .replace(/[:T]/g, "-")}`;
  const profile = await ascCreateAppStoreProfile(auth, {
    name: profileName,
    bundleIdResourceId,
    certificateIds: [certificateId],
  });

  return {
    // Seul le profil est réécrit : le `.p12` et sa passphrase, eux, restent
    // ceux du coffre. Les toucher casserait la correspondance avec le
    // certificat qu'on vient justement de réutiliser.
    credentials: [
      {
        kind: "ios_profile",
        valueBase64: profile.content.toString("base64"),
        filename: `${profileName}.mobileprovision`,
      },
    ],
    summary: {
      profileName: profile.name,
      certificateId,
      reused: "true",
    },
  };
}
