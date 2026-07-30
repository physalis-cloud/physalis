/**
 * Email delivery.
 *
 * Provider selection (first match wins):
 *   - EMAIL_MAILGUN_API_KEY + EMAIL_MAILGUN_DOMAIN + EMAIL_MAILGUN_HOST → Mailgun API
 *   - RESEND_API_KEY                                                    → Resend
 *   - SMTP_URL                                                          → SMTP
 *   - (none)                                                            → stdout stub
 *
 * The rest of the app calls `sendEmail()` and `sendInvitationEmail()`
 * without knowing the provider.
 *
 * NEVER log secrets, only invitation links.
 */

import {
  renderEmail,
  esc,
  p,
  panel,
  noticePanel,
  dataRows,
} from "./email-layout";

export type EmailMessage = {
  to: string;
  subject: string;
  text: string;
  html?: string;
};

type Transport = {
  send: (msg: EmailMessage) => Promise<void>;
};

// ── Mailgun ────────────────────────────────────────────────────────────────

async function mailgunTransport(): Promise<Transport> {
  const { default: Mailgun } = await import("mailgun.js");
  const { default: FormData } = await import("form-data");

  const mg = new Mailgun(FormData).client({
    username: "api",
    key: process.env.EMAIL_MAILGUN_API_KEY!,
    url: `https://${process.env.EMAIL_MAILGUN_HOST ?? "api.mailgun.net"}`,
  });

  const domain = process.env.EMAIL_MAILGUN_DOMAIN!;
  const from =
    process.env.EMAIL_FROM ?? `Physalis <noreply@${domain}>`;

  return {
    async send(msg) {
      await mg.messages.create(domain, {
        from,
        to: msg.to,
        subject: msg.subject,
        text: msg.text,
        ...(msg.html ? { html: msg.html } : {}),
      });
    },
  };
}

// ── Stdout stub (dev) ──────────────────────────────────────────────────────

function consoleTransport(): Transport {
  return {
    async send(msg) {
      // §2.25e — ne JAMAIS imprimer msg.text : il porte les liens bruts
      // (resetUrl → sv_reset_<64hex>, acceptUrl, requestUrl). On ne loggue que
      // les métadonnées d'acheminement.
      console.log(`[email:stub] to=${msg.to} subject="${msg.subject}"`);
    },
  };
}

// ── Provider selection ─────────────────────────────────────────────────────

// Cache l'instance pour eviter de re-importer mailgun.js et reconstruire le
// client a chaque envoi. Le module est charge une fois pour la duree du
// process Node.
let cachedTransport: Transport | undefined;

async function transport(): Promise<Transport> {
  if (cachedTransport) return cachedTransport;
  if (process.env.EMAIL_MAILGUN_API_KEY && process.env.EMAIL_MAILGUN_DOMAIN) {
    cachedTransport = await mailgunTransport();
  } else {
    // Brancher d'autres providers ici si besoin :
    // if (process.env.RESEND_API_KEY) cachedTransport = await resendTransport();
    // if (process.env.SMTP_URL)       cachedTransport = await smtpTransport();
    //
    // §2.25e — le stub stdout n'envoie RIEN. Le laisser dégrader silencieusement
    // en prod = mails transactionnels (reset, invitation, secret request) perdus
    // sans le moindre signal. On refuse de basculer sur le stub hors dev : une
    // mauvaise conf email doit échouer bruyamment, pas fuir.
    if (
      process.env.NODE_ENV !== "development" &&
      process.env.NODE_ENV !== "test"
    ) {
      throw new Error(
        "Aucun provider email configuré (EMAIL_MAILGUN_API_KEY/DOMAIN). Le " +
          "transport stdout est interdit hors développement — refus d'envoyer.",
      );
    }
    cachedTransport = consoleTransport();
  }
  return cachedTransport;
}

// ── Public API ─────────────────────────────────────────────────────────────

export async function sendEmail(msg: EmailMessage): Promise<void> {
  const t = await transport();
  await t.send(msg);
}

export type InvitationEmailParams = {
  to: string;
  inviterEmail: string;
  organizationName: string;
  acceptUrl: string;
  expiresAt: Date;
};

