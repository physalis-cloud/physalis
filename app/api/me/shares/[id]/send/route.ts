// POST /api/me/shares/[id]/send — envoie l'URL d'un share par email au destinataire.
//
// Architecture : le client envoie l'URL COMPLETE (token + #fragment cle).
// Le serveur la transmet a Mailgun puis l'oublie immediatement (pas de
// persistance). C'est une exception consciente au zero-knowledge :
// Mailgun voit l'URL, donc la cle. Acceptable comme tradeoff (l'user
// choisit explicitement d'envoyer par email).
//
// Validations :
//   - L'user doit posseder le share
//   - Le share doit etre encore actif (pas consomme/expire/revoque)
//   - Email format minimal
//
// Audit `SHARE_SEND_EMAIL` avec metadata.recipientEmail pour traceabilite.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { readJson, requireUser } from "@/lib/api";
import { logAction } from "@/lib/audit";
import { sendEmail } from "@/lib/email";
import { rateLimit } from "@/lib/rate-limit";
import { hashShareToken, isShareTokenFormat } from "@/lib/share-token";
import { tenantBaseUrl } from "@/lib/app-url";
import { esc } from "@/lib/email-layout";
import { routing } from "@/i18n/routing";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Body = {
  email?: string;
  url?: string;
};

export async function POST(req: Request, { params }: Params) {
  const userRes = await requireUser();
  if ("error" in userRes) return userRes.error;
  const { user, tenantSlug } = userRes;
  const { id } = await params;

  const limited = rateLimit(
    req,
    "share-send-email",
    { max: 10, windowMs: 60_000 },
    user.id,
  );
  if (limited) return limited;

  const body = (await readJson(req)) as Body | null;
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  if (typeof body.email !== "string" || !EMAIL_RE.test(body.email.trim())) {
    return NextResponse.json(
      { error: "valid email required" },
      { status: 400 },
    );
  }
  if (typeof body.url !== "string" || body.url.length > 2048) {
    return NextResponse.json({ error: "valid url required" }, { status: 400 });
  }

  const share = await prisma.oneTimeShare.findFirst({
    where: { id, createdById: user.id },
  });
  if (!share) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (share.consumedAt || share.revokedAt || share.expiresAt <= new Date()) {
    return NextResponse.json(
      { error: "Share is no longer active" },
      { status: 400 },
    );
  }

  // §2.22 — l'URL n'était validée que par `startsWith("http")`, sans AUCUN lien
  // avec le share, puis interpolée non échappée : un utilisateur (même un compte
  // FREE auto-créé) envoyait un mail signé par notre DKIM pointant vers un host
  // arbitraire (phishing) + injectait du markup. On VÉRIFIE que l'URL désigne
  // bien CE share (token → hash — impossible à forger sans le vrai token), puis
  // on RECONSTRUIT l'origine côté serveur (`tenantBaseUrl`, dérivée de la session,
  // non forgeable — cf. §2.11) en ne conservant QUE le fragment (la clé, jamais
  // reconstructible côté serveur : design zero-knowledge).
  let safeUrl: string;
  try {
    const parsed = new URL(body.url);
    const segments = parsed.pathname.split("/").filter(Boolean);
    const token = segments.at(-1) ?? "";
    if (!isShareTokenFormat(token) || hashShareToken(token) !== share.tokenHash) {
      throw new Error("url does not match this share");
    }
    const localeSeg = segments.at(-3); // forme canonique : /<locale>/share/<token>
    const locale = (routing.locales as readonly string[]).includes(
      localeSeg ?? "",
    )
      ? localeSeg
      : routing.defaultLocale;
    safeUrl = `${tenantBaseUrl(tenantSlug)}/${locale}/share/${token}${parsed.hash}`;
  } catch {
    return NextResponse.json(
      { error: "url does not match this share" },
      { status: 400 },
    );
  }

  const recipient = body.email.trim().toLowerCase();
  const expires = share.expiresAt.toLocaleString("fr-FR", {
    timeZone: "Europe/Paris",
  });
  // Sanitize : retire les caractères de contrôle (dont newline → injection de
  // sujet) et borne la longueur ; `label` est interpolé dans le texte, le HTML
  // (échappé) et le sujet.
  const label =
    share.title?.replace(/\p{Cc}/gu, " ").trim().slice(0, 200) ||
    "Sans titre";
  const hasPassword = share.passwordHash !== null;

  const text = [
    `Bonjour,`,
    ``,
    `${user.email} t'a partagé un secret via Physalis : "${label}".`,
    ``,
    `Ouvre ce lien à usage unique avant ${expires} :`,
    safeUrl,
    ``,
    hasPassword
      ? `Un mot de passe te sera demandé. ${user.email} te l'a (ou va te le) communiquer via un autre canal.`
      : `Le lien sera détruit automatiquement après ouverture.`,
    ``,
    `Si tu n'attendais pas ce partage, ignore ce message.`,
  ].join("\n");

  const html = `
    <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;color:#1a1a2e">
      <h2 style="margin:0 0 16px;font-size:20px">Un secret t'a été partagé</h2>
      <p style="margin:0 0 12px">
        <strong>${esc(user.email)}</strong> t'a partagé "<strong>${esc(label)}</strong>" via Physalis.
      </p>
      <p style="margin:0 0 16px">Ouvre ce lien à usage unique avant <strong>${esc(expires)}</strong> :</p>
      <a href="${esc(safeUrl)}"
         style="display:inline-block;margin:0 0 16px;padding:12px 24px;background:#1a1f35;color:#fff;border-radius:8px;text-decoration:none;font-weight:500;word-break:break-all">
        Voir le secret
      </a>
      ${
        hasPassword
          ? `<p style="margin:16px 0 0;font-size:13px;color:#4a5568">Un mot de passe te sera demandé — il t'a été (ou va t'être) communiqué par un autre canal.</p>`
          : `<p style="margin:16px 0 0;font-size:13px;color:#4a5568">Le lien sera détruit automatiquement après ouverture.</p>`
      }
      <p style="margin:16px 0 0;font-size:12px;color:#718096">Si tu n'attendais pas ce partage, ignore ce message.</p>
    </div>
  `;

  try {
    await sendEmail({
      to: recipient,
      subject: `${user.email} t'a partagé "${label}" sur Physalis`,
      text,
      html,
    });
  } catch (err) {
    console.error("[share] failed to send email:", err);
    return NextResponse.json(
      { error: "Email transport failed" },
      { status: 502 },
    );
  }

  logAction({
    action: "SHARE_SEND_EMAIL",
    actor: { kind: "user", userId: user.id, email: user.email },
    organizationId: share.organizationId,
    targetType: "OneTimeShare",
    targetId: share.id,
    metadata: { recipientEmail: recipient, hasPassword },
    req,
  });

  return NextResponse.json({ ok: true });
}
