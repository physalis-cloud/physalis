// KMS — interface mince Physalis → OpenBao (moteur transit) pour les backups
// clients (système ①). Cf. documentation/plans/done/backup-clients-kms-plan.md (Phase 1.3)
// + backup-kms-architecture.md. Module SERVEUR uniquement.
//
// Posture (right-sized 2026-06-23) : on parle au OpenBao single-node existant
// (le nœud pilote ②) via une identité **AppRole admin scopée** *provisioning-only*
// — gère `transit/keys/tenant-*` + les rôles AppRole agent/restore, avec des
// policies FIGÉES (pas d'écriture de policy arbitraire → pas d'auto-escalade vers
// `decrypt`). Le control plane ne détient JAMAIS la KEK et n'unwrappe pas les
// données tenant : l'agent obtient `datakey` (chiffre), le flux restore (Phase 4)
// obtient `decrypt` sur une identité dédiée.
//
// TLS épinglé sur la CA OpenBao (cohérent avec `--cacert` des scripts du pilote).
// Aucune dépendance : `node:https` + `node:fs`.

import https from "node:https";
import { readFileSync } from "node:fs";

const TRANSIT_MOUNT = (process.env.OPENBAO_TRANSIT_MOUNT || "transit").replace(/\/+$/, "");
const APPROLE_MOUNT = (process.env.OPENBAO_APPROLE_MOUNT || "approle").replace(/\/+$/, "");
const KEY_PREFIX = process.env.OPENBAO_KEY_PREFIX || "tenant-";

function env(name: string): string {
  return (process.env[name] ?? "").trim();
}

let _caCache: string | null = null;
/** Répare un PEM transporté par une env var : `\n` échappés → vrais sauts, et
 *  cas « aplati sur une ligne » (env_file perd les retours) → on réinsère un saut
 *  après `BEGIN-----` et avant `-----END` (OpenSSL accepte le base64 non wrappé). */
function normalizePem(s: string): string {
  let pem = s.includes("\\n") ? s.replace(/\\n/g, "\n") : s;
  if (pem.includes("BEGIN") && !pem.includes("\n")) {
    pem = pem
      .replace(/(-----BEGIN [A-Z0-9 ]+-----)/g, "$1\n")
      .replace(/(-----END [A-Z0-9 ]+-----)/g, "\n$1");
  }
  return pem;
}

/** CA OpenBao : PEM inline (`OPENBAO_CACERT_PEM`, `\n` échappés ou PEM aplati
 *  tolérés) ou chemin (`OPENBAO_CACERT`). Vide si non configurée. */
function caPem(): string {
  if (_caCache !== null) return _caCache;
  const inline = env("OPENBAO_CACERT_PEM");
  if (inline) return (_caCache = normalizePem(inline));
  const path = env("OPENBAO_CACERT");
  if (path) {
    try {
      return (_caCache = readFileSync(path, "utf8"));
    } catch {
      return (_caCache = "");
    }
  }
  return (_caCache = "");
}

/** True si tout le nécessaire pour parler à OpenBao est présent. Ne lève jamais :
 *  permet aux flux backup de rester en GPG (legacy) tant que le KMS n'est pas
 *  configuré (dual-path). */
export function isKmsConfigured(): boolean {
  return Boolean(
    env("OPENBAO_ADDR") &&
      env("OPENBAO_ADMIN_ROLE_ID") &&
      env("OPENBAO_ADMIN_SECRET_ID") &&
      caPem(),
  );
}

/** Nom logique de la KEK transit d'un tenant (`tenant-<slug>`). */
export function kmsKeyNameForTenant(slug: string): string {
  return `${KEY_PREFIX}${slug}`;
}

function agentRole(slug: string): string {
  return `agent-${KEY_PREFIX}${slug}`;
}
function restoreRole(slug: string): string {
  return `restore-${KEY_PREFIX}${slug}`;
}

function assertSlug(slug: string): void {
  // Les noms de clé/policy/rôle dérivent du slug → on borne strictement.
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug)) {
    throw new Error(`KMS: slug tenant invalide (${slug})`);
  }
}

type BaoOpts = { token?: string; body?: unknown; wrapTtl?: string };

