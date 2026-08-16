// Chantier "Déploiement mobile" — Phase 2 : inspection LOCALE du matériel de
// signature (aucun appel réseau). Cf. documentation/plans/deploiement-mobile.md §7.
//
// L'extraction d'`expiresAt` à l'import (lib/mobile-expiry.ts) ne répond qu'à
// « quand ça meurt ». Ce module répond à « est-ce que ça marche ENSEMBLE » :
// l'alias déclaré existe-t-il dans le keystore, le profil couvre-t-il bien ce
// bundle id, le certificat du `.p12` est-il celui que le profil embarque.
//
// C'est la moitié hors-ligne de la validation d'accréditation. Elle attrape la
// classe d'erreur qui, sinon, n'apparaît qu'AU PREMIER DÉPLOIEMENT — c'est-à-dire
// au pire moment, dans un log de CI, chez le client.
//
// ⚠️ SERVER-ONLY (lib/openssl.ts → node:child_process). Jamais importé depuis un
// composant client.
//
// Aucune fonction d'ici ne LÈVE : un matériel illisible est un RÉSULTAT
// (`readable: false` + une raison), pas une exception. La vérification ne doit
// jamais faire tomber la requête qui l'a demandée.

import { X509Certificate } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { opensslDetail, runOpenssl } from "./openssl";

/** Empreinte SHA-256 d'un certificat, normalisée (majuscules, sans ':') —
 *  sert UNIQUEMENT à comparer deux certificats entre eux. */
function fingerprint(cert: X509Certificate): string {
  return cert.fingerprint256.replace(/:/g, "").toUpperCase();
}