export async function sendInvitationEmail(
  params: InvitationEmailParams,
): Promise<void> {
  const expires = params.expiresAt.toISOString().split("T")[0];

  const text = [
    `Bonjour,`,
    ``,
    `${params.inviterEmail} vous invite à rejoindre l'organisation "${params.organizationName}" sur Physalis.`,
    ``,
    `Accepter l'invitation :`,
    params.acceptUrl,
    ``,
    `Ce lien expire le ${expires}.`,
    ``,
    `Si vous n'attendiez pas cette invitation, ignorez ce message.`,
  ].join("\n");

  const html = renderEmail({
    title: `Invitation à rejoindre ${esc(params.organizationName)}`,
    bodyHtml: p(
      `<strong>${esc(params.inviterEmail)}</strong> vous invite à rejoindre l'organisation <strong>${esc(params.organizationName)}</strong> sur Physalis.`,
    ),
    cta: { label: "Accepter l'invitation", url: params.acceptUrl },
    footerHtml: `Ce lien expire le ${esc(expires)}.<br>Si vous n'attendiez pas cette invitation, ignorez ce message.`,
  }, "fr");

  await sendEmail({
    to: params.to,
    subject: `Invitation à rejoindre ${params.organizationName} sur Physalis`,
    text,
    html,
  });
}

export type WelcomeEmailParams = {
  to: string;
  clientName: string;
  loginUrl: string;
  /** null pour le plan FREE (pas de trial). */
  trialEndsAt: Date | null;
  plan: "free" | "shared" | "dedicated";
};

export async function sendWelcomeEmail(params: WelcomeEmailParams): Promise<void> {
  // FREE = gratuit permanent, pas de mention de trial.
  // SHARED/DEDICATED = trial 14j avec date d'expiration.
  const trialLine =
    params.plan === "free" || !params.trialEndsAt
      ? "Votre offre est gratuite et permanente — pas de date d'expiration."
      : `Votre période d'essai de 14 jours expire le ${params.trialEndsAt.toISOString().split("T")[0]}.`;

  const text = [
    `Bienvenue sur Physalis,`,
    ``,
    `Le compte ${params.clientName} a été créé avec succès (offre ${params.plan}).`,
    ``,
    `URL d'accès :`,
    params.loginUrl,
    ``,
    trialLine,
    ``,
    `À très vite,`,
    `L'équipe Physalis`,
  ].join("\n");

  const html = renderEmail({
    title: "Bienvenue sur Physalis",
    bodyHtml: p(
      `Le compte <strong>${esc(params.clientName)}</strong> a été créé avec succès (offre <strong>${esc(params.plan)}</strong>).`,
    ),
    cta: { label: "Accéder à mon espace", url: params.loginUrl },
    footerHtml: trialLine,
  }, "fr");

  await sendEmail({
    to: params.to,
    subject: `Bienvenue sur Physalis — ${params.clientName}`,
    text,
    html,
  });
}

export type PasswordResetEmailParams = {
  to: string;
  resetUrl: string;
  expiresAt: Date;
};

/**
 * Email avec lien de reset de mot de passe. Le lien contient le token
 * brut — il faut donc passer par HTTPS (le sous-domaine tenant l'est par
 * défaut sur Physalis prod). Le contenu du mail ne dévoile aucune info
 * personnelle (par design : on ne sait pas si l'email correspond à un
 * compte ou pas — voir /forgot-password qui répond toujours OK).
 */
