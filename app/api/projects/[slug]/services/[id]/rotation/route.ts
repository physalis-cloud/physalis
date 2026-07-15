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

// Rotation REMINDER d'un Service (credential `{ user, password }` chiffré dans
// encryptedData). Stratégie implicite = REMINDER : aucune application à la
// source. GET/PATCH = config (activer + intervalle) ; POST = rotation assistée
// (générer/saisir le nouveau mdp côté UI + confirmation bloquante) → ré-encrypt
// du blob avec le même user, snapshot de l'ancien dans rotationHistory (cap 3).

export async function GET(_req: Request, { params }: Params) {
  const { slug, id } = await params;
  const access = await requireProjectMember(slug);
  if ("error" in access) return access.error;

  const service = await prisma.service.findFirst({
    where: { id, projectId: access.project.id },
    select: {
      rotationEnabled: true,
      rotationIntervalDays: true,
      rotationLastAt: true,
      rotationNextAt: true,
      rotationLastStatus: true,
      rotationHistory: true,
    },
  });
  if (!service) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const history = Array.isArray(service.rotationHistory) ? service.rotationHistory : [];
  return NextResponse.json({
    rotation: {
      rotationEnabled: service.rotationEnabled,
      rotationIntervalDays: service.rotationIntervalDays,
      rotationLastAt: service.rotationLastAt,
      rotationNextAt: service.rotationNextAt,
      rotationLastStatus: service.rotationLastStatus,
      historyCount: history.length,
    },
  });
}

export async function PATCH(req: Request, { params }: Params) {
  const { slug, id } = await params;
  const access = await requireProjectMember(slug, "EDITOR");
  if ("error" in access) return access.error;

  const service = await prisma.service.findFirst({
    where: { id, projectId: access.project.id },
    select: { id: true, name: true, rotationLastAt: true },
  });
  if (!service) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = (await readJson(req)) as
    | { rotationEnabled?: boolean; rotationIntervalDays?: number | null }
    | null;
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const enabled = Boolean(body.rotationEnabled);
  const intervalDays =
    enabled && body.rotationIntervalDays ? Number(body.rotationIntervalDays) : null;
  if (enabled && (!intervalDays || intervalDays < 1 || intervalDays > 3650)) {
    return NextResponse.json({ error: "Intervalle invalide (1–3650 jours)." }, { status: 400 });
  }

  // À l'activation, l'échéance court depuis la dernière rotation connue, sinon maintenant.
  const base = service.rotationLastAt ?? new Date();
  const nextAt = enabled ? computeReminderNextAt(intervalDays, base) : null;

  await prisma.service.update({
    where: { id: service.id },
    data: {
      rotationEnabled: enabled,
      rotationIntervalDays: intervalDays,
      rotationNextAt: nextAt,
    },
    select: { id: true },
  });

  logAction({
    action: "SERVICE_UPDATE",
    actor: { kind: "user", userId: access.user.id, email: access.user.email },
    organizationId: access.project.organizationId,
    projectId: access.project.id,
    targetType: "Service",
    targetId: service.id,
    metadata: { changedFields: ["rotationConfig"], rotationEnabled: enabled },
    req,
  });

  return NextResponse.json({ ok: true });
}

// POST — rotation assistée. Body { newPassword? } : si fourni, ré-encrypt
// { user (inchangé), newPassword } + snapshot de l'ancien blob dans l'historique
// (cap 3). Sans newPassword = marquer comme roté (bump des échéances seul).
export async function POST(req: Request, { params }: Params) {
  const { slug, id } = await params;
  const access = await requireProjectMember(slug, "EDITOR");
  if ("error" in access) return access.error;

  const service = await prisma.service.findFirst({
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
  if (!service) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = (await readJson(req).catch(() => null)) as { newPassword?: string } | null;
  const newPassword =
    body && typeof body.newPassword === "string" && body.newPassword !== ""
      ? body.newPassword
      : null;

  const now = new Date();
  const nextAt = computeReminderNextAt(service.rotationIntervalDays, now);

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
    // Conserve le user existant, remplace le mot de passe.
    const json = decrypt({ encryptedValue: service.encryptedData, iv: service.iv, tag: service.tag });
    const parsed = JSON.parse(json) as { user?: string };
    const payload = encrypt(JSON.stringify({ user: parsed.user ?? "", password: newPassword }));
    data.rotationHistory = pushRotationHistory(service.rotationHistory, {
      encryptedValue: service.encryptedData,
      iv: service.iv,
      tag: service.tag,
      rotatedAt: now.toISOString(),
    });
    data.encryptedData = payload.encryptedValue;
    data.iv = payload.iv;
    data.tag = payload.tag;
  }

  await prisma.service.update({ where: { id: service.id }, data, select: { id: true } });

  logAction({
    action: "SERVICE_UPDATE",
    actor: { kind: "user", userId: access.user.id, email: access.user.email },
    organizationId: access.project.organizationId,
    projectId: access.project.id,
    targetType: "Service",
    targetId: service.id,
    metadata: { changedFields: ["rotation"], valueUpdated: Boolean(newPassword) },
    req,
  });

  return NextResponse.json({ ok: true, valueUpdated: Boolean(newPassword) });
}
