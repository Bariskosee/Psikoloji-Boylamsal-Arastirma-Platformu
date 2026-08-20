import type { MultiChoiceConfig, QuestionType } from "@lpr/contracts";
import { QUESTION_TYPE_METADATA } from "../question-types/registry.js";

/**
 * Publish eligibility (PLAN.md Phase 3 acceptance criteria).
 *
 * Checked before the deep-copy transaction runs, so a researcher gets a
 * specific, actionable reason rather than an empty published version or a
 * constraint violation. Pure: given a snapshot of the draft's questions, it
 * needs no database access.
 *
 * ── Why the cross-field checks live HERE and not in the config schema ────────
 * A question's `config` is validated against its type on every write, but at
 * that moment the question usually has no options yet — they are added
 * afterwards, one request at a time. "May this question ask for five
 * selections?" is answerable only once both the config and the option list are
 * final, which is exactly what publish time is.
 *
 * It matters because publishing is irreversible: a required MULTI_CHOICE
 * question with `minSelections: 5` and two options is unsatisfiable forever,
 * and every participant assigned that version hits a question they cannot
 * legally answer. That is a research-integrity defect (AGENT.md §17), not a
 * cosmetic one, so it is caught before the version exists rather than
 * discovered during data collection.
 */

export interface PublishableQuestion {
  readonly type: QuestionType;
  readonly optionCount: number;
  /** The question's stored config, already normalised by its type's schema. */
  readonly config: unknown;
}

export type PublishBlockReason =
  "EMPTY_QUESTIONNAIRE" | "INSUFFICIENT_OPTIONS" | "SELECTION_BOUNDS_EXCEED_OPTIONS";

export interface PublishEligibility {
  ok: boolean;
  reason?: PublishBlockReason;
  /** 0-based index into the input array; present for every question-specific reason. */
  questionIndex?: number;
  /** The option count the blocked question needed; present for INSUFFICIENT_OPTIONS. */
  requiredOptions?: number;
}

export function canPublishQuestionnaire(
  questions: readonly PublishableQuestion[],
): PublishEligibility {
  if (questions.length === 0) return { ok: false, reason: "EMPTY_QUESTIONNAIRE" };

  for (const [index, question] of questions.entries()) {
    const metadata = QUESTION_TYPE_METADATA[question.type];

    if (question.optionCount < metadata.minOptionsToPublish) {
      return {
        ok: false,
        reason: "INSUFFICIENT_OPTIONS",
        questionIndex: index,
        requiredOptions: metadata.minOptionsToPublish,
      };
    }

    if (question.type === "MULTI_CHOICE" && exceedsOptionCount(question)) {
      return { ok: false, reason: "SELECTION_BOUNDS_EXCEED_OPTIONS", questionIndex: index };
    }
  }

  return { ok: true };
}

/**
 * Does this multi-choice question demand more selections than it offers?
 *
 * `minSelections` above the option count makes a required question impossible.
 * `maxSelections` above it is not impossible, only meaningless — but a
 * researcher who wrote it meant something, and publishing it unchanged freezes
 * the misunderstanding into an immutable version.
 *
 * The config is read defensively rather than cast: it comes back from a jsonb
 * column, and a row written before a schema change should fail the publish
 * safely instead of throwing on a missing field.
 */
function exceedsOptionCount(question: PublishableQuestion): boolean {
  const config = question.config as Partial<MultiChoiceConfig> | null | undefined;
  if (!config || typeof config !== "object") return false;

  const min = typeof config.minSelections === "number" ? config.minSelections : 0;
  if (min > question.optionCount) return true;

  const max = config.maxSelections;
  return typeof max === "number" && max > question.optionCount;
}
