import type { QuestionType } from "@lpr/contracts";
import { QUESTION_TYPE_METADATA } from "../question-types/registry.js";

/**
 * Publish eligibility (PLAN.md Phase 3 acceptance criteria).
 *
 * Checked before the deep-copy transaction runs, so a researcher gets a
 * specific, actionable reason rather than an empty published version or a
 * constraint violation. Pure: given a snapshot of the draft's questions, it
 * needs no database access.
 */

export interface PublishableQuestion {
  readonly type: QuestionType;
  readonly optionCount: number;
}

export interface PublishEligibility {
  ok: boolean;
  reason?: "EMPTY_QUESTIONNAIRE" | "INSUFFICIENT_OPTIONS";
  /** `question_key`-less index into the input array, present for INSUFFICIENT_OPTIONS. */
  questionIndex?: number;
}

export function canPublishQuestionnaire(
  questions: readonly PublishableQuestion[],
): PublishEligibility {
  if (questions.length === 0) return { ok: false, reason: "EMPTY_QUESTIONNAIRE" };

  for (const [index, question] of questions.entries()) {
    const metadata = QUESTION_TYPE_METADATA[question.type];
    if (question.optionCount < metadata.minOptionsToPublish) {
      return { ok: false, reason: "INSUFFICIENT_OPTIONS", questionIndex: index };
    }
  }

  return { ok: true };
}
