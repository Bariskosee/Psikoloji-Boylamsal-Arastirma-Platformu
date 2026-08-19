import type { ReactNode } from "react";
import { NextIntlClientProvider } from "next-intl";
import { getMessages, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { routing } from "@/i18n/routing";

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;

  if (!routing.locales.includes(locale as (typeof routing.locales)[number])) {
    notFound();
  }
  setRequestLocale(locale);

  const messages = await getMessages();

  return (
    <html lang={locale}>
      <body
        style={{
          fontFamily: "system-ui, -apple-system, sans-serif",
          margin: 0,
          padding: "2rem 1rem",
          lineHeight: 1.6,
        }}
      >
        <NextIntlClientProvider messages={messages}>
          {/* Wider than the participant app on purpose: the questionnaire
              builder places the editor and the phone-width preview side by
              side, and 640px would force them to stack on every desktop. */}
          <main style={{ maxWidth: 1100, margin: "0 auto" }}>{children}</main>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
