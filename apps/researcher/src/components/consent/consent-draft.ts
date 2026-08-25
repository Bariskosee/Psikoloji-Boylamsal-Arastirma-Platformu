import type { ConsentTranslation, Locale } from "@lpr/contracts";

export interface ConsentTranslationFields {
  title: string;
  body: string;
}

/** Study languages that still lack complete, persisted consent wording. */
export function missingConsentLocales(
  supportedLocales: readonly Locale[],
  translations: readonly ConsentTranslation[],
): Locale[] {
  return supportedLocales.filter(
    (locale) =>
      !translations.some(
        (translation) =>
          translation.locale === locale &&
          translation.title.trim().length > 0 &&
          translation.body.trim().length > 0,
      ),
  );
}

/**
 * Apply a save response only when the editor still contains what was sent.
 *
 * Inputs remain editable while a save is in flight. If the researcher types
 * more before the response arrives, replacing the fields with the saved
 * snapshot would silently destroy those newer edits. The persisted draft is
 * still updated by the caller, so returning `current` deliberately leaves the
 * newer fields dirty and ready for the next save.
 */
export function reconcileSavedConsentTranslation(
  current: ConsentTranslationFields,
  submitted: ConsentTranslationFields,
  saved: ConsentTranslationFields,
): ConsentTranslationFields {
  return current.title === submitted.title && current.body === submitted.body ? saved : current;
}
