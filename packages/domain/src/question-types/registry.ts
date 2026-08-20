import { QUESTION_CONFIG_SCHEMAS, type QuestionConfig, type QuestionType } from "@lpr/contracts";

/**
 * The question-type registry (PLAN.md Phase 3, STRUCTURE.md §3).
 *
 * Pure metadata plus one validation function over the Zod schemas @lpr/contracts
 * already defines per type. This is the single place that knows "does this type
 * take options" and "is this config well-formed for this type" — the service
 * layer never switches on `type` itself.
 *
 * Adding a sixth type touches exactly three places: one enum value and one
 * config schema in @lpr/contracts, and one entry in `QUESTION_TYPE_METADATA`
 * here. No migration, per STRUCTURE.md §6.
 */

export interface QuestionTypeMetadata {
  readonly requiresOptions: boolean;
  /** Minimum option count enforced at publish time, not on every save. */
  readonly minOptionsToPublish: number;
}

export const QUESTION_TYPE_METADATA: Readonly<Record<QuestionType, QuestionTypeMetadata>> = {
  SINGLE_CHOICE: { requiresOptions: true, minOptionsToPublish: 2 },
  MULTI_CHOICE: { requiresOptions: true, minOptionsToPublish: 2 },
  LIKERT: { requiresOptions: false, minOptionsToPublish: 0 },
  NUMERIC: { requiresOptions: false, minOptionsToPublish: 0 },
  FREE_TEXT: { requiresOptions: false, minOptionsToPublish: 0 },
};

export function requiresOptions(type: QuestionType): boolean {
  return QUESTION_TYPE_METADATA[type].requiresOptions;
}

export interface ConfigValidationResult {
  ok: boolean;
  /** Parsed and defaulted config, present only when `ok`. */
  config?: QuestionConfig;
  /** Field-level issues, present only when not `ok`. */
  errors?: Array<{ path: string; message: string }>;
}

/**
 * Validate and normalise a question's `config` against its `type`.
 *
 * Applies the schema's own defaults (e.g. a Likert config with no bounds
 * supplied gets 1..5), so the caller always persists a complete, typed shape
 * rather than whatever partial object the client happened to send.
 */
export function validateQuestionConfig(
  type: QuestionType,
  config: unknown,
): ConfigValidationResult {
  const schema = QUESTION_CONFIG_SCHEMAS[type];
  const result = schema.safeParse(config);
  if (result.success) return { ok: true, config: result.data as QuestionConfig };
  return {
    ok: false,
    errors: result.error.issues.map((issue) => ({
      path: issue.path.join(".") || "(root)",
      message: issue.message,
    })),
  };
}
