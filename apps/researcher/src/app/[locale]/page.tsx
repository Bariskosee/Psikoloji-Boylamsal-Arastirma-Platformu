import { redirect } from "next/navigation";
import { setRequestLocale } from "next-intl/server";

/**
 * The dashboard root.
 *
 * Redirects to the study list, which is the only screen a signed-in researcher
 * ever wants first. The list itself redirects to /login when the session has
 * expired — that decision belongs on the client, where the API's answer is
 * known, rather than here where the session cookie is not readable (ADR-009).
 */
export default async function ResearcherHome({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  redirect(`/${locale}/studies`);
}
