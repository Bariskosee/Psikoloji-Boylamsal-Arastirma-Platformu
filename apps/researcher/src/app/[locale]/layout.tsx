import type { ReactNode } from "react";
import { Geist, Geist_Mono } from "next/font/google";
import { NextIntlClientProvider } from "next-intl";
import { getMessages, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { routing } from "@/i18n/routing";
import "../globals.css";

/**
 * Geist for text, Geist Mono for codes.
 *
 * The mono face is not decoration: enrollment codes, participant public codes
 * and question keys are strings a researcher reads character by character and
 * sometimes reads ALOUD to a participant on the phone. In a proportional face
 * `l`/`1` and `O`/`0` are a genuine hazard; in a mono face with slashed zero
 * they are not.
 *
 * `display: "swap"` so text is readable while the font loads rather than
 * invisible — a dashboard that flashes blank is a dashboard that looks broken.
 */
const sans = Geist({ subsets: ["latin"], variable: "--font-sans", display: "swap" });
const mono = Geist_Mono({ subsets: ["latin"], variable: "--font-mono", display: "swap" });

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
    <html lang={locale} className={`${sans.variable} ${mono.variable}`} suppressHydrationWarning>
      <body className="bg-background text-foreground min-h-svh antialiased">
        <NextIntlClientProvider messages={messages}>
          {/*
            Required by the sidebar, whose collapsed rail relies on tooltips to
            stay usable once the labels are hidden. Without the provider the
            first collapsed render throws and takes the whole page with it.
          */}
          <TooltipProvider delayDuration={300}>{children}</TooltipProvider>
          {/*
            Toasts, for the confirmations that used to be invisible.
            A researcher who publishes a version or removes a member currently
            gets no acknowledgement at all beyond the list quietly changing —
            which on a slow connection is indistinguishable from nothing having
            happened, and invites a second click.
          */}
          <Toaster position="top-right" richColors closeButton />
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
