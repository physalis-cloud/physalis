// Connecteur de sync sortante Railway (Phase B4).
//
// API GraphQL (vérifiée 2026-06-15). Endpoint + auth :
//   POST https://backboard.railway.com/graphql/v2
//   Authorization: Bearer <account token>  (Account Settings → Tokens)
//
// Adressage : Railway = projet → environnement → service. La cible Physalis stocke
// externalProjectId (project) + externalEnvironmentId + externalServiceId.
//
// Push : `variableCollectionUpsert(input:{ projectId, environmentId, serviceId,
// variables, replace:true })` → REMPLACE tout le jeu de vars du service (comme
// Render : Physalis devient source de vérité ; une var manuelle absente est retirée).
//
// Picker : `listResourceTree` ramène projets + environnements + services en une
// query (sélection en cascade côté UI). Garde-fous : host codé en dur, erreurs
// sanitizées.

import type {
  RemoteProject,
  RemoteTree,
  SyncConnector,
  SyncPushInput,
  SyncScope,
} from "./types";

const RAILWAY_API = "https://backboard.railway.com/graphql/v2";

function short(msg: string): string {
  return msg.replace(/\s+/g, " ").trim().slice(0, 200);
}

async function gql<T>(token: string, query: string, variables?: unknown): Promise<T> {
  const res = await fetch(RAILWAY_API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Railway HTTP ${res.status}`);
  const json = (await res.json()) as {
    data?: T;
    errors?: { message?: string }[];
  };
  if (json.errors && json.errors.length > 0) {
    throw new Error(`Railway: ${short(json.errors[0]?.message ?? "GraphQL error")}`);
  }
  if (!json.data) throw new Error("Railway: empty data");
  return json.data;
}

type EdgeList<T> = { edges: { node: T }[] };
type ProjectNode = {
  id: string;
  name: string;
  environments: EdgeList<{ id: string; name: string }>;
  services: EdgeList<{ id: string; name: string }>;
};

const PROJECTS_QUERY = `
  query {
    projects {
      edges {
        node {
          id
          name
          environments { edges { node { id name } } }
          services { edges { node { id name } } }
        }
      }
    }
  }`;

async function listResourceTree(token: string, _scope?: SyncScope): Promise<RemoteTree> {
  const data = await gql<{ projects: EdgeList<ProjectNode> }>(token, PROJECTS_QUERY);
  const projects = (data.projects?.edges ?? []).map((e) => ({
    id: e.node.id,
    name: e.node.name,
    environments: (e.node.environments?.edges ?? []).map((x) => ({ id: x.node.id, name: x.node.name })),
    services: (e.node.services?.edges ?? []).map((x) => ({ id: x.node.id, name: x.node.name })),
  }));
  return { projects };
}

async function listProjects(token: string, scope?: SyncScope): Promise<RemoteProject[]> {
  const tree = await listResourceTree(token, scope);
  return tree.projects.map((p) => ({ id: p.id, name: p.name }));
}

const UPSERT_MUTATION = `
  mutation($input: VariableCollectionUpsertInput!) {
    variableCollectionUpsert(input: $input)
  }`;

async function push(input: SyncPushInput): Promise<void> {
  const { token, externalProjectId, externalEnvironmentId, externalServiceId, secrets } = input;
  if (!externalEnvironmentId) throw new Error("Railway: environmentId manquant");
  const variables: Record<string, string> = {};
  for (const s of secrets) variables[s.key] = s.value;
  await gql(token, UPSERT_MUTATION, {
    input: {
      projectId: externalProjectId,
      environmentId: externalEnvironmentId,
      ...(externalServiceId ? { serviceId: externalServiceId } : {}),
      variables,
      replace: true, // bulk-replace : reflète exactement l'état Physalis
    },
  });
}

export const railwayConnector: SyncConnector = {
  provider: "railway",

  async test(token, scope) {
    try {
      await listResourceTree(token, scope);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: short(err instanceof Error ? err.message : String(err)) };
    }
  },

  listProjects,
  listResourceTree,
  push,
};
