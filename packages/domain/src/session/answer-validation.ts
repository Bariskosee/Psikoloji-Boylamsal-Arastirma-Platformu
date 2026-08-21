import type { QuestionType } from "@lpr/contracts";

/**
 * Answer validation, per question type (PLAN.md Phase 6).
 *
 * Validated against the EXACT question version the participant was shown, not
 * against the questionnaire's current draft. A published version is immutable,
 * so "was this a legal answer?" has one permanent answer — and an option id
 * that belonged to a different version is rejected rather than silently
 * recorded against a question it does not belong to.
 *
 * The client runs the same rules for immediate feedback. This is the authority;
 * that is a convenience.
 */

export type AnswerValueKind = "NUMBER" | "TEXT" | "OPTION";

export interface SubmittedAnswer {
  readonly valueNumber?: number | null;
  readonly valueText?: string | null;
  /** Option ids, for the two choice types. */
  readonly selectedOptionIds?: readonly string[];
}

export interface AnsweredQuestion {
  readonly type: QuestionType;
  readonly isRequired: boolean;
  /** The option ids belonging to THIS question version. */
  readonly optionIds: readonly string[];
  /** Already normalised by its type's schema. */
  readonly config: Record<string, unknown>;
}

export type AnswerProblem =
  | "WRONG_VALUE_KIND"
  | "OPTION_NOT_IN_QUESTION"
  | "DUPLICATE_OPTION"
  | "TOO_FEW_SELECTIONS"
  | "TOO_MANY_SELECTIONS"
  | "OUT_OF_RANGE"
  | "NOT_ON_STEP"
  | "TOO_LONG"
  | "NOT_AN_INTEGER";

export type AnswerValidation =
  | { readonly ok: true; readonly valueKind: AnswerValueKind }
  | { readonly ok: false; readonly problem: AnswerProblem };

const number = (config: Record<string, unknown>, key: string): number | null => {
  const value = config[key];
  return typeof value === "number" ? value : null;
};

export function validateAnswer(
  question: AnsweredQuestion,
  answer: SubmittedAnswer,
): AnswerValidation {
  switch (question.type) {
    case "SINGLE_CHOICE":
    case "MULTI_CHOICE":
      return validateChoice(question, answer);
    case "LIKERT":
      return validateLikert(question, answer);
    case "NUMERIC":
      return validateNumeric(question, answer);
    case "FREE_TEXT":
      return validateFreeText(question, answer);
  }
}

function validateChoice(question: AnsweredQuestion, answer: SubmittedAnswer): AnswerValidation {
  const selected = answer.selectedOptionIds;
  if (selected === undefined) return { ok: false, problem: "WRONG_VALUE_KIND" };

  if (new Set(selected).size !== selected.length) {
    return { ok: false, problem: "DUPLICATE_OPTION" };
  }

  // Membership is checked against the options of THIS version. An id from
  // another version — or another question — would otherwise be stored as a
  // selection that no analysis could interpret.
  const belongs = new Set(question.optionIds);
  if (selected.some((id) => !belongs.has(id))) {
    return { ok: false, problem: "OPTION_NOT_IN_QUESTION" };
  }

  if (question.type === "SINGLE_CHOICE") {
    if (selected.length > 1) return { ok: false, problem: "TOO_MANY_SELECTIONS" };
    return { ok: true, valueKind: "OPTION" };
  }

  const min = number(question.config, "minSelections") ?? 0;
  const max = number(question.config, "maxSelections");

  // The minimum is enforced only on a non-empty answer. Clearing an answer is
  // how a participant un-answers an optional question, and a `minSelections`
  // of two would otherwise trap them into answering it.
  if (selected.length > 0 && selected.length < min) {
    return { ok: false, problem: "TOO_FEW_SELECTIONS" };
  }
  if (max !== null && selected.length > max) {
    return { ok: false, problem: "TOO_MANY_SELECTIONS" };
  }

  return { ok: true, valueKind: "OPTION" };
}

function validateLikert(question: AnsweredQuestion, answer: SubmittedAnswer): AnswerValidation {
  const value = answer.valueNumber;
  if (typeof value !== "number") return { ok: false, problem: "WRONG_VALUE_KIND" };
  if (!Number.isInteger(value)) return { ok: false, problem: "NOT_AN_INTEGER" };

  const min = number(question.config, "minValue") ?? 1;
  const max = number(question.config, "maxValue") ?? 5;
  if (value < min || value > max) return { ok: false, problem: "OUT_OF_RANGE" };

  return { ok: true, valueKind: "NUMBER" };
}

function validateNumeric(question: AnsweredQuestion, answer: SubmittedAnswer): AnswerValidation {
  const value = answer.valueNumber;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return { ok: false, problem: "WRONG_VALUE_KIND" };
  }

  const min = number(question.config, "minValue");
  const max = number(question.config, "maxValue");
  if (min !== null && value < min) return { ok: false, problem: "OUT_OF_RANGE" };
  if (max !== null && value > max) return { ok: false, problem: "OUT_OF_RANGE" };

  const step = number(question.config, "step");
  if (step !== null && step > 0) {
    const base = min ?? 0;
    const steps = (value - base) / step;
    // Floating point: 0.1 + 0.2 lands 4e-17 off, and a step of 0.1 would
    // reject a value the participant picked from the control we rendered.
    if (Math.abs(steps - Math.round(steps)) > 1e-9) return { ok: false, problem: "NOT_ON_STEP" };
  }

  return { ok: true, valueKind: "NUMBER" };
}

function validateFreeText(question: AnsweredQuestion, answer: SubmittedAnswer): AnswerValidation {
  const value = answer.valueText;
  if (typeof value !== "string") return { ok: false, problem: "WRONG_VALUE_KIND" };

  const maxLength = number(question.config, "maxLength") ?? 1000;
  if (value.length > maxLength) return { ok: false, problem: "TOO_LONG" };

  return { ok: true, valueKind: "TEXT" };
}

/**
 * Does this answer count as answered for required-question purposes?
 *
 * Separate from validity: an empty string and an empty selection are both
 * VALID writes — they are how a participant clears an answer — but neither
 * satisfies a required question. Conflating the two would either forbid
 * clearing or let a blank pass as a response.
 */
export function countsAsAnswered(type: QuestionType, answer: SubmittedAnswer): boolean {
  switch (type) {
    case "SINGLE_CHOICE":
    case "MULTI_CHOICE":
      return (answer.selectedOptionIds?.length ?? 0) > 0;
    case "LIKERT":
    case "NUMERIC":
      return typeof answer.valueNumber === "number";
    case "FREE_TEXT":
      return (answer.valueText ?? "").trim().length > 0;
  }
}

/**
 * Should this write be applied, given what is already stored?
 *
 * Autosave is gated on a monotonic client revision. The client increments it
 * per question; the server keeps the highest it has seen and ignores anything
 * at or below it. That makes a retried request a no-op rather than a
 * resurrection: an outbox replaying a stale answer after the participant has
 * since corrected it must not overwrite the correction.
 *
 * A stale write is still RECORDED in history — the point of the history table
 * is to answer "what did the client send and when", including the writes that
 * lost.
 */
export type RevisionDecision = "APPLY" | "IGNORE_STALE" | "IGNORE_DUPLICATE";

export function decideRevision(storedRevision: number | null, incoming: number): RevisionDecision {
  if (storedRevision === null) return "APPLY";
  if (incoming > storedRevision) return "APPLY";
  return incoming === storedRevision ? "IGNORE_DUPLICATE" : "IGNORE_STALE";
}
