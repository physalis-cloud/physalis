// GET /api/integrations/credentials — Phase 11b.
//
// Endpoint dédié aux intégrations N8n / Make / scripts custom. Retourne
// secrets / services / app accounts d'un projet, déchiffrés et filtrés
// selon les query params.
//
// Auth : Bearer (UserToken `sv_user_<hex>` OU MachineToken `sv_<hex>`)
// via lib/integration-token.ts. RBAC :
//   - UserToken    : check ProjectMember pour l'user du token
//   - MachineToken : project+env sont locked au token, autres = 403
//
// Query params :
//   project (req)  slug du projet
//   env            nom de l'environnement — REQUIRED si type=secret
//   type (req)     "secret" | "service" | "account"
//   tag            filtre par tag exact (single)
//   key            filtre par nom de clé (secrets seulement)
//
// Réponse : `{ type, items: [{...}] }` — la valeur/password est en clair
// (le caller détient déjà la "racine de confiance" via le Bearer token).
//
// Audit : INTEGRATION_CREDENTIALS_FETCH (1 entry par appel, pas par item).

import { NextResponse } from "next/server";
import { decrypt } from "@/lib/crypto";
import {
  extractBearer,
  orgTokenAllowsProject,
  scopeForType,
  validateIntegrationToken,
} from "@/lib/integration-token";
import { withTenantSchema } from "@/lib/tenant";
import { logAction } from "@/lib/audit";

type ItemType = "secret" | "service" | "account";

type ServiceCreds = { user?: string; password?: string };

function decryptCreds(payload: {
  encryptedData: string;
  iv: string;
  tag: string;
}): { user: string; password: string } {
  const json = decrypt({
    encryptedValue: payload.encryptedData,
    iv: payload.iv,
    tag: payload.tag,
  });
  const parsed = JSON.parse(json) as ServiceCreds;
  return { user: parsed.user ?? "", password: parsed.password ?? "" };
}

