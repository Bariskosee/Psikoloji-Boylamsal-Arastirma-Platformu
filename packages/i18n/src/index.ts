/**
 * @lpr/i18n — interface translation catalogs and locale negotiation.
 *
 * Scope note (FR-37, STRUCTURE.md §15). This package holds INTERFACE strings
 * only. Two other kinds of translatable text exist and are deliberately NOT
 * here:
 *
 *   1. Researcher-entered questionnaire content — application data, stored in
 *      `*_translations` tables keyed by (entity version, locale).
 *   2. Consent documents — versioned records with per-locale bodies, where the
 *      locale accepted is recorded on the enrollment.
 *
 * Putting study content in a JSON catalog would hard-code research content,
 * which AGENT.md §3.4 prohibits.
 */

import { DEFAULT_LOCALE, LOCALES, isLocale, type Locale } from "@lpr/contracts";

export { DEFAULT_LOCALE, LOCALES, isLocale, type Locale };

/**
 * Resolve the locale to use for a request.
 *
 * Precedence (STRUCTURE.md §15): explicit URL segment, then the participant's
 * stored preference, then the study default, then the platform default.
 * The browser's Accept-Language is the weakest signal and is consulted last.
 */
export function resolveLocale(candidates: {
  fromUrl?: string | null;
  fromParticipantPreference?: string | null;
  fromStudyDefault?: string | null;
  fromAcceptLanguage?: string | null;
}): Locale {
  const ordered = [
    candidates.fromUrl,
    candidates.fromParticipantPreference,
    candidates.fromStudyDefault,
    parseAcceptLanguage(candidates.fromAcceptLanguage),
  ];

  for (const candidate of ordered) {
    if (isLocale(candidate)) return candidate;
  }
  return DEFAULT_LOCALE;
}

/** Returns the first supported locale named in an Accept-Language header. */
export function parseAcceptLanguage(header: string | null | undefined): Locale | null {
  if (!header) return null;

  const tags = header
    .split(",")
    .map((part) => {
      const [tag = "", ...params] = part.trim().split(";");
      const qParam = params.find((p) => p.trim().startsWith("q="));
      const quality = qParam ? Number.parseFloat(qParam.trim().slice(2)) : 1;
      return { tag: tag.trim().toLowerCase(), quality: Number.isNaN(quality) ? 0 : quality };
    })
    .sort((a, b) => b.quality - a.quality);

  for (const { tag } of tags) {
    const base = tag.split("-")[0];
    if (isLocale(base)) return base;
  }
  return null;
}
