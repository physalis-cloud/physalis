#!/usr/bin/env node
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

function slugify(input) {
  return input
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

async function uniqueOrgSlug(candidate) {
  const base = slugify(candidate) || "org";
  let slug = base;
  let n = 2;
  while (await prisma.organization.findUnique({ where: { slug } })) {
    slug = `${base}-${n}`;
    n += 1;
    if (n > 50) {
      slug = `${base}-${Date.now().toString(36)}`;
      break;
    }
  }
  return slug;
}

async function main() {
  const email = (process.env.ADMIN_EMAIL ?? "").toLowerCase().trim();
  const password = process.env.ADMIN_PASSWORD ?? "";

  if (!email || !password) {
    console.log(
      "[bootstrap-admin] ADMIN_EMAIL or ADMIN_PASSWORD not set — skipping.",
    );
    return;
  }

  // Phase 2.1 — auto-promote en SUPERADMIN si l'user existe deja avec un
  // role plus faible. Idempotent : si deja SUPERADMIN, no-op silencieux.
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    if (existing.role !== "SUPERADMIN") {
      await prisma.user.update({
        where: { id: existing.id },
        data: { role: "SUPERADMIN" },
      });
      console.log(
        `[bootstrap-admin] Promoted ${email} from ${existing.role} to SUPERADMIN.`,
      );
    }
    return;
  }

  // Pas d'user avec ce mail. On ne cree un nouvel admin QUE si la table
  // est entierement vide (premier demarrage). Sinon on pourrait creer
  // accidentellement un compte parallele si un admin precedent a ete
  // supprime / renomme.
  const userCount = await prisma.user.count();
  if (userCount > 0) {
    console.log(
      `[bootstrap-admin] Users exist but none with ${email} — skipping (manual creation required).`,
    );
    return;
  }

  if (password.length < 12) {
    console.error(
      "[bootstrap-admin] ADMIN_PASSWORD must be at least 12 characters.",
    );
    process.exit(1);
  }

  const hash = await bcrypt.hash(password, 12);
  const user = await prisma.user.create({
    data: { email, password: hash, role: "SUPERADMIN" },
  });

  const handle = email.split("@")[0] || "org";
  const orgSlug = await uniqueOrgSlug(handle);
  // Première org de l'instance = org principale (nom du compte affiché sur
  // /account, protégée contre la suppression). Conditionné pour rester
  // idempotent si le bootstrap est rejoué sur une base déjà peuplée.
  const hasPrimary =
    (await prisma.organization.count({ where: { isPrimary: true } })) > 0;
  await prisma.organization.create({
    data: {
      name: `${handle}'s organization`,
      slug: orgSlug,
      isPrimary: !hasPrimary,
      members: { create: { userId: user.id, role: "OWNER" } },
    },
  });

  console.log(
    `[bootstrap-admin] Superadmin user created: ${email} (org: ${orgSlug}).`,
  );
}

main()
  .catch((err) => {
    console.error("[bootstrap-admin] Error:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
