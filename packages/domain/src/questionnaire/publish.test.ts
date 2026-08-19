import { describe, expect, it } from "vitest";
import { QUESTION_TYPES, type QuestionType } from "@lpr/contracts";
import { canPublishQuestionnaire, type PublishableQuestion } from "./publish.js";

describe("canPublishQuestionnaire", () => {
  it("rejects an empty questionnaire", () => {
    expect(canPublishQuestionnaire([])).toEqual({ ok: false, reason: "EMPTY_QUESTIONNAIRE" });
  });

  it("accepts a single non-option-based question with zero options", () => {
    const question: PublishableQuestion = { type: "FREE_TEXT", optionCount: 0 };
    expect(canPublishQuestionnaire([question])).toEqual({ ok: true });
  });

  it("accepts every non-option-based type with zero options", () => {
    for (const type of QUESTION_TYPES) {
      if (type === "SINGLE_CHOICE" || type === "MULTI_CHOICE") continue;
      expect(canPublishQuestionnaire([{ type, optionCount: 0 }])).toEqual({ ok: true });
    }
  });

  it("rejects SINGLE_CHOICE and MULTI_CHOICE with fewer than two options", () => {
    for (const type of ["SINGLE_CHOICE", "MULTI_CHOICE"] as QuestionType[]) {
      expect(canPublishQuestionnaire([{ type, optionCount: 0 }])).toEqual({
        ok: false,
        reason: "INSUFFICIENT_OPTIONS",
        questionIndex: 0,
      });
      expect(canPublishQuestionnaire([{ type, optionCount: 1 }]).ok).toBe(false);
      expect(canPublishQuestionnaire([{ type, optionCount: 2 }])).toEqual({ ok: true });
    }
  });

  it("identifies which question in a multi-question draft is deficient", () => {
    const result = canPublishQuestionnaire([
      { type: "FREE_TEXT", optionCount: 0 },
      { type: "SINGLE_CHOICE", optionCount: 1 },
      { type: "NUMERIC", optionCount: 0 },
    ]);
    expect(result).toEqual({ ok: false, reason: "INSUFFICIENT_OPTIONS", questionIndex: 1 });
  });

  it("passes a fully valid multi-question draft", () => {
    const result = canPublishQuestionnaire([
      { type: "FREE_TEXT", optionCount: 0 },
      { type: "SINGLE_CHOICE", optionCount: 3 },
      { type: "LIKERT", optionCount: 0 },
      { type: "MULTI_CHOICE", optionCount: 2 },
      { type: "NUMERIC", optionCount: 0 },
    ]);
    expect(result).toEqual({ ok: true });
  });
});