export async function sendPasswordResetEmail(
  params: PasswordResetEmailParams,
): Promise<void> {
  const expires = params.expiresAt.toLocaleString("fr-FR", {
    timeZone: "Europe/Paris",
  });

  const text = [
    `Bonjour,`,
    ``,
    `Vous (ou quelqu'un d'autre) avez demandé la réinitialisation du mot de passe pour ce compte sur Physalis.`,
    ``,
    `Pour définir un nouveau mot de passe, cliquez sur ce lien :`,
    params.resetUrl,
    ``,
    `Ce lien est valable jusqu'au ${expires} et ne peut être utilisé qu'une seule fois.`,
    ``,
    `Si vous n'êtes pas à l'origine de cette demande, ignorez ce message — votre mot de passe actuel reste valide.`,
  ].join("\n");

  const html = renderEmail({
    title: "Réinitialisation du mot de passe",
    bodyHtml: p(
      `Vous (ou quelqu'un d'autre) avez demandé la réinitialisation du mot de passe pour ce compte sur <strong>Physalis</strong>.`,
    ),
    cta: { label: "Définir un nouveau mot de passe", url: params.resetUrl },
    footerHtml: `Ce lien est valable jusqu'au ${esc(expires)} et ne peut être utilisé qu'une seule fois.<br>Si vous n'êtes pas à l'origine de cette demande, ignorez ce message — votre mot de passe actuel reste valide.`,
  }, "fr");

  await sendEmail({
    to: params.to,
    subject: `Réinitialisation de votre mot de passe Physalis`,
    text,
    html,
  });
}

export type SecretRequestEmailParams = {
  to: string;
  requesterEmail: string;
  label: string;
  description: string | null;
  requestUrl: string;
  expiresAt: Date;
};

/**
 * Email envoyé au destinataire externe d'une SecretRequest. Contient
 * uniquement le lien (qui contient le token) — le secret réel est saisi
 * par le destinataire dans son navigateur, chiffré côté client.
 */
export async function sendSecretRequestEmail(
  params: SecretRequestEmailParams,
): Promise<void> {
  const expires = params.expiresAt.toLocaleString("fr-FR", {
    timeZone: "Europe/Paris",
  });

  const text = [
    `Bonjour,`,
    ``,
    `${params.requesterEmail} (via Physalis) vous demande de partager :`,
    `« ${params.label} »`,
    ...(params.description ? [``, params.description] : []),
    ``,
    `Pour transmettre votre secret de façon sécurisée :`,
    params.requestUrl,
    ``,
    `Le secret sera chiffré dans votre navigateur avant envoi — Physalis ne peut pas le lire.`,
    ``,
    `Ce lien expire le ${expires} et ne peut être utilisé qu'une seule fois.`,
    ``,
    `Si vous n'attendiez pas cette demande, ignorez ce message.`,
  ].join("\n");

  const html = renderEmail({
    title: "Demande de secret sécurisée",
    bodyHtml: [
      p(`<strong>${esc(params.requesterEmail)}</strong> (via Physalis) vous demande de partager :`),
      panel(`<strong>${esc(params.label)}</strong>`),
      params.description ? p(esc(params.description), { muted: true }) : "",
    ].join(""),
    cta: { label: "Transmettre le secret", url: params.requestUrl },
    footerHtml: `🔐 Le secret est chiffré dans votre navigateur avant envoi — Physalis ne peut pas le lire.<br>Ce lien expire le ${esc(expires)}.`,
  }, "fr");

  await sendEmail({
    to: params.to,
    subject: `${params.requesterEmail} vous demande de partager un secret`,
    text,
    html,
  });
}

export type SecretReceivedEmailParams = {
  to: string;
  label: string;
  submitterIp: string | null;
  reviewUrl: string;
};

/**
 * Notification à l'admin (= author de la SecretRequest) quand le destinataire
 * vient de soumettre son secret. Permet de réagir rapidement (révéler /
 * importer / révoquer si timing suspect).
 */
export async function sendSecretReceivedEmail(
  params: SecretReceivedEmailParams,
): Promise<void> {
  const text = [
    `Bonjour,`,
    ``,
    `Le secret demandé pour « ${params.label} » vient d'être transmis sur Physalis.`,
    ...(params.submitterIp ? [``, `IP du soumetteur : ${params.submitterIp}`] : []),
    ``,
    `Pour le révéler et l'importer :`,
    params.reviewUrl,
    ``,
    `Si ce timing ne correspond pas à ce que vous attendiez, révoquez la demande sans la révéler.`,
  ].join("\n");

  const html = renderEmail({
    title: "Secret reçu",
    bodyHtml: [
      p(`Le secret demandé pour <strong>« ${esc(params.label)} »</strong> vient d'être transmis sur Physalis.`),
      params.submitterIp ? dataRows([["IP du soumetteur :", esc(params.submitterIp)]]) : "",
    ].join(""),
    cta: { label: "Révéler le secret", url: params.reviewUrl },
    footerHtml: `Si ce timing ne correspond pas à ce que vous attendiez, révoquez la demande sans la révéler.`,
  }, "fr");

  await sendEmail({
    to: params.to,
    subject: `Secret reçu : ${params.label}`,
    text,
    html,
  });
}

