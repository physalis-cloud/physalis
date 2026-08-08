// GET /api/secret-requests/vault-target?project=<slug>
//
// Préflight du dialogue de création d'une demande externe : l'appelant
// peut-il, sur CE projet, se passer d'une cible d'environnement ?
//
// Une demande créée avec un projet mais sans environnement ni clé .env est
// importée dans le coffre du PROJET. Or ce repli n'est pas toujours ouvert :
//   - il exige EDITOR sur le projet (pas seulement l'accès en lecture) ;
//   - le coffre d'équipe est une fonctionnalité gatée par plan côté SaaS.
// `requireProjectScope` porte les deux règles — on ne les redérive pas ici.
//
// Pourquoi un préflight plutôt qu'un refus à l'import : la modale de création
// ANNONCE la destination (« le secret sera enregistré dans le coffre du
// projet »). Une promesse vérifiée seulement au moment de l'import déplacerait
// l'impasse dans le temps au lieu de la supprimer — l'utilisateur ne
// découvrirait le refus qu'au retour du tiers, la demande étant alors déjà
// consommée et non réimportable ailleurs.
//
// Réponse toujours 200 pour un appelant authentifié : `available: false` n'est
// pas une erreur, c'est la réponse à la question posée. Le dialogue s'en sert
// pour exiger environnement + clé au lieu de proposer le repli.

import { NextResponse } from "next/server";
import { requireUser } from "@/lib/api";
import { requireProjectScope } from "@/lib/vault-access";
import { IMPORT_COLLECTION_NAME } from "@/lib/secret-request";

export async function GET(req: Request) {
  const userRes = await requireUser();
  if ("error" in userRes) return userRes.error;

  const projectSlug = new URL(req.url).searchParams.get("project");
  if (!projectSlug) {
    return NextResponse.json({ error: "project is required" }, { status: 400 });
  }

  // EDITOR : écrire dans le coffre d'un projet est une écriture projet, au même
  // titre qu'écrire un secret d'environnement. `feature` est le gate de plan
  // (no-op en self-host, où il n'y a ni plans ni tenants).
  const scope = await requireProjectScope(projectSlug, "EDITOR", {
    feature: "team_vault",
  });

  // Toute erreur — projet inconnu, rôle insuffisant, plan sans coffre d'équipe —
  // se traduit par la même réponse. On ne distingue pas : `requireProjectScope`
  // répond déjà 404 sur un projet inaccessible pour ne pas en révéler
  // l'existence, et ce préflight ne doit pas rouvrir ce canal.
  if ("error" in scope) {
    return NextResponse.json({ available: false });
  }

  return NextResponse.json({
    available: true,
    collectionName: IMPORT_COLLECTION_NAME,
  });
}