/** Requête JSON cert-pinnée vers l'API OpenBao. Rejette sur statut non-2xx. */
function baoRequest<T = unknown>(method: string, apiPath: string, opts: BaoOpts = {}): Promise<T> {
  const addr = env("OPENBAO_ADDR");
  if (!addr) throw new Error("KMS: OPENBAO_ADDR non défini");
  const ca = caPem();
  if (!ca) throw new Error("KMS: CA OpenBao non configurée (OPENBAO_CACERT_PEM ou OPENBAO_CACERT)");

  const url = new URL(addr.replace(/\/+$/, "") + apiPath);
  const payload = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
  const headers: Record<string, string> = {};
  if (opts.token) headers["X-Vault-Token"] = opts.token;
  if (opts.wrapTtl) headers["X-Vault-Wrap-TTL"] = opts.wrapTtl;
  if (payload) {
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = Buffer.byteLength(payload).toString();
  }

  return new Promise<T>((resolve, reject) => {
    const req = https.request(url, { method, headers, ca, timeout: 30_000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        const status = res.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          reject(new Error(`OpenBao ${method} ${apiPath} → ${status}: ${raw.slice(0, 300)}`));
          return;
        }
        if (!raw) {
          resolve(undefined as T);
          return;
        }
        try {
          resolve(JSON.parse(raw) as T);
        } catch {
          reject(new Error(`OpenBao ${apiPath}: réponse non-JSON`));
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error(`OpenBao ${apiPath}: timeout`)));
    if (payload) req.write(payload);
    req.end();
  });
}

/** Login de l'AppRole admin (provisioning-only) → token court. */
async function adminLogin(): Promise<string> {
  const roleId = env("OPENBAO_ADMIN_ROLE_ID");
  const secretId = env("OPENBAO_ADMIN_SECRET_ID");
  if (!roleId || !secretId) throw new Error("KMS: OPENBAO_ADMIN_ROLE_ID / OPENBAO_ADMIN_SECRET_ID non définis");
  const r = await baoRequest<{ auth?: { client_token?: string } }>(
    "POST",
    `/v1/auth/${APPROLE_MOUNT}/login`,
    { body: { role_id: roleId, secret_id: secretId } },
  );
  const token = r?.auth?.client_token;
  if (!token) throw new Error("KMS: login admin AppRole refusé");
  return token;
}

/**
 * Provisionne (idempotent) tout l'attirail KMS d'un tenant :
 *   1. la KEK transit `tenant-<slug>` (recréer une clé existante = no-op) ;
 *   2. deux policies FIGÉES : agent (`datakey` sur la clé) + restore (`decrypt`) ;
 *   3. deux rôles AppRole : agent (datakey, TTL court) + restore (decrypt,
 *      réservé au flux restore Phase 4, non livré à l'agent).
 * Retourne le nom logique de la clé à stocker dans `ProjectBackupConfig.kmsKeyName`.
 */
export async function provisionTenantKey(tenantSlug: string): Promise<{ kmsKeyName: string }> {
  assertSlug(tenantSlug);
  const key = kmsKeyNameForTenant(tenantSlug);
  const agent = agentRole(tenantSlug);
  const restore = restoreRole(tenantSlug);
  const token = await adminLogin();

  // 1. KEK transit (AES-256-GCM, wrapping symétrique → PQ-safe).
  await baoRequest("POST", `/v1/${TRANSIT_MOUNT}/keys/${key}`, {
    token,
    body: { type: "aes256-gcm96" },
  });

  // 2. Policies figées (le control plane n'écrit jamais de policy arbitraire).
  const agentPolicy = `path "${TRANSIT_MOUNT}/datakey/plaintext/${key}" {\n  capabilities = ["update"]\n}\n`;
  const restorePolicy = `path "${TRANSIT_MOUNT}/decrypt/${key}" {\n  capabilities = ["update"]\n}\n`;
  await baoRequest("PUT", `/v1/sys/policies/acl/${agent}`, { token, body: { policy: agentPolicy } });
  await baoRequest("PUT", `/v1/sys/policies/acl/${restore}`, { token, body: { policy: restorePolicy } });

  // 3. Rôles AppRole. CIDR-binding posé au moment d'émettre le secret_id agent
  //    (cf. issueAgentSecretId), quand l'IP du VPS client est connue.
  await baoRequest("POST", `/v1/auth/${APPROLE_MOUNT}/role/${agent}`, {
    token,
    body: {
      token_policies: agent,
      token_ttl: "15m",
      token_max_ttl: "30m",
      secret_id_num_uses: 0,
    },
  });
  await baoRequest("POST", `/v1/auth/${APPROLE_MOUNT}/role/${restore}`, {
    token,
    body: {
      token_policies: restore,
      token_ttl: "10m",
      token_max_ttl: "20m",
      secret_id_ttl: "10m",
      secret_id_num_uses: 2,
    },
  });

  return { kmsKeyName: key };
}

