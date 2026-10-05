// /account/cli — approbation d'une connexion `physalis login` (C-0050, phase 2).
//
// La CLI affiche un code et ouvre cette page avec `?code=` pré-rempli. Sous
// /account : le middleware SaaS la protège (redirection vers le login avec
// retour ici) et vérifie que le tenant de la session est celui de l'hôte.

import { RiTerminalBoxLine } from "@remixicon/react";
import { getTranslations } from "next-intl/server";
import PageHero from "@/components/PageHero";
import CliApproval from "./cli-approval";

export default async function CliApprovalPage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string }>;
}) {
  const { code } = await searchParams;
  const t = await getTranslations("cliDevice");
  return (
    <div className="page">
      <div className="page-content">
        <PageHero
          icon={<RiTerminalBoxLine size={28} aria-hidden />}
          title={t("title")}
          subtitle={t("subtitle")}
        />
        <CliApproval initialCode={typeof code === "string" ? code.slice(0, 20) : ""} />
      </div>
    </div>
  );
}
