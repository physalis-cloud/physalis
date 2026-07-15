import { NextResponse } from "next/server";
import { resolveDocSlug } from "@/lib/docs";
import { resolveTutoSlug } from "@/lib/tutos";

// Remap d'un slug vers son équivalent dans une autre langue (docs/tutos). Utilisé
// par le sélecteur de langue pour ne pas tomber en 404 : les pages docs/tutos ont
// des slugs localisés (`premiers-pas` ↔ `getting-started`). `slug: null` → la
// page n'existe pas dans la langue cible (le switcher retombe sur la liste).
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const type = searchParams.get("type");
  const slug = searchParams.get("slug");
  const from = searchParams.get("from");
  const to = searchParams.get("to");

  if (!slug || !from || !to || (type !== "docs" && type !== "tutos")) {
    return NextResponse.json({ slug: null }, { status: 400 });
  }

  try {
    const resolved =
      type === "docs"
        ? await resolveDocSlug(slug, from, to)
        : await resolveTutoSlug(slug, from, to);
    return NextResponse.json({ slug: resolved });
  } catch {
    return NextResponse.json({ slug: null });
  }
}