/**
 * Ce que la révocation d'un tenant supprime, exactement — et rien d'autre.
 *
 * Extrait en fonction PURE pour être vérifiable : l'invariant à tenir est que
 * **la KEK transit ne figure JAMAIS dans cette liste**. Une régression qui l'y
 * ajouterait détruirait les sauvegardes des clients sur leur propre
 * infrastructure, et ne se verrait qu'après coup. Le test la lit.
 *
 * Ordre : rôles d'abord, policies ensuite. Ainsi une interruption au milieu
 * laisse au pire une policy orpheline (inoffensive) plutôt qu'un rôle vivant
 * dont la policy a disparu.
 */
export function tenantKmsRevocationTargets(
  slug: string,
): { label: string; path: string }[] {
  assertSlug(slug);
  const agent = agentRole(slug);
  const restore = restoreRole(slug);
  return [
    { label: `role/${agent}`, path: `/v1/auth/${APPROLE_MOUNT}/role/${agent}` },
    { label: `role/${restore}`, path: `/v1/auth/${APPROLE_MOUNT}/role/${restore}` },
    { label: `policy/${agent}`, path: `/v1/sys/policies/acl/${agent}` },
    { label: `policy/${restore}`, path: `/v1/sys/policies/acl/${restore}` },
  ];
}

/**
 * Révoque les CHEMINS D'ACCÈS KMS d'un tenant supprimé : AppRole agent +
 * restore, et leurs policies. **La KEK transit N'EST PAS détruite** — et c'est
 * délibéré.
 *
 * Pourquoi garder la clé :
 * l'agent stocke `{blob, wDEK, métadonnées}` **sur la destination DU CLIENT**
 * (cf. `steps-docs/done/backup-kms-architecture.md` §3). Physalis ne détient ni
 * l'archive ni la clé enveloppée, donc :
 *   • la KEK seule ne déchiffre RIEN — la conserver ne retient aucune donnée,
 *     il n'y a aucun gain RGPD à la détruire ;
 *   • la détruire rendrait en revanche **définitivement illisibles les
 *     sauvegardes du client, sur sa propre infrastructure** — un
 *     crypto-shredding involontaire d'archives qu'on n'héberge même pas.
 *
 * On révoque donc l'USAGE (plus personne ne peut demander un unwrap via
 * Physalis) sans détruire la MATIÈRE (le client garde la capacité de restaurer
 * ses archives). Décision tranchée le 2026-07-26, cf.
 * `steps-docs/todo/suppression-compte.md` §D.
 *
 * Best-effort et idempotent : un OpenBao injoignable ne doit pas faire échouer
 * une purge déjà décidée, et re-révoquer un tenant déjà révoqué est un no-op.
 */
export async function revokeTenantKmsAccess(
  tenantSlug: string,
): Promise<{ revoked: string[]; failed: string[] }> {
  assertSlug(tenantSlug);
  const revoked: string[] = [];
  const failed: string[] = [];

  if (!isKmsConfigured()) return { revoked, failed };

  const token = await adminLogin();

  for (const { label, path } of tenantKmsRevocationTargets(tenantSlug)) {
    try {
      await baoRequest("DELETE", path, { token });
      revoked.push(label);
    } catch (err) {
      failed.push(label);
      console.error(`[kms] révocation ${label} (${tenantSlug}):`, err);
    }
  }

  return { revoked, failed };
}

/**
 * Émet (ou fait tourner) un `secret_id` pour l'AppRole **agent** d'un tenant,
 * livré **response-wrapped** (à déballer côté agent). Si `cidr` est fourni (IP du
 * VPS client), le secret_id et le token qui en découle sont **CIDR-bound** → un
 * `secret_id` qui fuit est inutile depuis une autre IP. À injecter par la fusion
 * compose (Phase 3). Sert aussi de `rotateSecretId`.
 */
export async function issueAgentSecretId(
  tenantSlug: string,
  cidr?: string,
): Promise<{ roleId: string; wrappedSecretId: string; wrapTtl: string }> {
  assertSlug(tenantSlug);
  const role = agentRole(tenantSlug);
  const token = await adminLogin();

  const rid = await baoRequest<{ data?: { role_id?: string } }>(
    "GET",
    `/v1/auth/${APPROLE_MOUNT}/role/${role}/role-id`,
    { token },
  );
  const roleId = rid?.data?.role_id;
  if (!roleId) throw new Error(`KMS: role-id introuvable (${role})`);

  const wrapTtl = process.env.OPENBAO_SECRET_ID_WRAP_TTL || "120s";
  const body: Record<string, unknown> = {};
  if (cidr) {
    body.cidr_list = [cidr];
    body.token_bound_cidrs = [cidr];
  }
  const sid = await baoRequest<{ wrap_info?: { token?: string } }>(
    "POST",
    `/v1/auth/${APPROLE_MOUNT}/role/${role}/secret-id`,
    { token, body, wrapTtl },
  );
  const wrappedSecretId = sid?.wrap_info?.token;
  if (!wrappedSecretId) throw new Error("KMS: secret_id non response-wrapped");
  return { roleId, wrappedSecretId, wrapTtl };
}

