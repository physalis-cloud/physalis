// /api/public/secret-requests/[token]/public
//
// Endpoint public (sans authentification). Retourne les metadata de la
// demande pour permettre au tiers d'afficher le formulaire `/request/[token]`.
//
// Anti-leak : 404 générique si invalide / expirée / révoquée / déjà soumise.
// Pas de distinction entre "n'existe pas" et "expiré" pour ne pas leak
// l'existence du token à un attaquant.
//
// Jumeau SELF-HOST. La version SaaS résout d'abord le tenant propriétaire du
// token via `admin.token_index`, puis interroge `"client_<slug>"."SecretRequest"`
// en SQL brut — deux choses qui n'ont pas de sens en mono-tenant, et qui
// rendaient l'endpoint MORT : rien n'alimente `TokenIndex` dans le build, donc
// la résolution renvoyait toujours null et tout lien de demande externe était
// un 404 permanent. Ici il n'y a qu'un schéma et `tokenHash` est unique : on
// lit la ligne directement avec le client Prisma, sans SQL brut ni
// qualification de schéma.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  hashSecretRequestToken,
  isSecretRequestTokenFormat,
} from "@/lib/secret-request";

type Params = { params: Promise<{ token: string }> };

const NOT_FOUND = NextResponse.json({ error: "Not found" }, { status: 404 });

export async function GET(_req: Request, { params }: Params) {
  const { token } = await params;
  if (!isSecretRequestTokenFormat(token)) return NOT_FOUND;

  const sr = await prisma.secretRequest.findUnique({
    where: { tokenHash: hashSecretRequestToken(token) },
    select: {
      label: true,
      description: true,
      requestedByEmail: true,
      publicKeyJwk: true,
      submittedAt: true,
      revokedAt: true,
      expiresAt: true,
    },
  });
  if (!sr) return NOT_FOUND;
  // Même 404 indifférencié que la source : révoquée, déjà soumise et expirée
  // ne se distinguent pas de « n'existe pas ».
  if (sr.revokedAt || sr.submittedAt || sr.expiresAt <= new Date()) {
    return NOT_FOUND;
  }

  return NextResponse.json({
    label: sr.label,
    description: sr.description,
    requestedByEmail: sr.requestedByEmail,
    publicKeyJwk: sr.publicKeyJwk,
    expiresAt: sr.expiresAt,
  });
}
