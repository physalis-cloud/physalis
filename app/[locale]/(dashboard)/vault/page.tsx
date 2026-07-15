import { Link } from "@/i18n/navigation";
import { RiSafe2Line } from "@remixicon/react";
import { auth } from "@/lib/auth";
import { getTranslations } from "next-intl/server";
import PageHero from "@/components/PageHero";
import VaultPanel from "./vault-panel";

export default async function VaultPage() {
  const session = await auth();
  if (!session?.user?.id) return null;
  const t = await getTranslations("vault");

  return (
    <VaultPanel>
      <div className="breadcrumb">
        <Link href="/dashboard">← Tableau de bord</Link>
      </div>
      <PageHero
        icon={<RiSafe2Line size={28} aria-hidden />}
        title={t("pageTitle")}
        subtitle={t("pageSubtitle")}
      />
    </VaultPanel>
  );
}
