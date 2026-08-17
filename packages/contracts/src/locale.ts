import { z } from "zod";

/**
 * Supported interface locales (FR-37).
 *
 * This governs interface strings only. Researcher-entered questionnaire content
 * and consent documents are application data with their own translation rows —
 * three separate concerns, per STRUCTURE.md §15.
 */
export const LOCALES = ["en", "tr"] as const;

export const localeSchema = z.enum(LOCALES);
export type Locale = z.infer<typeof localeSchema>;

export const DEFAULT_LOCALE: Locale = "en";

export function isLocale(value: unknown): value is Locale {
  return localeSchema.safeParse(value).success;
}
