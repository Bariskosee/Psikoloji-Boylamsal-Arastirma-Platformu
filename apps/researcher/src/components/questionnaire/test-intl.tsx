import type { ReactNode } from "react";
import { NextIntlClientProvider } from "next-intl";
import messages from "@lpr/i18n/messages/en.json";

/**
 * Wraps a component under test in the REAL English catalog.
 *
 * Not a stub of `useTranslations`: a stub returns the key for anything asked
 * of it, so a component referencing a string nobody ever added to the catalog
 * still renders and still passes. With the real messages, a missing key is a
 * loud failure here rather than a raw `questionnaires.foo` shipped to a
 * researcher — and `packages/i18n`'s catalog test guarantees Turkish has
 * whatever English has.
 */
export function withIntl(children: ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={messages}>
      {children}
    </NextIntlClientProvider>
  );
}
