// Chantier "Déploiement mobile" — Phase 1 (socle credentials).
// Cf. documentation/plans/deploiement-mobile.md §5.4.
//
// Extraction d'`expiresAt` à l'import d'un MobileCredential : certificat de
// distribution iOS (.p12), profil de provisioning (.mobileprovision),
// keystore Android. Retourne `null` (jamais une erreur) pour tout type sans
// notion d'expiration OU que l'extraction ne sait pas lire — l'import d'un
// credential ne doit jamais échouer faute de savoir en lire la date.
//
// ⚠️ Décision d'implémentation qui s'écarte du plan : le plan (§5.4) affirme
// que `node:crypto` suffit ("aucune dépendance"). C'est vrai pour LIRE un
// certificat X.509 déjà en PEM/DER (`crypto.X509Certificate`), mais PAS pour
// désenvelopper un conteneur PKCS12 (.p12) ni un CMS (.mobileprovision) — Node
// n'a aucune API stdlib pour ça. Le shell-out `openssl` et sa discipline de
// sécurité vivent dans lib/openssl.ts (partagés avec lib/mobile-inspect.ts).
//
// Le contenu du .p12 doit être sur disque pour `openssl pkcs12` (pas de support
// stdin fiable multi-versions pour ce sous-programme) : fichier temporaire mode
// 0600, dans un répertoire dédié par appel, supprimé en `finally` — jamais
// laissé après l'appel, jamais loggé.

import { X509Certificate } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpensslError, runOpenssl } from "./openssl";

/** `notAfter` d'un certificat X.509 en PEM → Date, via l'API stdlib (pas de
 *  shell-out ici : X509Certificate sait lire un PEM/DER directement). */
function parsePemNotAfter(pem: string): Date | null {
  try {
    const cert = new X509Certificate(pem);
    const d = new Date(cert.validTo);
    return Number.isNaN(d.getTime()) ? null : d;
  } catch {
    return null;
  }
}

/**
 * Certificat de distribution iOS (.p12) ou keystore Android PKCS12 — même
 * conteneur, même extraction. Retourne `null` si le fichier n'est pas un
 * PKCS12 valide sous cette passphrase (ex. keystore JKS legacy, format
 * antérieur à Java 9 : openssl ne sait pas le lire — non supporté pour
 * l'instant, l'import réussit simplement sans `expiresAt`).
 */
export async function extractP12Expiry(
  p12: Buffer,
  passphrase: string,
): Promise<Date | null> {
  const dir = await mkdtemp(join(tmpdir(), "mobile-cred-"));
  const p12Path = join(dir, "in.p12");
  try {
    await writeFile(p12Path, p12, { mode: 0o600 });
    const reasons: string[] = [];
    // Deux tentatives, dans cet ordre : algorithmes modernes, puis `-legacy`.
    //
    // ⚠️ Sans le second essai, un `.p12` exporté depuis le Trousseau macOS —
    // c'est-à-dire le cas NOMINAL pour un certificat de distribution Apple —
    // n'est pas lisible : il est chiffré en RC2-40-CBC, qu'OpenSSL 3 a relégué
    // au provider « legacy » et refuse par défaut avec
    // « inner_evp_generic_fetch:unsupported ». L'import réussissait donc, mais
    // sans date d'expiration, en silence — la surveillance d'expiration
    // (§5.4 du plan) tombait à plat sur son cas d'usage principal.
    for (const legacy of [false, true]) {
      try {
        const pem = await runOpenssl(
          [
            "pkcs12",
            ...(legacy ? ["-legacy"] : []),
            "-in", p12Path,
            "-clcerts", "-nokeys",
            "-passin", "env:MOBILE_CRED_PASSIN",
          ],
          { env: { MOBILE_CRED_PASSIN: passphrase } },
        );
        const match = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/);
        if (match) return parsePemNotAfter(match[0]);
      } catch (err) {
        // Mauvaise passphrase, format illisible, ou `-legacy` inconnu d'un
        // OpenSSL 1.x : on passe à l'essai suivant, sinon null.
        //
        // ⚠️ Loggé côté SERVEUR, jamais renvoyé au client. Sans cette trace,
        // un `.p12` illisible et un credential sans notion d'expiration se
        // ressemblaient exactement — c'est ce qui a fait passer le blocage
        // RC2-40 d'OpenSSL 3 pour un comportement normal.
        reasons.push(
          `${legacy ? "legacy" : "default"}: ${
            err instanceof OpensslError ? err.detail : "erreur inconnue"
          }`,
        );
      }
    }
    // ⚠️ « Mac verify error: invalid password? » couvre DEUX causes chez
    // openssl : passphrase fausse, ou octets du conteneur altérés (le MAC ne
    // correspond plus). On journalise donc de quoi les séparer — présence
    // d'une passphrase et taille reçue. JAMAIS la passphrase elle-même.
    console.warn(
      `[mobile-expiry] PKCS12 illisible, expiresAt reste null — ` +
        `passphrase ${passphrase ? `fournie (${passphrase.length} car.)` : "ABSENTE"}, ` +
        `${p12.length} octets reçus — ${reasons.join(" | ")}`,
    );
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * `ExpirationDate` d'un profil de provisioning iOS (.mobileprovision) — plist
 * signé CMS (PKCS#7), non chiffré, pas de passphrase. `-noverify` : on ne
 * valide PAS la chaîne de confiance Apple (on n'a pas le trust store WWDR
 * embarqué et on ne s'en sert pas comme preuve d'authenticité, seulement
 * pour lire une date) — n'accorde aucune autorisation, ne fait que déballer.
 */
export async function extractMobileProvisionExpiry(
  profile: Buffer,
): Promise<Date | null> {
  try {
    const plist = await runOpenssl(
      ["smime", "-verify", "-noverify", "-inform", "der"],
      { input: profile },
    );
    // On évite une dépendance de parsing plist complète pour une seule date :
    // extraction ciblée de la paire <key>ExpirationDate</key><date>…</date>.
    const match = plist.match(
      /<key>ExpirationDate<\/key>\s*<date>([^<]+)<\/date>/,
    );
    if (!match) {
      console.warn(
        "[mobile-expiry] profil déballé mais sans clé ExpirationDate — expiresAt reste null",
      );
      return null;
    }
    const d = new Date(match[1]);
    return Number.isNaN(d.getTime()) ? null : d;
  } catch (err) {
    console.warn(
      `[mobile-expiry] profil illisible, expiresAt reste null — ${
        err instanceof OpensslError ? err.detail : "erreur inconnue"
      }`,
    );
    return null;
  }
}

/**
 * Point d'entrée unique appelé à l'import — dispatch par `kind`. Ne lève
 * jamais : un échec d'extraction ne doit jamais bloquer l'import du
 * credential, seulement laisser `expiresAt` null.
 */
export async function extractExpiresAt(
  kind: string,
  value: Buffer,
  passphrase?: string,
): Promise<Date | null> {
  switch (kind) {
    case "ios_p12":
    case "android_keystore":
      // Passphrase vide en repli : un conteneur PKCS12 peut être exporté sans
      // mot de passe, et refuser d'essayer garantissait un `expiresAt` null.
      return extractP12Expiry(value, passphrase ?? "");
    case "ios_profile":
      return extractMobileProvisionExpiry(value);
    default:
      // "asc_api_key" (.p8), mots de passe, identifiants texte, JSON de
      // compte de service Google : pas de notion d'expiration extractible.
      return null;
  }
}
