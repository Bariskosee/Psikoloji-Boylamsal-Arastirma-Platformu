import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";

/**
 * Phase 0 health page.
 *
 * The real dashboard — login, study list, builders, monitoring — arrives from
 * Phase 2 onward.
 */
export default async function ResearcherHealthPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("health");

  return (
    <>
      <h1>{t("researcherApp")}</h1>
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
