import { notFound } from "next/navigation";

// Catch-all de plus basse priorité : toute route inconnue sous /{locale}/…
// tombe ici et déclenche la page 404 localisée (app/[locale]/not-found.tsx).
// Nécessaire avec next-intl (localePrefix "always") pour que le not-found
// résolve bien la locale depuis l'URL.
export default function CatchAll() {
  notFound();
}
