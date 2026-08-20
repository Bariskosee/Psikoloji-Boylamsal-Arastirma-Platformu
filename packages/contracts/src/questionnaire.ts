import { z } from "zod";
import { localeSchema } from "./locale.js";
import {
  optionKeySchema,
  questionKeySchema,
  questionTypeSchema,
  type QuestionConfig,
} from "./question-types.js";

/**
 * Questionnaires and their versions (STRUCTURE.md §6, PLAN.md Phase 3).
 *
 * `questionnaires` is a stable, always-editable label (`name`, `description`)
 * a study's questions are filed under. All actual content — questions,
 * options, translations — lives on `questionnaire_versions`, of which exactly
 * one is ever `DRAFT`. Publishing deep-copies the draft's content into a new
 * immutable `PUBLISHED` version; the draft itself is untouched and keeps
 * accumulating edits toward the next publish.
 */

export const QUESTIONNAIRE_VERSION_STATUSES = ["DRAFT", "PUBLISHED", "RETIRED"] as const;
export const questionnaireVersionStatusSchema = z.enum(QUESTIONNAIRE_VERSION_STATUSES);
export type QuestionnaireVersionStatus = z.infer<typeof questionnaireVersionStatusSchema>;

export const questionnaireNameSchema = z.string().trim().min(1).max(200);
export const questionnaireDescriptionSchema = z.string().trim().max(4000);

export const createQuestionnaireRequestSchema = z.object({
  name: questionnaireNameSchema,
  description: questionnaireDescriptionSchema.default(""),
});
export type CreateQuestionnaireRequest = z.infer<typeof createQuestionnaireRequestSchema>;

export const updateQuestionnaireRequestSchema = z
  .object({
    name: questionnaireNameSchema.optional(),
    description: questionnaireDescriptionSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: "No fields to update" });
export type UpdateQuestionnaireRequest = z.infer<typeof updateQuestionnaireRequestSchema>;

// ─────────────────────────── Question translations ────────────────────────

/**
 * `{ en: "...", tr: "..." }` — at least one entry. A question may be created
 * with only the study's default locale filled in and translated later; the
 * builder must never block on every locale being present at once.
 */
export const localizedTextSchema = z
  .record(localeSchema, z.string().trim().min(1).max(2000))
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one translation is required",
  });
export type LocalizedText = z.infer<typeof localizedTextSchema>;

const localizedLabelSchema = z
  .record(localeSchema, z.string().trim().min(1).max(500))
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one translation is required",
  });

// ────────────────────────────────── Options ────────────────────────────────

export const createQuestionOptionRequestSchema = z.object({
  translations: localizedLabelSchema,
  valueNumber: z.number().finite().nullable().default(null),
  isExclusive: z.boolean().default(false),
});
export type CreateQuestionOptionRequest = z.infer<typeof createQuestionOptionRequestSchema>;

export const updateQuestionOptionRequestSchema = z
  .object({
    translations: localizedLabelSchema.optional(),
    valueNumber: z.number().finite().nullable().optional(),
    isExclusive: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: "No fields to update" });
export type UpdateQuestionOptionRequest = z.infer<typeof updateQuestionOptionRequestSchema>;

export const reorderOptionsRequestSchema = z.object({
  optionIds: z.array(z.string().uuid()).min(1),
});
export type ReorderOptionsRequest = z.infer<typeof reorderOptionsRequestSchema>;

export const questionOptionResponseSchema = z.object({
  id: z.string().uuid(),
  optionKey: optionKeySchema,
  displayOrder: z.number().int(),
  valueNumber: z.number().nullable(),
  isExclusive: z.boolean(),
  translations: z.record(localeSchema, z.string()),
});
export type QuestionOptionResponse = z.infer<typeof questionOptionResponseSchema>;

// ───────────────────────────────── Questions ───────────────────────────────

export const createQuestionRequestSchema = z.object({
  type: questionTypeSchema,
  translations: localizedTextSchema,
  isRequired: z.boolean().default(true),
  pageIndex: z.number().int().min(0).max(1000).default(0),
  /**
   * Validated against the schema for `type` by the service, using
   * @lpr/domain's registry — Zod alone cannot express "shaped according to a
   * sibling field" across a plain object without a discriminated union, and
   * the wire shape here keeps `type` and `config` as two independent fields
   * matching the two database columns.
   */
  config: z.record(z.string(), z.unknown()).default({}),
});
export type CreateQuestionRequest = z.infer<typeof createQuestionRequestSchema>;

/**
 * `type` is deliberately absent from the update shape. Changing a published
 * question's type would strand its `config` and, for option-based types, its
 * options — deleting and recreating the question is the supported path for
 * that, and it correctly assigns a fresh `question_key`.
 */
export const updateQuestionRequestSchema = z
  .object({
    translations: localizedTextSchema.optional(),
    isRequired: z.boolean().optional(),
    pageIndex: z.number().int().min(0).max(1000).optional(),
    config: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: "No fields to update" });
export type UpdateQuestionRequest = z.infer<typeof updateQuestionRequestSchema>;

export const reorderQuestionsRequestSchema = z.object({
  questionIds: z.array(z.string().uuid()).min(1),
});
export type ReorderQuestionsRequest = z.infer<typeof reorderQuestionsRequestSchema>;

export const questionResponseSchema = z.object({
  id: z.string().uuid(),
  questionKey: questionKeySchema,
  type: questionTypeSchema,
  isRequired: z.boolean(),
  pageIndex: z.number().int(),
  displayOrder: z.number().int(),
  config: z.custom<QuestionConfig>(),
  translations: z.record(localeSchema, z.string()),
  options: z.array(questionOptionResponseSchema),
});
export type QuestionResponse = z.infer<typeof questionResponseSchema>;

// ─────────────────────────────────── Versions ──────────────────────────────

export const questionnaireVersionSummarySchema = z.object({
  id: z.string().uuid(),
  status: questionnaireVersionStatusSchema,
  versionNumber: z.number().int().nullable(),
  questionCount: z.number().int(),
  publishedAt: z.string().datetime().nullable(),
});
export type QuestionnaireVersionSummary = z.infer<typeof questionnaireVersionSummarySchema>;

export const questionnaireVersionDetailSchema = questionnaireVersionSummarySchema.extend({
  questionnaireId: z.string().uuid(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  questions: z.array(questionResponseSchema),
});
export type QuestionnaireVersionDetail = z.infer<typeof questionnaireVersionDetailSchema>;

// ───────────────────────────────── Questionnaires ──────────────────────────

export const questionnaireSummarySchema = z.object({
  id: z.string().uuid(),
  studyId: z.string().uuid(),
  name: z.string(),
  description: z.string(),
  draft: questionnaireVersionSummarySchema,
  latestPublished: questionnaireVersionSummarySchema.nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type QuestionnaireSummary = z.infer<typeof questionnaireSummarySchema>;

export const questionnaireListResponseSchema = z.object({
  questionnaires: z.array(questionnaireSummarySchema),
});
export type QuestionnaireListResponse = z.infer<typeof questionnaireListResponseSchema>;

export const questionnaireDetailSchema = z.object({
  id: z.string().uuid(),
  studyId: z.string().uuid(),
  name: z.string(),
  description: z.string(),
  draft: questionnaireVersionDetailSchema,
  publishedVersions: z.array(questionnaireVersionSummarySchema),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type QuestionnaireDetail = z.infer<typeof questionnaireDetailSchema>;
