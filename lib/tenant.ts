// Stub self-host : pas de schéma per-tenant, withTenantSchema dégénère
// en simple transaction prisma.

import type { Prisma as PrismaTypes } from "@prisma/client";
import { prisma } from "./prisma";

export type TenantTransaction = PrismaTypes.TransactionClient;

export async function withTenantSchema<T>(
  _slug: string | null,
  fn: (tx: TenantTransaction) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(fn);
}