export async function GET(req: Request) {
  const token = extractBearer(req);
  if (!token) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const ctx = await validateIntegrationToken(token);
  if (!ctx) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const projectSlug = url.searchParams.get("project");
  const envName = url.searchParams.get("env");
  const type = url.searchParams.get("type") as ItemType | null;
  const tag = url.searchParams.get("tag");
  const keyFilter = url.searchParams.get("key");

  if (!projectSlug) {
    return NextResponse.json({ error: "project query param is required" }, { status: 400 });
  }
  if (!type || !["secret", "service", "account"].includes(type)) {
    return NextResponse.json(
      { error: "type query param must be one of: secret, service, account" },
      { status: 400 },
    );
  }
  if (type === "secret" && !envName) {
    return NextResponse.json(
      { error: "env query param is required when type=secret" },
      { status: 400 },
    );
  }

  // RBAC machine token : project+env doivent matcher exactement.
  if (ctx.kind === "machine") {
    if (ctx.projectSlug !== projectSlug) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    if (type === "secret" && envName && ctx.environmentName !== envName) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  // RBAC org token : check du scope (les types de ressources sont mappés
  // 1-pour-1 vers SECRETS_READ / SERVICES_READ / ACCOUNTS_READ).
  if (ctx.kind === "org") {
    const requiredScope = scopeForType(type);
    if (!ctx.allowedScopes.includes(requiredScope)) {
      return NextResponse.json({ error: "Forbidden (scope)" }, { status: 403 });
    }
  }

  // Lookup tenant : on entre le contexte par tenantSlug du token.
  const result = await withTenantSchema(ctx.tenantSlug, async (tx) => {
    // Check projet existe + RBAC selon le type de token.
    const project = await tx.project.findUnique({
      where: { slug: projectSlug },
      select: { id: true, organizationId: true },
    });
    if (!project) return { kind: "not_found" as const };

    if (ctx.kind === "user") {
      // Un UserToken agit AU NOM du user : il ne doit pas ouvrir ce que l'UI
      // lui ferme. On lit `hidden` — vérifier la seule EXISTENCE de la ligne
      // laissait passer les projets masqués (requireProjectMember, règle 2).
      const member = await tx.projectMember.findUnique({
        where: {
          userId_projectId: { userId: ctx.userId, projectId: project.id },
        },
        select: { role: true, hidden: true },
      });
      if (!member || member.hidden) return { kind: "forbidden" as const };
    } else if (ctx.kind === "org") {
      // Check 1 : projet appartient à la même org que le token
      if (project.organizationId !== ctx.organizationId) {
        return { kind: "forbidden" as const };
      }
      // Check 2 : projet dans la liste autorisée (ou allProjects=true)
      if (!orgTokenAllowsProject(ctx, project.id)) {
        return { kind: "forbidden" as const };
      }
    }

    // Branche par type.
    if (type === "secret") {
      const env = await tx.environment.findUnique({
        where: { projectId_name: { projectId: project.id, name: envName! } },
        select: { id: true },
      });
      if (!env) return { kind: "not_found" as const };

      const secrets = await tx.secret.findMany({
        where: {
          environmentId: env.id,
          ...(tag ? { tags: { has: tag } } : {}),
          ...(keyFilter ? { key: keyFilter } : {}),
        },
        select: {
          key: true,
          encryptedValue: true,
          iv: true,
          tag: true,
          category: true,
          tags: true,
        },
      });
      const items = secrets.map((s) => ({
        key: s.key,
        value: decrypt({
          encryptedValue: s.encryptedValue,
          iv: s.iv,
          tag: s.tag,
        }),
        category: s.category,
        tags: s.tags,
      }));
      return {
        kind: "ok" as const,
        items,
        organizationId: project.organizationId,
        projectId: project.id,
        environmentId: env.id,
      };
    }

    if (type === "service") {
      const services = await tx.service.findMany({
        where: {
          projectId: project.id,
          ...(tag ? { tags: { has: tag } } : {}),
        },
        select: {
          id: true,
          name: true,
          url: true,
          encryptedData: true,
          iv: true,
          tag: true,
          tags: true,
        },
      });
      const items = services.map((s) => {
        const creds = decryptCreds(s);
        return {
          id: s.id,
          name: s.name,
          url: s.url,
          username: creds.user,
          password: creds.password,
          tags: s.tags,
        };
      });
      return {
        kind: "ok" as const,
        items,
        organizationId: project.organizationId,
        projectId: project.id,
      };
    }

    // type === "account"
    const accounts = await tx.appAccount.findMany({
      where: {
        projectId: project.id,
        ...(tag ? { tags: { has: tag } } : {}),
      },
      select: {
        id: true,
        name: true,
        encryptedData: true,
        iv: true,
        tag: true,
        tags: true,
      },
    });
    const items = accounts.map((a) => {
      const creds = decryptCreds(a);
      return {
        id: a.id,
        name: a.name,
        username: creds.user,
        password: creds.password,
        tags: a.tags,
      };
    });
    return {
      kind: "ok" as const,
      items,
      organizationId: project.organizationId,
      projectId: project.id,
    };
  });

  if (result.kind === "not_found") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (result.kind === "forbidden") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Audit (1 entry par fetch, pas par item — éviter la pollution).
  logAction({
    action: "INTEGRATION_CREDENTIALS_FETCH",
    actor:
      ctx.kind === "user"
        ? { kind: "user", userId: ctx.userId, email: ctx.userEmail }
        : { kind: "token", tokenId: ctx.tokenId, tokenName: ctx.tokenName },
    organizationId: result.organizationId,
    projectId: result.projectId,
    environmentId: "environmentId" in result ? result.environmentId : undefined,
    targetType: type === "secret" ? "Secret" : type === "service" ? "Service" : "AppAccount",
    metadata: {
      tokenKind: ctx.kind,
      type,
      tag,
      keyFilter,
      count: result.items.length,
    },
    req,
  });

  return NextResponse.json({ type, items: result.items });
}
