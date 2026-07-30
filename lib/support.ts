// Client du microservice `physalis-support` (tickets de support). Module SERVEUR
// uniquement : il porte le `SUPPORT_SERVICE_TOKEN` qui ne doit JAMAIS atteindre
// le navigateur. Les routes /api/support/* l'utilisent comme proxy, en passant
// l'identité issue de la session (jamais des champs fournis par le client).
//
// Le service vit sur un hôte SÉPARÉ (cf. physalis-support) → on l'appelle en
// HTTP serveur→serveur (pas de CORS). Endpoints consommés : /v1/service/*.

export type SupportStatus = "OPEN" | "WAITING" | "RESOLVED" | "CLOSED";

export type SupportTicket = {
  ref: string;
  subject: string;
  status: SupportStatus;
  priority: string;
  source: string;
  requesterEmail: string;
  requesterName: string | null;
  clientSlug: string | null;
  orgId: string | null;
  userId: string | null;
  createdAt: string;
  updatedAt: string;
  lastReplyAt: string | null;
  lastReplyBy: "REQUESTER" | "STAFF" | null;
};

export type SupportMessage = {
  id: string;
  authorRole: "REQUESTER" | "STAFF";
  authorName: string | null;
  body: string;
  createdAt: string;
};

// Côté admin : le service renvoie en plus l'email de l'auteur et le flag
// `internal` (notes internes staff, jamais exposées au demandeur).
export type SupportAdminMessage = SupportMessage & {
  authorEmail: string | null;
  internal: boolean;
};

export type SupportStatusFilter = SupportStatus;

/** Vrai si l'app peut appeler le tier SERVICE du support (onglet compte). */
export function supportConfigured(): boolean {
  return Boolean(
    process.env.SUPPORT_SERVICE_URL && process.env.SUPPORT_SERVICE_TOKEN,
  );
}

/** Vrai si l'app peut appeler le tier ADMIN du support (espace admin). */
export function supportAdminConfigured(): boolean {
  return Boolean(
    process.env.SUPPORT_SERVICE_URL && process.env.SUPPORT_ADMIN_TOKEN,
  );
}

function baseUrl(): string {
  const url = process.env.SUPPORT_SERVICE_URL;
  if (!url) throw new Error("SUPPORT_SERVICE_URL non configuré");
  return url.replace(/\/+$/, "");
}

function serviceToken(): string {
  const token = process.env.SUPPORT_SERVICE_TOKEN;
  if (!token) throw new Error("SUPPORT_SERVICE_TOKEN non configuré");
  return token;
}

function adminToken(): string {
  const token = process.env.SUPPORT_ADMIN_TOKEN;
  if (!token) throw new Error("SUPPORT_ADMIN_TOKEN non configuré");
  return token;
}

export class SupportError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`Support HTTP ${status}`);
    this.name = "SupportError";
  }
}

/**
 * Appel à l'API service du support. Injecte `Authorization: Bearer <token>`
 * (jamais loggé). Lève `SupportError` (status + body tronqué) sur réponse non-OK.
 */
async function rawRequest<T>(
  method: "GET" | "POST" | "PATCH",
  path: string,
  token: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${baseUrl()}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new SupportError(res.status, text.slice(0, 500));
  }
  return (await res.json()) as T;
}

const supportRequest = <T>(
  method: "GET" | "POST" | "PATCH",
  path: string,
  body?: unknown,
) => rawRequest<T>(method, path, serviceToken(), body);

const adminRequest = <T>(
  method: "GET" | "POST" | "PATCH",
  path: string,
  body?: unknown,
) => rawRequest<T>(method, path, adminToken(), body);

// ── Méthodes ────────────────────────────────────────────────────────────────

/**
 * Anonymise les tickets d'un tenant dont le compte vient d'être purgé.
 *
 * Anonymisation et non suppression : un ticket est aussi une trace
 * d'exploitation (volume, délais de résolution). L'identité du demandeur, le
 * sujet, le jeton d'accès public au fil et **la totalité des messages**
 * disparaissent ; le squelette du ticket (numéro, statut, dates, `clientSlug`)
 * survit, sans donnée personnelle.
 *
 * Idempotent : rejouer réécrit les mêmes marqueurs.
 */
