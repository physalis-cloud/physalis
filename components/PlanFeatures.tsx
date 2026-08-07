"use client";

// Source UNIQUE des fonctionnalités du plan côté interface.
//
// Le layout dashboard charge déjà le client tenant (plan + comped) pour ses
// bandeaux : il en dérive la liste des features UNE fois et la descend ici.
// Aucun composant ne doit re-dériver un `plan === "FREE"` dans son coin — il en
// existait 4 variantes divergentes avant ce chantier, et c'est exactement ce
// qui a laissé les onglets Membres / Serveurs / CI/CD ouverts au plan gratuit
// pendant que l'API les refusait.
//
// ⚠️ Le masquage n'est PAS une protection : il évite qu'un utilisateur remplisse
// un formulaire pour se prendre une 403. La barrière réelle est côté serveur
// (`opts.feature` sur requireOrgMember / requireProjectMember).

import { createContext, useContext, type ReactNode } from "react";

const PlanFeaturesContext = createContext<ReadonlySet<string> | null>(null);

export function PlanFeaturesProvider({
  features,
  children,
}: {
  /** Sérialisée en tableau : un Set ne traverse pas la frontière serveur→client. */
  features: string[];
  children: ReactNode;
}) {
  return (
    <PlanFeaturesContext.Provider value={new Set(features)}>
      {children}
    </PlanFeaturesContext.Provider>
  );
}

/**
 * Le plan courant couvre-t-il cette fonctionnalité ?
 *
 * Hors provider (pages publiques, self-host mono-tenant où le layout ne fournit
 * rien), renvoie `true` : l'absence de contexte ne doit jamais masquer une
 * fonctionnalité — le refus, lui, viendra du serveur s'il doit venir.
 */
export function useFeature(feature: string): boolean {
  const features = useContext(PlanFeaturesContext);
  if (!features) return true;
  return features.has(feature);
}