function parseDate(raw: string): Date | null {
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

// ── PKCS12 : keystore Android et certificat de distribution iOS ────────────

export type Pkcs12Info = {
  readable: boolean;
  /** Raison de l'illisibilité (log serveur uniquement, jamais renvoyée telle
   *  quelle au navigateur : openssl y recopie parfois des octets du fichier). */
  reason?: string;
  /** `friendlyName` des sacs du conteneur = les alias, au sens keytool. */
  aliases: string[];
  /** Certificat client (le premier `-clcerts`) — celui qui signe. */
  subject: string | null;
  notAfter: Date | null;
  /** Empreinte SHA-256, pour corréler avec le profil de provisioning iOS. */
  sha256: string | null;
};

const UNREADABLE: Pkcs12Info = {
  readable: false,
  aliases: [],
  subject: null,
  notAfter: null,
  sha256: null,
};

/**
 * Ouvre un conteneur PKCS12 et en décrit le contenu.
 *
 * Deux tentatives, moderne puis `-legacy` — même raison qu'en §5.4 : un `.p12`
 * exporté du Trousseau macOS (le cas NOMINAL d'un certificat de distribution
 * Apple) est chiffré en RC2-40-CBC, qu'OpenSSL 3 refuse par défaut.
 */
export async function inspectPkcs12(
  container: Buffer,
  passphrase: string,
): Promise<Pkcs12Info> {
  const dir = await mkdtemp(join(tmpdir(), "mobile-inspect-"));
  const path = join(dir, "in.p12");
  try {
    await writeFile(path, container, { mode: 0o600 });
    const reasons: string[] = [];
    for (const legacy of [false, true]) {
      try {
        // `-nokeys` : on ne sort JAMAIS la clé privée du conteneur — on n'en a
        // pas besoin pour décrire le matériel, et ne pas l'extraire est une
        // garantie qu'elle ne peut pas fuiter par un buffer de stdout.
        const out = await runOpenssl(
          [
            "pkcs12",
            ...(legacy ? ["-legacy"] : []),
            "-in", path,
            "-nokeys",
            "-passin", "env:MOBILE_CRED_PASSIN",
          ],
          { env: { MOBILE_CRED_PASSIN: passphrase } },
        );

        const aliases = [...out.matchAll(/friendlyName:\s*(.+)/g)]
          .map((m) => m[1].trim())
          .filter(Boolean);

        // `-clcerts` n'est pas utilisé ici (il masquerait les alias des autres
        // sacs) : le certificat qui signe est le PREMIER du flux.
        const pem = out.match(
          /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/,
        );
        let subject: string | null = null;
        let notAfter: Date | null = null;
        let sha256: string | null = null;
        if (pem) {
          try {
            const cert = new X509Certificate(pem[0]);
            subject = cert.subject.replace(/\n/g, ", ");
            notAfter = parseDate(cert.validTo);
            sha256 = fingerprint(cert);
          } catch {
            // Conteneur ouvert mais certificat illisible : on garde les alias.
          }
        }
        return { readable: true, aliases, subject, notAfter, sha256 };
      } catch (err) {
        reasons.push(`${legacy ? "legacy" : "default"}: ${opensslDetail(err)}`);
      }
    }
    // ⚠️ « Mac verify error: invalid password? » couvre DEUX causes chez
    // openssl : passphrase fausse, ou octets du conteneur altérés. On
    // journalise de quoi les séparer — JAMAIS la passphrase elle-même.
    console.warn(
      `[mobile-inspect] PKCS12 illisible — passphrase ${
        passphrase ? `fournie (${passphrase.length} car.)` : "ABSENTE"
      }, ${container.length} octets — ${reasons.join(" | ")}`,
    );
    return { ...UNREADABLE, reason: reasons.join(" | ") };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ── Profil de provisioning iOS (.mobileprovision) ──────────────────────────

export type ProvisioningProfileInfo = {
  readable: boolean;
  reason?: string;
  expiresAt: Date | null;
  /** `application-identifier` sans le préfixe Team ID — peut valoir "*"
   *  (profil joker) ou "com.exemple.app.*" (joker de suffixe). */
  appIdPattern: string | null;
  teamId: string | null;
  /** Empreintes SHA-256 des certificats que le profil accepte. */
  certificateSha256: string[];
  /** Un profil App Store n'en a PAS. Sa présence signe un profil de
   *  développement ou ad hoc — refusé au téléversement. */
  hasProvisionedDevices: boolean;
  /** `get-task-allow` vrai = profil de DÉVELOPPEMENT (débogage autorisé). */
  isDevelopment: boolean;
};

const PROFILE_UNREADABLE: ProvisioningProfileInfo = {
  readable: false,
  expiresAt: null,
  appIdPattern: null,
  teamId: null,
  certificateSha256: [],
  hasProvisionedDevices: false,
  isDevelopment: false,
};

/**
 * Déballe un `.mobileprovision` (plist signé CMS, non chiffré) et en lit les
 * champs qui décident du succès d'une publication.
 *
 * `-noverify` : on ne valide PAS la chaîne de confiance Apple (on n'embarque
 * pas le trust store WWDR et on ne se sert pas de ce déballage comme preuve
 * d'authenticité — seulement pour lire des champs). N'accorde aucune
 * autorisation.
 *
 * Le plist est lu par extractions ciblées plutôt qu'avec une dépendance de
 * parsing complète : on ne cherche que six champs, tous à forme fixe.
 */
export async function inspectProvisioningProfile(
  profile: Buffer,
): Promise<ProvisioningProfileInfo> {
  let plist: string;
  try {
    plist = await runOpenssl(["smime", "-verify", "-noverify", "-inform", "der"], {
      input: profile,
    });
  } catch (err) {
    const reason = opensslDetail(err);
    console.warn(`[mobile-inspect] profil illisible — ${reason}`);
    return { ...PROFILE_UNREADABLE, reason };
  }

  const expiryRaw = plist.match(
    /<key>ExpirationDate<\/key>\s*<date>([^<]+)<\/date>/,
  );
  const appId = plist.match(
    /<key>application-identifier<\/key>\s*<string>([^<]*)<\/string>/,
  );
  const team = plist.match(
    /<key>TeamIdentifier<\/key>\s*<array>\s*<string>([^<]*)<\/string>/,
  );

  // `application-identifier` vaut "TEAMID.com.exemple.app" : le Team ID est un
  // préfixe de 10 caractères alphanumériques, pas une partie du bundle id.
  let appIdPattern: string | null = null;
  if (appId) {
    const value = appId[1];
    const dot = value.indexOf(".");
    appIdPattern = dot > 0 ? value.slice(dot + 1) : value;
  }

  const certs = plist.match(
    /<key>DeveloperCertificates<\/key>\s*<array>([\s\S]*?)<\/array>/,
  );
  const certificateSha256: string[] = [];
  if (certs) {
    for (const m of certs[1].matchAll(/<data>([\s\S]*?)<\/data>/g)) {
      const der = Buffer.from(m[1].replace(/\s+/g, ""), "base64");
      if (der.length === 0) continue;
      try {
        certificateSha256.push(fingerprint(new X509Certificate(der)));
      } catch {
        // Entrée illisible : ignorée, la corrélation se fera sur les autres.
      }
    }
  }

  return {
    readable: true,
    expiresAt: expiryRaw ? parseDate(expiryRaw[1]) : null,
    appIdPattern,
    teamId: team ? team[1] : null,
    certificateSha256,
    hasProvisionedDevices: /<key>ProvisionedDevices<\/key>/.test(plist),
    isDevelopment:
      /<key>get-task-allow<\/key>\s*<true\/>/.test(plist),
  };
}

/**
 * Le motif d'app id d'un profil couvre-t-il ce bundle id ?
 *
 * Apple n'autorise le joker qu'en SUFFIXE ("*" ou "com.exemple.*") — un joker
 * médian n'existe pas. On ne construit donc pas une expression régulière depuis
 * une valeur du fichier importé (elle serait attaquant-contrôlée) : on traite
 * les deux seules formes légales à la main.
 */
export function profileCoversBundleId(
  pattern: string | null,
  bundleId: string,
): boolean {
  if (!pattern) return false;
  if (pattern === "*") return true;
  if (pattern.endsWith(".*")) {
    return bundleId.startsWith(pattern.slice(0, -1));
  }
  return pattern === bundleId;
}
