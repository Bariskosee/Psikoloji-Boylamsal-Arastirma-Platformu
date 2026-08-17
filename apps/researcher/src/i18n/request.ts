import { getRequestConfig } from "next-intl/server";
import en from "@lpr/i18n/messages/en.json";
import tr from "@lpr/i18n/messages/tr.json";
import { routing } from "./routing";

const catalogs = { en, tr } as const;

export default getRequestConfig(async ({ requestLocale }) => {
  const requested = await requestLocale;
  const locale = (
    requested && routing.locales.includes(requested as (typeof routing.locales)[number])
      ? requested
      : routing.defaultLocale
  ) as keyof typeof catalogs;

  return { locale, messages: catalogs[locale] };
});
