import { headers } from "next/headers";
import Image from "next/image";
import { getTranslations } from "next-intl/server";
import RequestForm from "./request-form";
import {
  hashSecretRequestToken,
  isSecretRequestTokenFormat,
} from "@/lib/secret-request";
import { prisma } from "@/lib/prisma";

// Jumeau SELF-HOST : la version SaaS résout d'abord le tenant propriétaire du
// token via `admin.token_index`, puis lit `"client_<slug>"."SecretRequest"` en
// SQL brut. Rien n'alimente cette table dans le build → la page renvoyait un
// 404 pour TOUTE demande externe. En mono-tenant, `tokenHash` est unique et il
// n'y a qu'un schéma : on lit la ligne directement.

export async function generateMetadata() {
  const t = await getTranslations("secretRequest");
  return { title: t("metaTitle") };
}

type RequestData = {
  label: string;
  description: string | null;
  requestedByEmail: string;
  publicKeyJwk: string;
  expiresAt: Date;
};

async function loadRequest(token: string): Promise<RequestData | null> {
  if (!isSecretRequestTokenFormat(token)) return null;

  return prisma.secretRequest.findFirst({
    where: {
      tokenHash: hashSecretRequestToken(token),
      revokedAt: null,
      submittedAt: null,
      expiresAt: { gt: new Date() },
    },
    select: {
      label: true,
      description: true,
      requestedByEmail: true,
      publicKeyJwk: true,
      expiresAt: true,
    },
  });
}

export default async function RequestPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const t = await getTranslations("secretRequest");
  // headers() touché avant le query pour rester en dynamic rendering.
  await headers();
  const data = await loadRequest(token);

  if (!data) {
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
            {t("linkInvalid")}
          </p>
        </div>
      </div>
    );
  }

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
        <RequestForm
          token={token}
          label={data.label}
          description={data.description}
          requestedByEmail={data.requestedByEmail}
          publicKeyJwk={data.publicKeyJwk}
          expiresAt={data.expiresAt.toISOString()}
        />
      </div>
    </div>
  );
}
