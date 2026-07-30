// Jumeau SELF-HOST — divergence unique : le portail de feature payante
// (`requireFeature("rotation")`, lib/feature-guard) est retiré. La rotation À LA
// DEMANDE est une feature PRODUIT en self-host, pas une option d'offre : il n'y a
// ni plan ni `admin.clients` pour porter le drapeau. Les gardes d'autorisation
// (requireProjectMember EDITOR) et le reste du handler sont identiques.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { decrypt, encrypt } from "@/lib/crypto";
import { readJson, requireProjectMember } from "@/lib/api";
import { logAction } from "@/lib/audit";
import {
  computeReminderNextAt,
  pushRotationHistory,
  type RotationHistoryEntry,
} from "@/lib/rotation-reminder";

type Params = { params: Promise<{ slug: string; id: string }> };

// Rotation REMINDER d'un AppAccount (compte de test/login : `{ user, password }`
// chiffré dans encryptedData). Identique au Service — cf. ce fichier pour la doc.

export async function GET(_req: Request, { params }: Params) {
  const { slug, id } = await params;
  const access = await requireProjectMember(slug);
  if ("error" in access) return access.error;

  const account = await prisma.appAccount.findFirst({
    where: { id, projectId: access.project.id },
    select: {
      rotationEnabled: true,
      rotationIntervalDays: true,
      rotationLastAt: true,
      rotationNextAt: true,
      rotationLastStatus: true,
      rotationHistory: true,
      rotationStrategy: true,
      rotationDbTarget: true,
      // Le hook ET la cible DB vivent sur le service backend lié → on expose
      // juste leur présence (prérequis WEBHOOK / DATABASE).
      service: { select: { rotationWebhookUrl: true, dbType: true, dbHost: true } },
    },
  });
  if (!account) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const history = Array.isArray(account.rotationHistory) ? account.rotationHistory : [];
  return NextResponse.json({
    rotation: {
      rotationEnabled: account.rotationEnabled,
      rotationIntervalDays: account.rotationIntervalDays,
      rotationLastAt: account.rotationLastAt,
      rotationNextAt: account.rotationNextAt,
      rotationLastStatus: account.rotationLastStatus,
      historyCount: history.length,
      rotationStrategy: account.rotationStrategy,
      // DATABASE : cible "role" (défaut) ou "supabase_auth".
      rotationDbTarget: account.rotationDbTarget ?? "role",
      // True si le service lié a un hook configuré (prérequis WEBHOOK).
      serviceHasHook: Boolean(account.service?.rotationWebhookUrl),
      // True si le service lié a une cible base de données (prérequis DATABASE).
      serviceHasDb: Boolean(account.service?.dbType && account.service?.dbHost),
    },
  });
}

