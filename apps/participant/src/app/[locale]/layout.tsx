import type { ReactNode } from "react";
import { NextIntlClientProvider } from "next-intl";
import { getMessages, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { routing } from "@/i18n/routing";
import { ServiceWorkerUpdater } from "@/components/ServiceWorkerUpdater";
import "../globals.css";

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
      <head>
        {/*
          Locale-specific, so the name under the Home Screen icon is in the
          participant's own language (STRUCTURE.md §15). `useCredentials` is not
          set: the manifest is public, and requesting it with credentials would
          fail CORS on some browsers and silently disable installation.
        */}
        <link rel="manifest" href={`/${locale}/manifest.webmanifest`} />
        {/*
          iOS ignores the manifest's icon list for the Home Screen and reads
          this instead. Without it, installing on an iPhone produces an icon
          that is a screenshot of the page — which is how a study application
          ends up unrecognisable on the one screen it has to be found on.
        */}
        <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />
        {/*
          Also the browser-tab icon. Without it every page load logs a 404 for
          `/favicon.ico`, which is noise in exactly the console a QA pass reads
          to find real errors.
        */}
        <link rel="icon" href="/icons/icon-192.png" type="image/png" />
        {/*
          Both names, deliberately. `mobile-web-app-capable` is the standard
          one current browsers read and the only one that does not log a
          deprecation warning; the Apple-prefixed name is still what older iOS
          versions honour, and dropping it would break standalone launch on
          exactly the devices this platform cares most about (ADR-007).
        */}
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="default" />
        <meta name="theme-color" content="#0d4f63" />
        {/*
          `viewport-fit=cover` plus the safe-area padding below: without it the
          layout runs under the home indicator on a notched iPhone, and the last
          button on a questionnaire page becomes unreachable.
        */}
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
      </head>
      <body
        className="bg-background text-foreground antialiased"
        style={{
          margin: 0,
          padding: "1.5rem 1rem",
          // `viewport-fit=cover` above plus this: without it the layout runs
          // under the home indicator on a notched iPhone, and the last button
          // on a questionnaire page becomes unreachable.
          paddingBottom: "calc(2rem + env(safe-area-inset-bottom))",
          lineHeight: 1.6,
        }}
      >
        <NextIntlClientProvider messages={messages}>
          <main style={{ maxWidth: 640, margin: "0 auto" }}>{children}</main>
          {/*
            Mounted once, here, so every screen registers the worker and every
            screen can surface a waiting update — rather than each page having
            to remember to (see the component for why the update is a prompt).
          */}
          <ServiceWorkerUpdater />
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
