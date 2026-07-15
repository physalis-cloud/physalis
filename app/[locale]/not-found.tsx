import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { ErrorScreen } from "@/components/error-screen";
import { BackButton } from "@/components/back-button";
import { HomeIcon } from "@/components/error-icons";

export default async function NotFound() {
  const t = await getTranslations("errors");
  return (
    <ErrorScreen
      variant="notFound"
      tagline={t("tagline")}
      eyebrow={t("notFound.eyebrow")}
      title={t("notFound.title")}
      text={t("notFound.text")}
    >
      <Link className="btn btn-primary" href="/dashboard">
        <HomeIcon />
        {t("backToDashboard")}
      </Link>
      <BackButton label={t("back")} />
    </ErrorScreen>
  );
}