export async function PATCH(req: Request, { params }: Params) {
  const { slug, id } = await params;
  const access = await requireProjectMember(slug, "EDITOR");
  if ("error" in access) return access.error;

  const account = await prisma.appAccount.findFirst({
    where: { id, projectId: access.project.id },
    select: {
      id: true,
      name: true,
      rotationLastAt: true,
      // Le hook ET la cible DB vivent sur le service backend lié.
      service: { select: { rotationWebhookUrl: true, dbType: true, dbHost: true } },
    },
  });
  if (!account) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = (await readJson(req)) as
    | {
        rotationEnabled?: boolean;
        rotationIntervalDays?: number | null;
        rotationStrategy?: string | null;
        rotationDbTarget?: string | null;
      }
    | null;
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  const dbTarget = body.rotationDbTarget === "supabase_auth" ? "supabase_auth" : "role";

  const enabled = Boolean(body.rotationEnabled);
  const intervalDays =
    enabled && body.rotationIntervalDays ? Number(body.rotationIntervalDays) : null;
  if (enabled && (!intervalDays || intervalDays < 1 || intervalDays > 3650)) {
    return NextResponse.json({ error: "Intervalle invalide (1–3650 jours)." }, { status: 400 });
  }

  // Stratégie : null/"REMINDER" (défaut), "WEBHOOK" (hook côté app) ou "DATABASE"
  // (rôle Postgres d'une DB managée). Le hook ET la cible DB sont portés par le
  // SERVICE backend lié → le compte DOIT être lié à un service correctement
  // configuré pour la stratégie choisie.
  let rotationStrategy: "REMINDER" | "WEBHOOK" | "DATABASE" = "REMINDER";
  if (enabled && body.rotationStrategy === "WEBHOOK") {
    if (!account.service?.rotationWebhookUrl) {
      return NextResponse.json(
        { error: "Lie le compte à un service backend avec un hook configuré (le hook se règle sur le service)." },
        { status: 400 },
      );
    }
    rotationStrategy = "WEBHOOK";
  } else if (enabled && body.rotationStrategy === "DATABASE") {
    if (!account.service?.dbType || !account.service?.dbHost) {
      return NextResponse.json(
        { error: "Lie le compte à un service backend ayant une cible base de données configurée (host/type sur le service)." },
        { status: 400 },
      );
    }
    rotationStrategy = "DATABASE";
  }

  const base = account.rotationLastAt ?? new Date();
  const nextAt = enabled ? computeReminderNextAt(intervalDays, base) : null;

  await prisma.appAccount.update({
    where: { id: account.id },
    data: {
      rotationEnabled: enabled,
      rotationIntervalDays: intervalDays,
      rotationNextAt: nextAt,
      rotationStrategy,
      rotationDbTarget: rotationStrategy === "DATABASE" ? dbTarget : null,
    },
    select: { id: true },
  });

  logAction({
    action: "ACCOUNT_UPDATE",
    actor: { kind: "user", userId: access.user.id, email: access.user.email },
    organizationId: access.project.organizationId,
    projectId: access.project.id,
    targetType: "AppAccount",
    targetId: account.id,
    metadata: { changedFields: ["rotationConfig"], rotationEnabled: enabled },
    req,
  });

  return NextResponse.json({ ok: true });
}

export async function POST(req: Request, { params }: Params) {
  const { slug, id } = await params;
  const access = await requireProjectMember(slug, "EDITOR");
  if ("error" in access) return access.error;

  const account = await prisma.appAccount.findFirst({
    where: { id, projectId: access.project.id },
    select: {
      id: true,
      name: true,
      encryptedData: true,
      iv: true,
      tag: true,
      rotationIntervalDays: true,
      rotationHistory: true,
    },
  });
  if (!account) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = (await readJson(req).catch(() => null)) as { newPassword?: string } | null;
  const newPassword =
    body && typeof body.newPassword === "string" && body.newPassword !== ""
      ? body.newPassword
      : null;

  const now = new Date();
  const nextAt = computeReminderNextAt(account.rotationIntervalDays, now);

  const data: {
    rotationLastAt: Date;
    rotationNextAt: Date | null;
    rotationLastStatus: null;
    encryptedData?: string;
    iv?: string;
    tag?: string;
    rotationHistory?: RotationHistoryEntry[];
  } = { rotationLastAt: now, rotationNextAt: nextAt, rotationLastStatus: null };

  if (newPassword) {
    const json = decrypt({ encryptedValue: account.encryptedData, iv: account.iv, tag: account.tag });
    const parsed = JSON.parse(json) as { user?: string };
    const payload = encrypt(JSON.stringify({ user: parsed.user ?? "", password: newPassword }));
    data.rotationHistory = pushRotationHistory(account.rotationHistory, {
      encryptedValue: account.encryptedData,
      iv: account.iv,
      tag: account.tag,
      rotatedAt: now.toISOString(),
    });
    data.encryptedData = payload.encryptedValue;
    data.iv = payload.iv;
    data.tag = payload.tag;
  }

  await prisma.appAccount.update({ where: { id: account.id }, data, select: { id: true } });

  logAction({
    action: "ACCOUNT_UPDATE",
    actor: { kind: "user", userId: access.user.id, email: access.user.email },
    organizationId: access.project.organizationId,
    projectId: access.project.id,
    targetType: "AppAccount",
    targetId: account.id,
    metadata: { changedFields: ["rotation"], valueUpdated: Boolean(newPassword) },
    req,
  });

  return NextResponse.json({ ok: true, valueUpdated: Boolean(newPassword) });
}
