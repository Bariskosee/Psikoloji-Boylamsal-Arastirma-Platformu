import { defineRouting } from "next-intl/routing";

/**
 * Locale routing (FR-37).
 *
 * Locales come from @lpr/contracts so the server, both frontends, and the
 * database all agree on the supported set — there is one definition.
 */
export const routing = defineRouting({
  locales: ["en", "tr"],
  defaultLocale: "en",
});
