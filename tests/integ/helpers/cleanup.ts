// Nettoyage des fixtures d'un fichier de test.
//
// POURQUOI CE HELPER : la suite s'exécute contre un tenant PARTAGÉ, dont le
// quota est de 5 sièges. Les fichiers qui sèment un utilisateur sans le
// reprendre laissent un siège occupé — définitivement. Constaté le 2026-07-27 :
// 36 utilisateurs `@test.local` accumulés depuis le 19/07, soit 38 comptes pour
// 5 sièges. Toute invitation partait alors en 403, et l'échec ressemblait à de
// l'instabilité alors qu'il était parfaitement déterministe.
//
// Un `afterAll(() => cleanupFixtures(STAMP))` d'une ligne suffit à l'éviter.

import { execSql } from "./db";
import { TENANT_SCHEMA } from "./api";

/**
 * Supprime tout ce qu'un fichier de test a semé sous son empreinte.
 *
 * L'empreinte est le suffixe unique que chaque fichier construit au démarrage
 * (`Date.now()`), et qu'il colle dans les emails, slugs d'org et slugs de
 * projet. On la cherche donc dans les trois.
 *
 * Ordre : organisations d'abord (leur cascade emporte projets, membres,
 * invitations et secrets d'org), puis projets orphelins d'une autre org, puis
 * utilisateurs. L'inverse laisserait des lignes rattachées à un user disparu.
 *
 * TOLÉRANT AUX ERREURS : le nettoyage ne doit jamais transformer un test rouge
 * en cascade d'erreurs qui masque la vraie cause. Chaque suppression est
 * indépendante et silencieuse en cas d'échec.
 */
export async function cleanupFixtures(stamp: string | number): Promise<void> {
  const s = String(stamp);
  // Garde-fou : une empreinte vide ou trop courte effacerait des données qui
  // ne nous appartiennent pas. Un `Date.now()` fait 13 chiffres.
  if (s.length < 8) {
    throw new Error(
      `cleanupFixtures: empreinte trop courte (« ${s} ») — refus par sécurité`,
    );
  }

  const T = `"${TENANT_SCHEMA}"`;
  for (const sql of [
    `DELETE FROM ${T}."Organization" WHERE slug LIKE '%${s}%'`,
    `DELETE FROM ${T}."Project" WHERE slug LIKE '%${s}%'`,
    `DELETE FROM ${T}."User" WHERE email LIKE '%${s}%'`,
  ]) {
    await execSql(sql).catch(() => {});
  }
}
