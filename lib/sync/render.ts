// Connecteur de sync sortante Render (Phase B2).
//
// Pousse les secrets d'un environnement Physalis vers les variables d'env d'un
// service Render via la REST API. Endpoints (vérifiés 2026-06-15) :
//   - GET /v1/services                    → picker (cursor pagination, Bearer)
//   - PUT /v1/services/{serviceId}/env-vars → REMPLACE tout le jeu de vars
//
// Différence clé avec Vercel : l'API Render **remplace l'ensemble** des vars en
// un appel (pas d'upsert/delete unitaire, pas de champ `comment` pour marquer).
// Conséquence assumée : **Physalis devient la source de vérité** des variables du
// service Render — une var posée manuellement dans le dashboard Render et absente
// de Physalis sera retirée. À documenter clairement côté UI/doc. Du coup la
// réconciliation (create/update/delete) est gratuite : le PUT reflète exactement
// l'état désiré.
//
// Garde-fous : host codé en dur (anti-SSRF), erreurs sanitizées (jamais de valeur
// de secret ni de token). Pas de notion de target ni de team côté Render.

import type { RemoteProject, SyncConnector, SyncPushInput, SyncScope } from "./types";

const RENDER_API = "https://api.render.com";

function short(msg: string): string {
  return msg.replace(/\s+/g, " ").trim().slice(0, 200);
}

async function renderFetch(
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const res = await fetch(`${RENDER_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  if (!res.ok) {
    let detail = "";
    try {
      const j = (await res.json()) as { message?: string };
      detail = j.message ? `: ${j.message}` : "";
    } catch {
      /* corps non-JSON */
    }
    const cleanPath = path.split("?")[0];
    throw new Error(`Render ${res.status} ${method} ${cleanPath}${short(detail)}`);
  }

  if (res.status === 204) return null;
  return res.json().catch(() => null);
}

// La liste /v1/services renvoie des items wrappés ({ service: {...}, cursor }) ;
// on parse défensivement le cas wrappé ET le cas plat pour rester robuste.
type RawServiceItem = {
  service?: { id?: string; name?: string };
  id?: string;
  name?: string;
};

async function listProjects(token: string, _scope?: SyncScope): Promise<RemoteProject[]> {
  const data = (await renderFetch(token, "GET", "/v1/services?limit=100")) as
    | RawServiceItem[]
    | null;
  if (!Array.isArray(data)) return [];
  return data.flatMap((it) => {
    const svc = it.service ?? it;
    return svc.id ? [{ id: svc.id, name: svc.name ?? svc.id }] : [];
  });
}

async function push(input: SyncPushInput): Promise<void> {
  const { token, externalProjectId, secrets } = input;
  // PUT remplace l'intégralité des vars du service par l'état désiré.
  const payload = secrets.map((s) => ({ key: s.key, value: s.value }));
  await renderFetch(
    token,
    "PUT",
    `/v1/services/${encodeURIComponent(externalProjectId)}/env-vars`,
    payload,
  );
}

export const renderConnector: SyncConnector = {
  provider: "render",

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