/** Alias sémantique : rotation périodique du secret_id agent (cf. plan §1.3). */
export const rotateSecretId = issueAgentSecretId;

/**
 * Émet les identifiants **en clair** à injecter dans le compose servi à l'agent
 * (Phase 3, `lib/compose-merge.ts`) : `role_id` + un `secret_id` frais (CIDR-bound
 * à l'IP du VPS de l'agent si `cidr` fourni), plus l'adresse et la CA du KMS et le
 * nom de la KEK. Pas de wrapping : Physalis est le générateur ET l'injecteur (même
 * canal TLS épinglé, le secret_id va dans le `.env` servi, posture identique à
 * `BACKUP_TOKEN`/clé SSH). Régénéré à chaque deploy/merge (= rotation, cf. plan §3).
 */
export async function getAgentInjectionCreds(
  tenantSlug: string,
  cidr?: string,
): Promise<{ addr: string; caCertPem: string; keyName: string; roleId: string; secretId: string }> {
  assertSlug(tenantSlug);
  const role = agentRole(tenantSlug);
  const token = await adminLogin();

  const rid = await baoRequest<{ data?: { role_id?: string } }>(
    "GET",
    `/v1/auth/${APPROLE_MOUNT}/role/${role}/role-id`,
    { token },
  );
  const roleId = rid?.data?.role_id;
  if (!roleId) throw new Error(`KMS: role-id introuvable (${role})`);

  const body: Record<string, unknown> = {};
  if (cidr) {
    body.cidr_list = [cidr];
    body.token_bound_cidrs = [cidr];
  }
  const sid = await baoRequest<{ data?: { secret_id?: string } }>(
    "POST",
    `/v1/auth/${APPROLE_MOUNT}/role/${role}/secret-id`,
    { token, body },
  );
  const secretId = sid?.data?.secret_id;
  if (!secretId) throw new Error(`KMS: secret-id non émis (${role})`);

  return {
    addr: env("OPENBAO_ADDR"),
    caCertPem: caPem(),
    keyName: kmsKeyNameForTenant(tenantSlug),
    roleId,
    secretId,
  };
}

/**
 * Entrée du flux **restore orchestré** (Phase 4) : mint d'un token court porteur
 * de la capacité `decrypt` sur `tenant-<slug>`, via l'identité restore dédiée.
 * Le token est destiné à l'**hôte de restauration** (le plaintext ne transite pas
 * par le control plane) ; Phase 4 finalisera le transport + l'audit.
 *
 * §2.25b — si `cidr` est fourni (IP de l'hôte qui poll le restore-plan, seul à
 * recevoir le token), le `secret_id` ET le token qui en découle sont **CIDR-bound**,
 * à l'identique de l'identité agent (`issueAgentSecretId`) : un token decrypt qui
 * fuit devient inutile depuis une autre IP. Sans `cidr` : comportement historique
 * (non borné) — dégradation propre plutôt que mint d'un token cassé.
 */
export async function getRestoreToken(
  tenantSlug: string,
  cidr?: string,
): Promise<{ token: string; kmsKeyName: string }> {
  assertSlug(tenantSlug);
  const role = restoreRole(tenantSlug);
  const admin = await adminLogin();

  const rid = await baoRequest<{ data?: { role_id?: string } }>(
    "GET",
    `/v1/auth/${APPROLE_MOUNT}/role/${role}/role-id`,
    { token: admin },
  );
  const secretIdBody: Record<string, unknown> = {};
  if (cidr) {
    secretIdBody.cidr_list = [cidr];
    secretIdBody.token_bound_cidrs = [cidr];
  }
  const sid = await baoRequest<{ data?: { secret_id?: string } }>(
    "POST",
    `/v1/auth/${APPROLE_MOUNT}/role/${role}/secret-id`,
    { token: admin, body: secretIdBody },
  );
  const roleId = rid?.data?.role_id;
  const secretId = sid?.data?.secret_id;
  if (!roleId || !secretId) throw new Error(`KMS: identité restore incomplète (${role})`);

  const login = await baoRequest<{ auth?: { client_token?: string } }>(
    "POST",
    `/v1/auth/${APPROLE_MOUNT}/login`,
    { body: { role_id: roleId, secret_id: secretId } },
  );
  const token = login?.auth?.client_token;
  if (!token) throw new Error("KMS: login restore refusé");
  return { token, kmsKeyName: kmsKeyNameForTenant(tenantSlug) };
}
