import { NextResponse } from "next/server";
import { requireUser } from "@/lib/api";
import { withTenantSchema } from "@/lib/tenant";
import { createTokenIndex } from "@/lib/token-index";
import { logAction } from "@/lib/audit";
import {
  generatePluginToken,
  hashPluginToken,
  getPluginSessionTtl,
  isAllowedTtl,
  ALLOWED_TTLS,
} from "@/lib/plugin-token";

/**
 * Émet un PluginToken (session extension) à partir de la **session web NextAuth**
 * existante — SANS password ni TOTP. Sert le hand-off SSO → extension : un compte
 * fédéré (sans mot de passe Physalis) ne peut pas passer par /api/plugin/auth
 * (qui exige email+password+TOTP) ; mais une fois connecté sur le web via son IdP
 * (qui porte déjà le MFA), il peut émettre un token pour l'extension.
 *
 * Sécurité : gardé par la session web (cookie httpOnly/SameSite=Lax → pas de
 * CSRF cross-site exploitable, et la réponse n'est lisible qu'en same-origin —
 * pas de CORS ouvert ici, contrairement à /api/plugin/auth appelé depuis
 * l'extension). Vaut pour tout user authentifié (SSO comme classique : la
 * session web prouve déjà l'identité).
 */
export async function POST(req: Request) {
  const userRes = await requireUser();
  if ("error" in userRes) return userRes.error;
  const { user, tenantSlug } = userRes;

  // §2.18 — une session DÉRIVÉE d'un PluginToken ne peut pas re-frapper un
  // PluginToken : sinon un token volé, échangé contre une session web (branche
  // pluginToken du provider Credentials), re-frappait un token neuf à l'infini,
  // survivant à l'expiration ET à la révocation manuelle. Un vrai login web
  // (mot de passe / SSO / social) ou /api/plugin/auth (email+password+TOTP)
  // restent les seules sources d'un nouveau token.
  if (user.origin === "plugin_token") {
    return NextResponse.json(
      { error: "Session dérivée d'un token ; ré-authentification requise." },
      { status: 403 },
    );
  }

  if (!tenantSlug) {
    // SUPERADMIN platform-level : pas de schéma tenant → l'extension ne le sert
    // pas (elle autofill des credentials de projet, qui vivent dans un tenant).
    return NextResponse.json(
      { error: "Contexte client requis pour l'extension." },
      { status: 400 },
    );
  }

  const body = (await req.json().catch(() => null)) as { ttl?: number } | null;
  let ttlSeconds = getPluginSessionTtl();
  if (body?.ttl !== undefined) {
    if (!isAllowedTtl(body.ttl)) {
      return NextResponse.json(
        { error: `ttl must be one of: ${ALLOWED_TTLS.join(", ")} (seconds)` },
        { status: 400 },
      );
    }
    ttlSeconds = body.ttl;
  }

  const userAgent = req.headers.get("user-agent")?.slice(0, 500) ?? null;
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
  const token = generatePluginToken();
  const tokenHash = hashPluginToken(token);

  const created = await withTenantSchema(tenantSlug, (tx) =>
    tx.pluginToken.create({
      data: { tokenHash, userId: user.id, expiresAt, userAgent },
      select: { id: true },
    }),
  );

  // Index admin pour la validation tenant-aware au prochain /api/plugin/match.
  await createTokenIndex(tokenHash, tenantSlug, "PLUGIN").catch((err) => {
    console.error("[plugin-issue] failed to create token_index entry:", err);
  });

  logAction({
    action: "PLUGIN_AUTH_SUCCESS",
    actor: { kind: "user", userId: user.id, email: user.email },
    targetType: "PluginToken",
    targetId: created.id,
    metadata: { acceptedVia: "web_session", ttlSeconds, tenantSlug },
    req,
    tenantSlug,
  });

  return NextResponse.json({
    sessionToken: token,
    expiresAt: Math.floor(expiresAt.getTime() / 1000),
    email: user.email,
    tenantSlug,
  });
}