export function anonymizeTenantTickets(
  clientSlug: string,
): Promise<{ ok: boolean; tickets: number; messagesDeleted: number }> {
  return supportRequest(
    "POST",
    `/v1/service/tenants/${encodeURIComponent(clientSlug)}/anonymize`,
    {},
  );
}

/** Crée un ticket au nom d'un user connecté (identité issue de la session). */
export function createTicket(input: {
  subject: string;
  message: string;
  email: string;
  name?: string;
  clientSlug?: string | null;
  orgId?: string | null;
  userId?: string | null;
  locale?: string | null;
}): Promise<{ ref: string }> {
  return supportRequest("POST", "/v1/service/tickets", {
    subject: input.subject,
    message: input.message,
    email: input.email,
    name: input.name,
    clientSlug: input.clientSlug ?? undefined,
    orgId: input.orgId ?? undefined,
    userId: input.userId ?? undefined,
    locale: input.locale ?? undefined,
  });
}

/** Liste les tickets d'un user (par son id). */
export function listTicketsByUser(userId: string): Promise<{ tickets: SupportTicket[] }> {
  return supportRequest("GET", `/v1/service/tickets?userId=${encodeURIComponent(userId)}`);
}

/** Détail d'un ticket (messages publics). NE vérifie PAS la propriété — c'est
 * au caller (route proxy) de le faire avant de renvoyer au navigateur. */
export function getTicket(
  ref: string,
): Promise<{ ticket: SupportTicket; messages: SupportMessage[] }> {
  return supportRequest("GET", `/v1/service/tickets/${encodeURIComponent(ref)}`);
}

/** Ajoute une réponse du demandeur sur un ticket. */
export function replyTicket(
  ref: string,
  input: { message: string; userId?: string; email?: string; name?: string },
): Promise<{ message: SupportMessage }> {
  return supportRequest(
    "POST",
    `/v1/service/tickets/${encodeURIComponent(ref)}/messages`,
    input,
  );
}

/**
 * Vrai si le ticket appartient au user (par id, ou à défaut par email). Garde-fou
 * anti-énumération : un user ne doit voir/répondre QUE ses propres tickets.
 */
export function ownsTicket(
  ticket: SupportTicket,
  user: { id: string; email: string },
): boolean {
  if (ticket.userId) return ticket.userId === user.id;
  return Boolean(user.email) && ticket.requesterEmail === user.email;
}

// ── Tier ADMIN (espace admin, gating SUPERADMIN côté caller) ─────────────────

/** Liste tous les tickets (filtres optionnels). */
export function adminListTickets(filters: {
  status?: string;
  source?: string;
  clientSlug?: string;
  q?: string;
}): Promise<{ tickets: SupportTicket[] }> {
  const params = new URLSearchParams();
  if (filters.status) params.set("status", filters.status);
  if (filters.source) params.set("source", filters.source);
  if (filters.clientSlug) params.set("clientSlug", filters.clientSlug);
  if (filters.q) params.set("q", filters.q);
  const qs = params.toString();
  return adminRequest("GET", `/v1/admin/tickets${qs ? `?${qs}` : ""}`);
}

/** Détail complet d'un ticket (messages internes inclus). */
export function adminGetTicket(
  ref: string,
): Promise<{ ticket: SupportTicket; messages: SupportAdminMessage[] }> {
  return adminRequest("GET", `/v1/admin/tickets/${encodeURIComponent(ref)}`);
}

/** Réponse du staff (ou note interne si `internal`). */
export function adminReply(
  ref: string,
  input: { message: string; internal?: boolean; authorName?: string },
): Promise<{ message: SupportAdminMessage }> {
  return adminRequest(
    "POST",
    `/v1/admin/tickets/${encodeURIComponent(ref)}/messages`,
    input,
  );
}

/** Change le statut et/ou la priorité d'un ticket. */
export function adminPatchTicket(
  ref: string,
  input: { status?: string; priority?: string },
): Promise<{ ticket: SupportTicket }> {
  return adminRequest("PATCH", `/v1/admin/tickets/${encodeURIComponent(ref)}`, input);
}
