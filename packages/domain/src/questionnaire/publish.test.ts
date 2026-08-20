import { describe, expect, it } from "vitest";
import { QUESTION_TYPES, type QuestionType } from "@lpr/contracts";
import { canPublishQuestionnaire, type PublishableQuestion } from "./publish.js";

/** A question with the config its type would normally carry. */
function q(
  type: QuestionType,
  optionCount: number,
  config: unknown = defaultConfig(type),
): PublishableQuestion {
  return { type, optionCount, config };
}

function defaultConfig(type: QuestionType): unknown {
  return type === "MULTI_CHOICE" ? { minSelections: 0, maxSelections: null } : {};
}

describe("canPublishQuestionnaire", () => {
  it("rejects an empty questionnaire", () => {
    expect(canPublishQuestionnaire([])).toEqual({ ok: false, reason: "EMPTY_QUESTIONNAIRE" });
  });

  it("accepts a single non-option-based question with zero options", () => {
    expect(canPublishQuestionnaire([q("FREE_TEXT", 0)])).toEqual({ ok: true });
  });

  it("accepts every non-option-based type with zero options", () => {
    for (const type of QUESTION_TYPES) {
      if (type === "SINGLE_CHOICE" || type === "MULTI_CHOICE") continue;
      expect(canPublishQuestionnaire([q(type, 0)])).toEqual({ ok: true });
    }
  });

  it("rejects SINGLE_CHOICE and MULTI_CHOICE with fewer than two options", () => {
    for (const type of ["SINGLE_CHOICE", "MULTI_CHOICE"] as QuestionType[]) {
      expect(canPublishQuestionnaire([q(type, 0)])).toEqual({
        ok: false,
        reason: "INSUFFICIENT_OPTIONS",
        questionIndex: 0,
        requiredOptions: 2,
      });
      expect(canPublishQuestionnaire([q(type, 1)]).ok).toBe(false);
      expect(canPublishQuestionnaire([q(type, 2)])).toEqual({ ok: true });
    }
  });

  it("identifies which question in a multi-question draft is deficient", () => {
    const result = canPublishQuestionnaire([
      q("FREE_TEXT", 0),
      q("SINGLE_CHOICE", 1),
      q("NUMERIC", 0),
    ]);
    expect(result).toEqual({
      ok: false,
      reason: "INSUFFICIENT_OPTIONS",
      questionIndex: 1,
      requiredOptions: 2,
    });
  });

  it("passes a fully valid multi-question draft", () => {
    const result = canPublishQuestionnaire([
      q("FREE_TEXT", 0),
      q("SINGLE_CHOICE", 3),
      q("LIKERT", 0),
      q("MULTI_CHOICE", 2),
      q("NUMERIC", 0),
    ]);
    expect(result).toEqual({ ok: true });
  });
});

/**
 * The check that stops an unanswerable question becoming immutable.
 *
 * `minSelections` above the option count makes a REQUIRED question impossible
 * to satisfy, and a published version can never be corrected — so this has to
 * fail before the version exists, not during data collection.
 */
describe("multi-choice selection bounds against the option count", () => {
  it("rejects a minimum higher than the number of options", () => {
    const result = canPublishQuestionnaire([
      q("MULTI_CHOICE", 2, { minSelections: 5, maxSelections: null }),
    ]);
    expect(result).toEqual({
      ok: false,
      reason: "SELECTION_BOUNDS_EXCEED_OPTIONS",
      questionIndex: 0,
    });
  });

  it("rejects a maximum higher than the number of options", () => {
    const result = canPublishQuestionnaire([
      q("MULTI_CHOICE", 3, { minSelections: 1, maxSelections: 4 }),
    ]);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("SELECTION_BOUNDS_EXCEED_OPTIONS");
  });

  it("accepts bounds exactly equal to the option count", () => {
    expect(
      canPublishQuestionnaire([q("MULTI_CHOICE", 3, { minSelections: 3, maxSelections: 3 })]),
    ).toEqual({ ok: true });
  });

  it("accepts an unbounded maximum", () => {
    expect(
      canPublishQuestionnaire([q("MULTI_CHOICE", 2, { minSelections: 0, maxSelections: null })]),
    ).toEqual({ ok: true });
  });

  it("reports the offending question's position in a longer draft", () => {
    const result = canPublishQuestionnaire([
      q("FREE_TEXT", 0),
      q("MULTI_CHOICE", 4, { minSelections: 1, maxSelections: 4 }),
      q("MULTI_CHOICE", 2, { minSelections: 3, maxSelections: null }),
    ]);
    expect(result.questionIndex).toBe(2);
  });

  it("leaves single-choice alone — it has no selection bounds to exceed", () => {
    expect(canPublishQuestionnaire([q("SINGLE_CHOICE", 2, {})])).toEqual({ ok: true });
  });

  it("does not throw on a config that is missing, null, or the wrong shape", () => {
    // A row written before a config-schema change must fail safely rather than
    // crash the publish transaction.
    for (const config of [null, undefined, "not an object", {}]) {
      expect(canPublishQuestionnaire([q("MULTI_CHOICE", 2, config)])).toEqual({ ok: true });
    }
  });
});
