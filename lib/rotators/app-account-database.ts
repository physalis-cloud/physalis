import { Client } from "pg";
import { withTenantSchema } from "@/lib/tenant";
import { decrypt } from "@/lib/crypto";
import { generatePassword } from "@/lib/generate-password";
import { applyAccountRotationSuccess } from "./app-account-webhook";
import { RotationDisabledError, rotationGateOpen } from "@/lib/rotation-gate";

// Rotation DATABASE d'un AppAccount sur une DB MANAGÉE (Supabase / RDS / Neon…).
// Deux cibles selon `rotationDbTarget` :
//   - "role" (défaut)     → un rôle PostgreSQL : `ALTER ROLE … WITH PASSWORD`.
//   - "supabase_auth"     → un utilisateur Supabase Auth (table auth.users) :
//                            `UPDATE auth.users SET encrypted_password = crypt(…)`
//                            (GoTrue = bcrypt, pgcrypto). Le `user` = l'email.
//
// Modèle « connexion admin sur le service » : le SERVICE backend lié porte la
// connexion (dbType/dbHost/dbPort/dbName) ET les identifiants ADMIN (ses creds
// `encryptedData = { user, password }`, ex. `postgres`). Physalis se connecte
// avec l'admin, applique le changement, puis committe le nouveau mdp sur le
// compte (ré-encrypt { user, new } + historique). « DB d'abord, vault ensuite ».
// Un seul service ⇒ N comptes rotables (rôles et/ou utilisateurs Auth).
export async function rotateAppAccountDatabaseDirect(
  accountId: string,
  clientSlug: string,
): Promise<void> {
  const acc = await withTenantSchema(clientSlug, (tx) =>
    tx.appAccount.findUnique({
      where: { id: accountId },
      select: {
        id: true,
        encryptedData: true,
        iv: true,
        tag: true,
        // "role" (rôle Postgres → ALTER ROLE) ou "supabase_auth" (auth.users).
        rotationDbTarget: true,
        // §2.24c — gate d'org (bloque un « Forcer » sur une org rotation-off).
        project: {
          select: {
            rotationPaused: true,
            organization: { select: { rotationFeatureEnabled: true } },
          },
        },
        // Le service backend lié porte la connexion DB + les creds admin DB
        // DÉDIÉS (dbUser + dbPw*), distincts des creds dashboard du service.
        service: {
          select: {
            dbType: true,
            dbHost: true,
            dbPort: true,
            dbName: true,
            dbUser: true,
            dbPwEncrypted: true,
            dbPwIv: true,
            dbPwTag: true,
          },
        },
      },
    }),
  );
  if (!acc) throw new Error(`[rotateAppAccountDatabaseDirect] compte ${accountId} introuvable`);
  if (!rotationGateOpen(acc.project)) throw new RotationDisabledError();
  const svc = acc.service;
  if (!svc) throw new Error(`compte non lié à un service backend`);
  if (svc.dbType !== "POSTGRESQL") {
    throw new Error(
      `le service lié n'a pas de cible PostgreSQL (dbType=${svc.dbType ?? "null"}). MySQL/DB interne non supportés en direct.`,
    );
  }
  if (!svc.dbHost || !svc.dbName) {
    throw new Error(`connexion du service incomplète : host et base requis`);
  }

  // Identifiant du compte = le rôle Postgres OU l'email Supabase Auth, selon la
  // cible. Les creds admin viennent du service.
  const identifier =
    (JSON.parse(decrypt({ encryptedValue: acc.encryptedData, iv: acc.iv, tag: acc.tag })) as {
      user?: string;
    }).user ?? "";
  if (!identifier) throw new Error(`compte sans identifiant (user) à roter`);

  // Connexion admin DB DÉDIÉE (distincte des creds dashboard du service).
  if (!svc.dbUser || !svc.dbPwEncrypted || !svc.dbPwIv || !svc.dbPwTag) {
    throw new Error(
      `le service lié n'a pas d'identifiants de connexion DB (renseigne l'identifiant + mot de passe dans la section base de données du service)`,
    );
  }
  const adminUser = svc.dbUser;
  const adminPassword = decrypt({
    encryptedValue: svc.dbPwEncrypted,
    iv: svc.dbPwIv,
    tag: svc.dbPwTag,
  });

  const newValue = generatePassword(24);
  const isAuth = acc.rotationDbTarget === "supabase_auth";
  const port = svc.dbPort ?? 5432;

  const client = new Client({
    host: svc.dbHost,
    port,
    database: svc.dbName,
    user: adminUser,
    password: adminPassword,
    ssl: { rejectUnauthorized: false }, // DB managée : TLS sans épinglage CA
    connectionTimeoutMillis: 15_000,
    statement_timeout: 15_000,
    query_timeout: 15_000,
  });
  try {
    await client.connect();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `connexion admin ${adminUser}@${svc.dbHost}:${port}/${svc.dbName} échouée — ${msg}`,
    );
  }
  try {
    if (isAuth) {
      // Utilisateur Supabase Auth (GoTrue = bcrypt) : on écrit directement le
      // hash dans auth.users.encrypted_password via pgcrypto. crypt/gen_salt
      // vivent dans le schéma `extensions` chez Supabase → on l'ajoute au
      // search_path (entrée inexistante = ignorée, donc sans risque).
      await client.query("SET search_path TO public, extensions");
      const r = await client.query(
        `UPDATE auth.users
           SET encrypted_password = crypt($1, gen_salt('bf', 10)), updated_at = now()
         WHERE email = $2`,
        [newValue, identifier],
      );
      if (r.rowCount !== 1) {
        throw new Error(
          `utilisateur Supabase Auth introuvable pour l'email ${identifier} (lignes mises à jour : ${r.rowCount}).`,
        );
      }
    } else {
      // Rôle PostgreSQL : ALTER ROLE (immédiat ; lève si le rôle n'existe pas).
      // Pas de paramètre lié pour le littéral mdp → on échappe identifiant + valeur.
      const roleIdent = `"${identifier.replace(/"/g, '""')}"`;
      const pwLiteral = `'${newValue.replace(/'/g, "''")}'`;
      await client.query(`ALTER ROLE ${roleIdent} WITH PASSWORD ${pwLiteral}`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `${isAuth ? "UPDATE auth.users" : "ALTER ROLE"} ${identifier} échoué — ${msg}`,
    );
  } finally {
    await client.end().catch(() => {});
  }

  // Source confirmée → committe le nouveau mdp sur le compte (ré-encrypt
  // { user inchangé, newValue } + snapshot historique-3 + bump échéances).
  await applyAccountRotationSuccess(clientSlug, acc.id, newValue);
}