export type ShareConsumedEmailParams = {
  to: string;
  title: string | null;
  createdAt: Date;
  consumedAt: Date;
  viewedFromIp: string | null;
};

/**
 * Notification au createur d'un OneTimeShare quand il vient d'etre consomme.
 * Permet de detecter rapidement un detournement (consommation a une heure /
 * IP non attendue). Le contenu reel n'est PAS dans l'email — seulement la
 * metadata.
 */
export async function sendShareConsumedEmail(
  params: ShareConsumedEmailParams,
): Promise<void> {
  const label = params.title?.trim() || "Sans titre";
  const consumed = params.consumedAt.toLocaleString("fr-FR", {
    timeZone: "Europe/Paris",
  });
  const created = params.createdAt.toLocaleString("fr-FR", {
    timeZone: "Europe/Paris",
  });
  const ip = params.viewedFromIp ?? "inconnue";

  const text = [
    `Bonjour,`,
    ``,
    `Votre partage "${label}" a été consommé sur Physalis.`,
    ``,
    `Créé le : ${created}`,
    `Consommé le : ${consumed}`,
    `Depuis l'IP : ${ip}`,
    ``,
    `Si ce n'est pas vous (ou la personne à qui vous l'avez envoyé), considerez le contenu comme compromis et changez-le si besoin.`,
  ].join("\n");

  const html = renderEmail({
    title: "Partage consommé",
    bodyHtml:
      p(`Votre partage <strong>"${esc(label)}"</strong> vient d'être ouvert sur Physalis.`) +
      dataRows([
        ["Créé le :", esc(created)],
        ["Consommé le :", esc(consumed)],
        ["Depuis l'IP :", esc(ip)],
      ]),
    footerHtml: `Si ce n'est pas vous (ou la personne destinataire), considérez le contenu comme compromis et changez-le si besoin.`,
  }, "fr");

  await sendEmail({
    to: params.to,
    subject: `Partage "${label}" consommé`,
    text,
    html,
  });
}

// ── Billing : confirmation de souscription ─────────────────────────────────

export type CheckoutCompletedEmailParams = {
  to: string;
  clientName: string;
  planLabel: string;
  /** Prix base mensuel en cents (sans add-ons). */
  basePriceCents: number;
  /** URL absolue vers /account pour gérer l'abonnement. */
  accountUrl: string;
};

/**
 * Envoyé immédiatement après qu'un user OWNER ait complété un Stripe
 * Checkout avec succès. Confirme l'activation du plan + rappelle où
 * gérer l'abonnement. Le reçu de paiement détaillé (avec montant
 * exact, factures) est envoyé séparément par Stripe (Settings >
 * Customer emails > Successful payments) — on évite ainsi de
 * dupliquer les chiffres et les obligations légales de facturation.
 */
export async function sendCheckoutCompletedEmail(
  params: CheckoutCompletedEmailParams,
): Promise<void> {
  const priceLabel = formatEuroPrice(params.basePriceCents);
  const text = [
    `Bonjour,`,
    ``,
    `Votre abonnement Physalis ${params.planLabel.toUpperCase()} est`,
    `maintenant actif pour ${params.clientName}.`,
    ``,
    `Tarif de base : ${priceLabel}/mois (hors add-ons éventuels).`,
    ``,
    `Stripe vous a envoyé séparément le reçu de paiement détaillé`,
    `avec le montant exact et le lien pour télécharger votre facture.`,
    ``,
    `Gérer votre abonnement (changement de plan, ajout/retrait`,
    `d'organisations ou de sièges, mise à jour de la carte, factures) :`,
    params.accountUrl,
    ``,
    `À très vite,`,
    `L'équipe Physalis`,
  ].join("\n");

  const html = renderEmail({
    title: "Abonnement activé",
    bodyHtml:
      p(`Votre abonnement Physalis <strong>${esc(params.planLabel.toUpperCase())}</strong> est maintenant actif pour <strong>${esc(params.clientName)}</strong>.`) +
      panel(`<strong>Tarif de base :</strong> ${esc(priceLabel)}/mois (hors add-ons éventuels).`) +
      p(`Stripe vous a envoyé séparément le reçu de paiement détaillé avec le montant exact et le lien pour télécharger votre facture.`, { muted: true }),
    cta: { label: "Gérer mon abonnement", url: params.accountUrl },
  }, "fr");

  await sendEmail({
    to: params.to,
    subject: `Bienvenue sur Physalis ${params.planLabel.toUpperCase()} — ${params.clientName}`,
    text,
    html,
  });
}

