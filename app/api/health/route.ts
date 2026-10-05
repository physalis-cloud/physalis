// GET /api/health
//
// Endpoint de monitoring sans authentification. Utilisé par :
//   - check-primary.sh sur le secondaire (sonde toutes les minutes)
//   - secretvault-failover.sh (vérification post-bascule)
//   - healthchecks.io (optionnel)
//
// Retourne 200 si la DB répond, 503 sinon.

import { NextResponse } from "next/server";
import { basePrisma } from "@/lib/prisma";

export async function GET() {
  const start = Date.now();
  let dbStatus: "ok" | "error" = "ok";
  let dbLatencyMs: number | null = null;

  try {
    const dbStart = Date.now();
    await basePrisma.$queryRaw`SELECT 1`;
    dbLatencyMs = Date.now() - dbStart;
  } catch {
    dbStatus = "error";
  }

  const totalMs = Date.now() - start;
  const isOk = dbStatus === "ok";

  return NextResponse.json(
    {
      status: isOk ? "ok" : "degraded",
      db: dbStatus,
      db_latency_ms: dbLatencyMs,
      total_ms: totalMs,
      // `||` et non `??` : APP_VERSION est posée par le Dockerfile, donc
      // TOUJOURS définie dans un conteneur. Une valeur vide (ARG non passé,
      // ligne `APP_VERSION=` dans un .env) passerait à travers `??` et
      // s'afficherait comme `"version": ""` — moins lisible qu'un aveu.
      version: process.env.APP_VERSION || "unknown",
      ts: new Date().toISOString(),
    },
    { status: isOk ? 200 : 503 },
  );
}
