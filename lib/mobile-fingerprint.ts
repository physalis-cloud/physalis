// Chantier "Déploiement mobile" — Phase 1 (socle credentials).
// Cf. documentation/plans/deploiement-mobile.md §4.2.
//
// Server-only : séparé de lib/mobile-credentials.ts parce que ce dernier est
// importé par un composant client (voir l'avertissement en tête de ce
// fichier-là) et qu'un `node:crypto` dans le bundle navigateur casse
// `next build`.

import { createHash } from "node:crypto";

/** Empreinte du CLAIR (jamais du chiffré), calculée sur les octets DÉCODÉS —
 *  pas sur la chaîne base64 — pour rester vérifiable indépendamment
 *  (`sha256sum keystore.jks` doit donner la même valeur). Détecte un
 *  remplacement et corrèle un bundle servi au matériel qui a réellement
 *  signé, sans jamais reformer la valeur (plan §4.2). */
export function sha256Hex(decoded: Buffer): string {
  return createHash("sha256").update(decoded).digest("hex");
}