function formatEuroPrice(cents: number): string {
  const euros = cents / 100;
  return new Intl.NumberFormat("fr-FR", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: euros % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(euros);
}

// ── Billing : passage au plan FREE ─────────────────────────────────────────

export type DowngradeFreeEmailParams = {
  to: string;
  clientName: string;
  /** Nombre d'organisations utilisées au moment du downgrade. */
  orgsCount: number;
  /** Nombre d'utilisateurs utilisés au moment du downgrade. */
  usersCount: number;
  /** URL absolue vers /account pour upgrade. */
  accountUrl: string;
};

/**
 * Envoyé immédiatement après qu'un OWNER ait basculé son tenant sur le
 * plan FREE. Confirme le downgrade, mentionne les ressources en
 * overage si applicable, rappelle que les données sont conservées.
 */
export async function sendDowngradeFreeEmail(
  params: DowngradeFreeEmailParams,
): Promise<void> {
  const FREE_MAX_ORGS = 1;
  const FREE_MAX_USERS = 1;
  const orgsOver = params.orgsCount > FREE_MAX_ORGS;
  const usersOver = params.usersCount > FREE_MAX_USERS;
  const inOverage = orgsOver || usersOver;

  const lines = [
    `Bonjour,`,
    ``,
    `Votre abonnement Physalis pour ${params.clientName} a été basculé sur le plan FREE.`,
    `Votre carte ne sera plus prélevée.`,
    ``,
    `État actuel de votre compte :`,
    `• ${params.orgsCount} organisation${params.orgsCount > 1 ? "s" : ""} (quota FREE : ${FREE_MAX_ORGS})`,
    `• ${params.usersCount} utilisateur${params.usersCount > 1 ? "s" : ""} (quota FREE : ${FREE_MAX_USERS})`,
    ``,
  ];

  if (inOverage) {
    lines.push(
      `⚠ Votre usage dépasse les quotas FREE. Tant que cette situation`,
      `dure :`,
      `  • Création de nouvelles organisations et utilisateurs bloquée.`,
      `  • Déploiements automatiques (GitHub Actions OIDC) désactivés sur les organisations excédentaires (l'organisation principale reste autorisée).`,
      ``,
      `Vos données existantes sont conservées intégralement. Il vous suffit`,
      `de re-souscrire un plan payant à tout moment pour tout réactiver`,
      `instantanément.`,
      ``,
    );
  } else {
    lines.push(
      `Votre usage rentre dans les quotas FREE. Aucune restriction.`,
      ``,
    );
  }

  lines.push(
    `Gérer mon abonnement :`,
    params.accountUrl,
    ``,
    `À très vite,`,
    `L'équipe Physalis`,
  );

  const text = lines.join("\n");

  const overageBlockHtml = inOverage
    ? noticePanel(
        `<strong>Votre compte est en overage</strong>` +
          `<ul style="margin:8px 0 0 18px;padding:0">` +
          `<li>Création de nouvelles organisations / utilisateurs bloquée.</li>` +
          `<li>Déploiements automatiques (GitHub Actions OIDC) désactivés sur les organisations excédentaires (l'organisation principale reste autorisée).</li>` +
          `</ul>` +
          `<div style="margin:8px 0 0;font-size:13px">Repassez sur une offre payante ou réduisez vos ressources pour lever ces limitations.</div>`,
      )
    : p("Vos ressources tiennent dans les quotas FREE — rien n'est bloqué.", { muted: true });

  const html = renderEmail({
    title: "Passage au plan FREE confirmé",
    bodyHtml:
      p(`Votre abonnement Physalis pour <strong>${esc(params.clientName)}</strong> a été basculé sur le plan FREE. Votre carte ne sera plus prélevée.`) +
      panel(
        `<strong>État de votre compte :</strong><br>` +
        `• ${params.orgsCount} organisation${params.orgsCount > 1 ? "s" : ""} (quota FREE : ${FREE_MAX_ORGS})<br>` +
        `• ${params.usersCount} utilisateur${params.usersCount > 1 ? "s" : ""} (quota FREE : ${FREE_MAX_USERS})`,
      ) +
      overageBlockHtml,
    cta: { label: "Gérer mon abonnement", url: params.accountUrl },
  }, "fr");

  await sendEmail({
    to: params.to,
    subject: `Passage au plan FREE confirmé — ${params.clientName}`,
    text,
    html,
  });
}

// ── Billing : relances overage ─────────────────────────────────────────────

export type OverageReminderEmailParams = {
  to: string;
  clientName: string;
  orgsCount: number;
  usersCount: number;
  accountUrl: string;
};

/** Relance J+7 après un downgrade FREE si l'overage persiste. */
export async function sendOverageReminderJ7Email(
  params: OverageReminderEmailParams,
): Promise<void> {
  await sendOverageReminderEmail(params, "J7");
}

/** Relance J+30 après un downgrade FREE si l'overage persiste. */
export async function sendOverageReminderJ30Email(
  params: OverageReminderEmailParams,
): Promise<void> {
  await sendOverageReminderEmail(params, "J30");
}

async function sendOverageReminderEmail(
  params: OverageReminderEmailParams,
  variant: "J7" | "J30",
): Promise<void> {
  const subject =
    variant === "J7"
      ? "Vos ressources Physalis vous attendent"
      : "Dernière relance — vos données sont toujours là";
  const lead =
    variant === "J7"
      ? `Cela fait une semaine que votre compte ${params.clientName} est en overage sur le plan FREE.`
      : `Cela fait un mois que votre compte ${params.clientName} est en overage sur le plan FREE.`;
  // Variante HTML : `clientName` est choisi par le client, donc à échapper.
  const leadH =
    variant === "J7"
      ? `Cela fait une semaine que votre compte ${esc(params.clientName)} est en overage sur le plan FREE.`
      : `Cela fait un mois que votre compte ${esc(params.clientName)} est en overage sur le plan FREE.`;

  const text = [
    `Bonjour,`,
    ``,
    lead,
    ``,
    `Vos ressources actuelles :`,
    `• ${params.orgsCount} organisation${params.orgsCount > 1 ? "s" : ""}`,
    `• ${params.usersCount} utilisateur${params.usersCount > 1 ? "s" : ""}`,
    ``,
    `Toutes vos données sont conservées et restent accessibles. Cependant :`,
    `  • Vous ne pouvez pas créer de nouvelles ressources.`,
    `  • Les déploiements automatiques sont désactivés sur les organisations excédentaires.`,
    ``,
    `Pour tout réactiver instantanément, re-souscrivez un plan payant :`,
    params.accountUrl,
    ``,
    `À très vite,`,
    `L'équipe Physalis`,
  ].join("\n");

  const html = renderEmail({
    title: subject,
    bodyHtml:
      p(leadH) +
      panel(
        `<strong>Vos ressources actuelles :</strong><br>` +
        `• ${params.orgsCount} organisation${params.orgsCount > 1 ? "s" : ""}<br>` +
        `• ${params.usersCount} utilisateur${params.usersCount > 1 ? "s" : ""}`,
      ) +
      p(`Tout est conservé en l'état, rien n'est supprimé.`),
    cta: { label: "Gérer mon abonnement", url: params.accountUrl },
  }, "fr");

  await sendEmail({
    to: params.to,
    subject: `${subject} — ${params.clientName}`,
    text,
    html,
  });
}