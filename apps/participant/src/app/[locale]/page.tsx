import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";

/**
 * Phase 0 health page.
 *
 * Its only job is to prove the application boots and renders in both locales.
 * The real participant flow — join, consent, status, session runtime — arrives
 * in Phases 5 and 6.
 */
export default async function ParticipantHealthPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("health");

  return (
    <>
      <h1>{t("participantApp")}</h1>
      <p>
        <strong>{t("operational")}</strong>
      </p>
      <p>{t("phase")}</p>
      <p>
        <Link href="/" locale={locale === "en" ? "tr" : "en"}>
          {t("switchLanguage")}
        </Link>
      </p>
    </>
  );
}
