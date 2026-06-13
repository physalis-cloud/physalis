import Link from "next/link";
import Image from "next/image";
import { getTranslations } from "next-intl/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { hashInvitationToken } from "@/lib/invitations";
import AcceptInvitationButton from "./accept-button";
import InvitationRegisterForm from "./register-form";

export default async function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const t = await getTranslations("invite");

  const invitation = await prisma.invitation.findUnique({
    where: { tokenHash: hashInvitationToken(token) },
    include: {
      organization: { select: { name: true, slug: true } },
      invitedBy: { select: { email: true } },
    },
  });

  const session = await auth();

  if (
    !invitation ||
    invitation.acceptedAt ||
    invitation.expiresAt <= new Date()
  ) {
    return (
      <div className="login-wrap">
        <div className="login-card">
          <div className="login-brand">
            <Image
              src="/icon-128.png"
              alt="Physalis"
              width={64}
              height={64}
              className="login-brand-icon"
              priority
            />
            <div className="login-brand-text">
              <div className="login-brand-name">Physalis</div>
              <div className="login-brand-tag">{t("tagInvalid")}</div>
            </div>
          </div>
          <p className="help" style={{ textAlign: "center" }}>
            {invitation?.acceptedAt
              ? t("errors.alreadyAccepted")
              : invitation
                ? t("errors.expired")
                : t("errors.notFound")}
          </p>
          <Link
            href="/dashboard"
            className="btn btn-ghost btn-sm"
            style={{ alignSelf: "center" }}
          >
            {t("back")}
          </Link>
        </div>
      </div>
    );
  }

  if (!session?.user?.email) {
    const existingUser = await prisma.user.findUnique({
      where: { email: invitation.email },
      select: { id: true },
    });

    if (!existingUser) {
      return (
        <div className="login-wrap">
          <div className="login-card">
            <div className="login-brand">
              <Image
                src="/icon-128.png"
                alt="Physalis"
                width={64}
                height={64}
                className="login-brand-icon"
                priority
              />
              <div className="login-brand-text">
                <div className="login-brand-name">Physalis</div>
                <div className="login-brand-tag">{t("tag")}</div>
              </div>
            </div>
            <InvitationRegisterForm
              token={token}
              email={invitation.email}
              organizationName={invitation.organization.name}
              organizationSlug={invitation.organization.slug}
              inviterEmail={invitation.invitedBy.email}
              role={invitation.role}
            />
          </div>
        </div>
      );
    }

    const callback = `/invite/${token}`;
    return (
      <div className="login-wrap">
        <div className="login-card">
          <div className="login-brand">
            <Image
              src="/icon-128.png"
              alt="Physalis"
              width={64}
              height={64}
              className="login-brand-icon"
              priority
            />
            <div className="login-brand-text">
              <div className="login-brand-name">Physalis</div>
              <div className="login-brand-tag">{t("tag")}</div>
            </div>
          </div>
          <p className="help" style={{ textAlign: "center" }}>
            {t.rich("invitationLine", {
              inviter: invitation.invitedBy.email,
              organization: invitation.organization.name,
              role: invitation.role,
              strong: (c) => <strong>{c}</strong>,
              rolebadge: (c) => (
                <span className={`role role-${invitation.role.toLowerCase()}`}>
                  {c}
                </span>
              ),
            })}
          </p>
          <p className="help" style={{ textAlign: "center" }}>
            {t.rich("signInToAccept", {
              email: invitation.email,
              strong: (c) => <strong>{c}</strong>,
            })}
          </p>
          <Link
            href={`/login?callbackUrl=${encodeURIComponent(callback)}`}
            className="btn btn-primary"
            style={{
              marginTop: 6,
              padding: "11px 16px",
              justifyContent: "center",
            }}
          >
            {t("signIn")}
          </Link>
        </div>
      </div>
    );
  }

  const emailMismatch =
    session.user.email.toLowerCase() !== invitation.email.toLowerCase();

  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="login-brand">
          <Image
            src="/icon-128.png"
            alt="Physalis"
            width={64}
            height={64}
            className="login-brand-icon"
            priority
          />
          <div className="login-brand-text">
            <div className="login-brand-name">Physalis</div>
            <div className="login-brand-tag">{t("tag")}</div>
          </div>
        </div>
        <p className="help" style={{ textAlign: "center" }}>
          {t.rich("invitationLine", {
            inviter: invitation.invitedBy.email,
            organization: invitation.organization.name,
            role: invitation.role,
            strong: (c) => <strong>{c}</strong>,
            rolebadge: (c) => (
              <span className={`role role-${invitation.role.toLowerCase()}`}>
                {c}
              </span>
            ),
          })}
        </p>

        {emailMismatch ? (
          <div
            className="help"
            style={{
              padding: 12,
              borderRadius: 10,
              border: "1px solid var(--border)",
              background: "var(--accent-bg)",
              color: "var(--fg)",
            }}
          >
            {t.rich("emailMismatch", {
              invitedEmail: invitation.email,
              currentEmail: session.user.email,
              strong: (c) => <strong>{c}</strong>,
              br: () => <br />,
            })}
          </div>
        ) : (
          <AcceptInvitationButton
            token={token}
            orgSlug={invitation.organization.slug}
          />
        )}
      </div>
    </div>
  );
}
