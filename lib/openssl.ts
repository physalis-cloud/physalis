// Shell-out `openssl` — socle partagé de l'inspection du matériel de signature
// mobile (lib/mobile-expiry.ts, lib/mobile-inspect.ts).
//
// Pourquoi un shell-out plutôt qu'une dépendance npm : `node:crypto` sait lire
// un certificat X.509 déjà en PEM/DER (`X509Certificate`), mais Node n'a en
// stdlib ni PKCS12 (désenvelopper un `.p12` / un keystore) ni CMS (déballer un
// `.mobileprovision`). L'alternative serait une bibliothèque de parsing
// ASN.1/CMS — surface de code sensible, écosystème peu audité — alors que le
// binaire `openssl` est déjà présent dans l'image runtime (Dockerfile, stage
// `base` ; cf. lib/tasks/git.ts, où openssl est explicitement listé comme
// CONSERVÉ contrairement à git/npm qui ont été retirés du durcissement).
//
// ⚠️ Ce module est SERVER-ONLY (node:child_process). Ne jamais l'importer,
// même transitivement, depuis un composant client — c'est exactement ce qui a
// cassé `next build` en Phase 1 (`node:crypto` tiré dans le bundle navigateur
// via lib/mobile-credentials.ts, invisible pour `tsc` et `eslint`).
//
// Discipline de sécurité du shell-out, à ne pas éroder :
//   - `execFile` (jamais `exec`) : argv en tableau, aucune interprétation shell.
//   - Passphrase JAMAIS en argv (lisible dans /proc/*/cmdline par tout process
//     du même conteneur) : passée par variable d'environnement de l'enfant
//     (`-passin env:...`), jamais loggée.
//   - Timeout et plafond de sortie : un fichier malformé ne doit jamais faire
//     pendre la requête ni gonfler la mémoire du process.
//   - stderr n'est PAS remonté verbatim au client : sur certains modes d'échec
//     openssl y recopie des fragments du fichier inspecté.

import { execFile } from "node:child_process";

const OPENSSL_TIMEOUT_MS = 5_000;
const MAX_OUTPUT_BYTES = 1_000_000;

/** Erreur d'un appel openssl, réduite à la première ligne de stderr — la seule
 *  partie utile au diagnostic, et la moins susceptible de contenir un fragment
 *  du fichier inspecté. */
export class OpensslError extends Error {
  constructor(public readonly detail: string) {
    super(`openssl: ${detail}`);
  }
}

export function runOpenssl(
  args: string[],
  opts: { input?: Buffer; env?: Record<string, string> } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "openssl",
      args,
      {
        timeout: OPENSSL_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
        // Hériter de process.env (PATH — sinon le binaire "openssl" n'est pas
        // résolu) et n'AJOUTER que la passphrase, jamais remplacer l'env.
        env: { ...process.env, ...opts.env },
      },
      (err: Error | null, stdout: string, stderr: string) => {
        if (err) {
          const first = (stderr || err.message).split("\n")[0]?.trim() ?? "";
          reject(new OpensslError(first));
          return;
        }
        resolve(stdout);
      },
    );
    if (opts.input) {
      child.stdin?.end(opts.input);
    } else {
      child.stdin?.end();
    }
  });
}

/** Détail d'erreur exploitable pour un log serveur, sans supposer le type. */
export function opensslDetail(err: unknown): string {
  return err instanceof OpensslError ? err.detail : "erreur inconnue";
}
