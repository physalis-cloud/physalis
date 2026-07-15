import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { ErrorScreen } from "@/components/error-screen";
import { HomeIcon, LoginIcon } from "@/components/error-icons";

// Page 403 réutilisable : cible de redirection quand l'accès à une ressource
// est refusé (droits insuffisants) sans vouloir masquer son existence par un 404.
export default async function Forbidden() {
  const t = await getTranslations("errors");
  return (
    <ErrorScreen
      variant="forbidden"
      tagline={t("tagline")}
      eyebrow={t("forbidden.eyebrow")}
      title={t("forbidden.title")}
      text={t("forbidden.text")}
    >
      <Link className="btn btn-primary" href="/dashboard">
        <HomeIcon />
        {t("backToDashboard")}
      </Link>
      <Link className="btn btn-ghost" href="/login">
        <LoginIcon />
        {t("forbidden.reconnect")}
      </Link>
    </ErrorScreen>
  );
}
