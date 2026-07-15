// Connecteur de sync sortante Vercel (Phase B1).
//
// Pousse les secrets d'un environnement Physalis vers les variables d'env d'un
// projet Vercel via la REST API. Endpoints utilisés (vérifiés 2026-06-15) :
//   - GET    /v9/projects                       → picker de projet
//   - GET    /v10/projects/{id}/env             → état distant (réconciliation)
//   - POST   /v10/projects/{id}/env?upsert=true → create/update (idempotent)
//   - DELETE /v9/projects/{id}/env/{envId}      → suppression
//
// Garde-fous :
//   - Host CODÉ EN DUR (api.vercel.com) → pas de SSRF (#3).
//   - Réconciliation des suppressions BORNÉE aux vars marquées Physalis (via le
//     champ `comment`) → ne touche jamais les vars saisies manuellement dans
//     Vercel (#1, anti-clobber).
//   - Erreurs sanitizées : on ne propage que statut + message d'erreur Vercel,
//     jamais la valeur d'un secret ni le token (#5).

import type {
  RemoteProject,
  SyncConnector,
  SyncPushInput,
  SyncScope,
} from "./types";

const VERCEL_API = "https://api.vercel.com";

// Type de variable côté Vercel. "encrypted" = chiffré au repos, lisible par les
// builds/functions sur TOUS les targets (dev/preview/prod). "sensitive" serait
// plus strict (non relisible) mais limité à production/preview → on garde
// "encrypted" par défaut pour la compatibilité dev. Configurable plus tard.
const VERCEL_ENV_TYPE = "encrypted";

// Marqueur posé sur le `comment` des vars gérées par Physalis. La réconciliation
// des suppressions ne supprime QUE les vars portant ce marqueur (anti-clobber).
const PHYSALIS_MARKER = "physalis-sync";

type VercelEnvVar = {
  id: string;
  key: string;
  target?: string[] | string;
  comment?: string;
};

/** Tronque + aplatit ; ne jamais y injecter de secret/token. */
function short(msg: string): string {
  return msg.replace(/\s+/g, " ").trim().slice(0, 200);
}

/** Ajoute le teamId en query si présent (scope d'équipe Vercel). */
function withTeam(path: string, scope?: SyncScope): string {
  const teamId = scope?.teamId?.trim();
  if (!teamId) return path;
  return path + (path.includes("?") ? "&" : "?") + `teamId=${encodeURIComponent(teamId)}`;
}

async function vercelFetch(
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const res = await fetch(`${VERCEL_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  if (!res.ok) {
    // Corps d'erreur Vercel : { error: { code, message } }. On n'extrait que le
    // message (jamais notre payload, qui pourrait contenir des valeurs).
    let detail = "";
    try {
      const j = (await res.json()) as { error?: { message?: string } };
      detail = j.error?.message ? `: ${j.error.message}` : "";
    } catch {
      /* corps non-JSON : on ignore */
    }
    // pathSansQuery pour ne pas logguer le teamId.
    const cleanPath = path.split("?")[0];
    throw new Error(`Vercel ${res.status} ${method} ${cleanPath}${short(detail)}`);
  }

  if (res.status === 204) return null;
  return res.json().catch(() => null);
}

async function listProjects(token: string, scope?: SyncScope): Promise<RemoteProject[]> {
  const data = (await vercelFetch(
    token,
    "GET",
    withTeam("/v9/projects?limit=100", scope),
  )) as { projects?: { id: string; name: string }[] } | null;
  return (data?.projects ?? []).map((p) => ({ id: p.id, name: p.name }));
}

async function listEnvVars(
  token: string,
  externalProjectId: string,
  scope?: SyncScope,
): Promise<VercelEnvVar[]> {
  const data = (await vercelFetch(
    token,
    "GET",
    withTeam(`/v10/projects/${encodeURIComponent(externalProjectId)}/env`, scope),
  )) as { envs?: VercelEnvVar[] } | null;
  return data?.envs ?? [];
}

async function push(input: SyncPushInput): Promise<void> {
  const { token, externalProjectId, targets, secrets } = input;
  const scope: SyncScope = { teamId: input.teamId };
  const pid = encodeURIComponent(externalProjectId);

  // 1. Upsert (create + update idempotent) de tous les secrets désirés.
  if (secrets.length > 0) {
    const payload = secrets.map((s) => ({
      key: s.key,
      value: s.value,
      type: VERCEL_ENV_TYPE,
      target: targets,
      comment: PHYSALIS_MARKER,
    }));
    await vercelFetch(token, "POST", withTeam(`/v10/projects/${pid}/env?upsert=true`, scope), payload);
  }

  // 2. Réconciliation des suppressions : supprime les vars gérées par Physalis
  //    (marqueur dans le comment) dont la clé n'est plus dans l'état désiré.
  //    Les vars saisies manuellement dans Vercel (sans marqueur) sont épargnées.
  const desiredKeys = new Set(secrets.map((s) => s.key));
  const remote = await listEnvVars(token, externalProjectId, scope);
  const toDelete = remote.filter(
    (v) => (v.comment ?? "").includes(PHYSALIS_MARKER) && !desiredKeys.has(v.key),
  );
  for (const v of toDelete) {
    await vercelFetch(
      token,
      "DELETE",
      withTeam(`/v9/projects/${pid}/env/${encodeURIComponent(v.id)}`, scope),
    );
  }
}

export const vercelConnector: SyncConnector = {
  provider: "vercel",

  async test(token, scope) {
    try {
      await listProjects(token, scope);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: short(err instanceof Error ? err.message : String(err)) };
    }
  },

  listProjects,
  push,
};
