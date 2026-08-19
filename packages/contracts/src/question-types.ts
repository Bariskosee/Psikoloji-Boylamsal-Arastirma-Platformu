import { z } from "zod";

/**
 * The five MVP question types (PLAN.md Phase 3).
 *
 * Adding a type later is one enum value, one config schema here, and one
 * renderer in the participant application — never a migration, because
 * everything type-specific that would otherwise need a column lives in the
 * `config` jsonb (STRUCTURE.md §6).
 */
export const QUESTION_TYPES = [
  "SINGLE_CHOICE",
  "MULTI_CHOICE",
  "LIKERT",
  "NUMERIC",
  "FREE_TEXT",
] as const;

export const questionTypeSchema = z.enum(QUESTION_TYPES);
export type QuestionType = z.infer<typeof questionTypeSchema>;

/**
 * Option-based types render from `question_options` rows and require at
 * least two of them at publish time. The other three types never have
 * options at all — the API rejects creating one under them.
 */
export const OPTION_BASED_QUESTION_TYPES: readonly QuestionType[] = [
  "SINGLE_CHOICE",
  "MULTI_CHOICE",
];

/**
 * Per-type `config` schemas.
 *
 * `config` holds only presentation parameters that are never filtered or
 * joined on (STRUCTURE.md §6) — everything queried relationally is a real
 * column instead. Each type is validated on every write, never trusted as
 * opaque jsonb.
 */
export const singleChoiceConfigSchema = z.object({}).strict();
export type SingleChoiceConfig = z.infer<typeof singleChoiceConfigSchema>;

export const multiChoiceConfigSchema = z
  .object({
    minSelections: z.number().int().min(0).max(1000).default(0),
    maxSelections: z.number().int().min(1).max(1000).nullable().default(null),
  })
  .strict()
  .refine((value) => value.maxSelections === null || value.maxSelections >= value.minSelections, {
    message: "maxSelections must be greater than or equal to minSelections",
    path: ["maxSelections"],
  });
export type MultiChoiceConfig = z.infer<typeof multiChoiceConfigSchema>;

export const likertConfigSchema = z
  .object({
    minValue: z.number().int().min(-100).max(100).default(1),
    maxValue: z.number().int().min(-100).max(100).default(5),
    minLabel: z.string().trim().max(200).default(""),
    maxLabel: z.string().trim().max(200).default(""),
  })
  .strict()
  .refine((value) => value.maxValue > value.minValue, {
    message: "maxValue must be greater than minValue",
    path: ["maxValue"],
  });
export type LikertConfig = z.infer<typeof likertConfigSchema>;

export const numericConfigSchema = z
  .object({
    minValue: z.number().finite().nullable().default(null),
    maxValue: z.number().finite().nullable().default(null),
    step: z.number().positive().finite().nullable().default(null),
  })
  .strict()
  .refine(
    (value) =>
      value.minValue === null || value.maxValue === null || value.maxValue >= value.minValue,
    { message: "maxValue must be greater than or equal to minValue", path: ["maxValue"] },
  );
export type NumericConfig = z.infer<typeof numericConfigSchema>;

export const freeTextConfigSchema = z
  .object({
    maxLength: z.number().int().positive().max(10_000).default(1000),
    multiline: z.boolean().default(true),
  })
  .strict();
export type FreeTextConfig = z.infer<typeof freeTextConfigSchema>;

/**
 * The single dispatch table from type to config schema.
 *
 * @lpr/domain's question-type registry re-exports this rather than
 * duplicating it — the schema is the contract, the registry is the pure
 * logic built on top of it.
 */
export const QUESTION_CONFIG_SCHEMAS = {
  SINGLE_CHOICE: singleChoiceConfigSchema,
  MULTI_CHOICE: multiChoiceConfigSchema,
  LIKERT: likertConfigSchema,
  NUMERIC: numericConfigSchema,
  FREE_TEXT: freeTextConfigSchema,
} as const satisfies Record<QuestionType, z.ZodTypeAny>;

export type QuestionConfig =
  SingleChoiceConfig | MultiChoiceConfig | LikertConfig | NumericConfig | FreeTextConfig;

/** Any one of the five config shapes, before it is known which type it belongs to. */
export const questionConfigSchema = z.union([
  singleChoiceConfigSchema,
  multiChoiceConfigSchema,
  likertConfigSchema,
  numericConfigSchema,
  freeTextConfigSchema,
]);

/**
 * `question_key` / `option_key` — stable, opaque identifiers.
 *
 * Not participant- or public-facing (unlike the enrollment code), so the
 * alphabet does not need to exclude visually ambiguous characters. They are
 * the export column keys (FR-43) and must survive question edits and every
 * future publish untouched — generation lives in @lpr/domain, this is the
 * wire format.
 */
export const ENTITY_KEY_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
export const ENTITY_KEY_LENGTH = 10;

export const questionKeySchema = z
  .string()
  .regex(new RegExp(`^q_[${ENTITY_KEY_ALPHABET}]{${ENTITY_KEY_LENGTH}}$`));

export const optionKeySchema = z
  .string()
  .regex(new RegExp(`^o_[${ENTITY_KEY_ALPHABET}]{${ENTITY_KEY_LENGTH}}$`));
