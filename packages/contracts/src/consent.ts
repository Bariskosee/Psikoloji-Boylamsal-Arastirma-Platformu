import { z } from "zod";
import { localeSchema } from "./locale.js";

/**
 * Consent documents (FR-05, PLAN.md Phase 5).
 *
 * Versioned and immutable once published, for the same reason questionnaires
 * are: an enrollment records WHICH version the participant agreed to and in
 * which language, and that record is worthless if the text behind it can
 * change afterwards. An ethics committee asking "what exactly did this person
 * consent to on 4 September?" must have an answer.
 *
 * The platform stores consent text; it never writes it. Consent language comes
 * from the research team (AGENT.md §16, CLAUDE.md) — repository fixtures use
 * neutral placeholders only.
 */

export const CONSENT_VERSION_STATUSES = ["DRAFT", "PUBLISHED", "RETIRED"] as const;
export const consentVersionStatusSchema = z.enum(CONSENT_VERSION_STATUSES);
export type ConsentVersionStatus = z.infer<typeof consentVersionStatusSchema>;

/**
 * One locale's text.
 *
 * Plain text, not HTML or Markdown: a consent document rendered from
 * researcher-supplied markup is an injection surface aimed at participants,
 * and the formatting gained is not worth it.
 */
export const consentTranslationSchema = z.object({
  locale: localeSchema,
  title: z.string().min(1).max(300),
  body: z.string().min(1).max(50_000),
});

export type ConsentTranslation = z.infer<typeof consentTranslationSchema>;

export const upsertConsentTranslationSchema = consentTranslationSchema;

export type UpsertConsentTranslationRequest = z.infer<typeof upsertConsentTranslationSchema>;

export const consentVersionSchema = z.object({
  id: z.string().uuid(),
  studyId: z.string().uuid(),
  status: consentVersionStatusSchema,
  versionNumber: z.number().int().nullable(),
  publishedAt: z.string().nullable(),
  translations: z.array(consentTranslationSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type ConsentVersionResponse = z.infer<typeof consentVersionSchema>;

export const consentVersionListSchema = z.object({
  versions: z.array(consentVersionSchema),
});

export type ConsentVersionListResponse = z.infer<typeof consentVersionListSchema>;
