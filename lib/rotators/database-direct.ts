import { Client } from "pg";
import { withTenantSchema } from "@/lib/tenant";
import { decrypt } from "@/lib/crypto";
import { applyRotationSuccess } from "@/lib/rotation-agent";
import { generatePassword } from "@/lib/generate-password";

// Stratégie DATABASE — mode DIRECT (DB MANAGÉE joignable en TCP+SSL :
// Supabase / RDS / Neon…).
//
// Self-rotation CENTRALISÉE : Physalis se connecte à la DB **AS le `dbUser`**
// avec son mot de passe COURANT (= le secret roté), génère un nouveau mdp fort,
// exécute `ALTER ROLE <dbUser> WITH PASSWORD <new>`, **vérifie la reconnexion**
// avec le nouveau mdp (anti-lockout), PUIS committe la valeur via
// `applyRotationSuccess` (snapshot + version + redeploy + audit). « DB d'abord,
// vault ensuite » : la valeur n'est écrite dans le vault qu'après confirmation
// du changement à la source. Aucun credential admin : on change le mdp **du
// compte qu'on utilise**.
//
// Réservé aux DB joignables depuis le central. Les DB Docker-internes d'un VPS
// client passent par le mode AGENT (sidecar), pas ici. MySQL : non encore
// supporté en DIRECT (utiliser l'agent).
export async function rotateDatabaseDirect(secretId: string, clientSlug: string): Promise<void> {
  const secret = await withTenantSchema(clientSlug, (tx) =>
    tx.secret.findUnique({
      where: { id: secretId },
      select: {
        id: true,
        key: true,
        dbType: true,
        dbHost: true,
        dbPort: true,
        dbName: true,
        dbUser: true,
        encryptedValue: true,
        iv: true,
        tag: true,
      },
    }),
  );
  if (!secret) throw new Error(`[rotateDatabaseDirect] secret ${secretId} introuvable`);
  if (secret.dbType !== "POSTGRESQL") {
    throw new Error(
      `[rotateDatabaseDirect] DIRECT supporté pour PostgreSQL uniquement (reçu ${secret.dbType ?? "null"}). Pour MySQL ou une DB interne, utilisez le mode Agent.`,
    );
  }
  const { dbHost, dbPort, dbName, dbUser } = secret;
  if (!dbHost || !dbName || !dbUser) {
    throw new Error(`[rotateDatabaseDirect] config incomplète : host, base et user requis`);
  }
  const port = dbPort ?? 5432;

  const currentPassword = decrypt({
    encryptedValue: secret.encryptedValue,
    iv: secret.iv,
    tag: secret.tag,
  });
  const newValue = generatePassword(24);

  // `ALTER ROLE` n'accepte pas de paramètre lié pour le littéral mot de passe →
  // on construit le SQL en échappant. base64url ne contient ni quote ni
  // guillemet, mais on reste défensif.
  const pwLiteral = `'${newValue.replace(/'/g, "''")}'`;

  const makeClient = (password: string) =>
    new Client({
      host: dbHost,
      port,
      database: dbName,
      user: dbUser,
      password,
      // DB managée : TLS obligatoire ; on n'épingle pas la CA (certifs gérés par
      // le provider, souvent self-signed côté chaîne) → chiffré sans vérif CA.
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 15_000,
      statement_timeout: 15_000,
      query_timeout: 15_000,
    });

  // 1) Se connecter AS dbUser avec le mdp courant et changer son propre mdp.
  const client = makeClient(currentPassword);
  try {
    await client.connect();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `[rotateDatabaseDirect] connexion ${dbUser}@${dbHost}:${port}/${dbName} échouée — ${msg}`,
    );
  }
  // Le rôle à modifier = l'utilisateur RÉELLEMENT authentifié (self-rotation),
  // pas forcément le `dbUser` de connexion : sur un pooler (Supabase) le login
  // est `<role>.<project_ref>` alors que le rôle réel est `<role>` →
  // `ALTER ROLE "<login>"` planterait. On lit donc le rôle via `current_user`.
  let role: string;
  try {
    const r = await client.query<{ current_user: string }>("SELECT current_user");
    role = r.rows[0].current_user;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await client.end().catch(() => {});
    throw new Error(`[rotateDatabaseDirect] lecture du rôle courant échouée — ${msg}`);
  }
  const roleIdent = `"${role.replace(/"/g, '""')}"`;
  try {
    await client.query(`ALTER ROLE ${roleIdent} WITH PASSWORD ${pwLiteral}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`[rotateDatabaseDirect] ALTER ROLE ${role} échoué — ${msg}`);
  } finally {
    await client.end().catch(() => {});
  }

  // 2) Anti-lockout : vérifier la reconnexion avec le NOUVEAU mdp AVANT de
  //    committer (on ne stocke jamais une valeur qui ne permet pas de se
  //    connecter). L'ALTER étant immédiat en PostgreSQL, une reconnexion réussie
  //    prouve que le changement a pris.
  const verify = makeClient(newValue);
  try {
    await verify.connect();
    await verify.query("SELECT 1");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `[rotateDatabaseDirect] vérification de reconnexion avec le nouveau mot de passe échouée — ${msg}. ⚠️ Le mot de passe a peut-être été changé côté DB sans être committé dans le vault.`,
    );
  } finally {
    await verify.end().catch(() => {});
  }

  // 3) Source confirmée → committe la valeur (atomicité côté Physalis :
  //    versioning de l'ancienne + écriture + recalcul échéance + redeploy + audit).
  await applyRotationSuccess(clientSlug, secret.id, newValue, "direct");
}
