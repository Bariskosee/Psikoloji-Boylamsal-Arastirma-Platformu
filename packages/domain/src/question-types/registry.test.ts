import { describe, expect, it } from "vitest";
import { QUESTION_TYPES } from "@lpr/contracts";
import { ALL_QUESTION_TYPES, requiresOptions, validateQuestionConfig } from "./registry.js";

describe("question type metadata", () => {
  it("covers every declared question type exactly once", () => {
    expect([...ALL_QUESTION_TYPES].sort()).toEqual([...QUESTION_TYPES].sort());
  });

  it("only the two choice types require options", () => {
    for (const type of QUESTION_TYPES) {
      const expected = type === "SINGLE_CHOICE" || type === "MULTI_CHOICE";
      expect(requiresOptions(type)).toBe(expected);
    }
  });
});

describe("validateQuestionConfig", () => {
  it("accepts an empty config for SINGLE_CHOICE and rejects unknown keys", () => {
    expect(validateQuestionConfig("SINGLE_CHOICE", {}).ok).toBe(true);
    expect(validateQuestionConfig("SINGLE_CHOICE", { extra: true }).ok).toBe(false);
  });

  it("applies MULTI_CHOICE defaults and rejects an inverted range", () => {
    const withDefaults = validateQuestionConfig("MULTI_CHOICE", {});
    expect(withDefaults).toEqual({
      ok: true,
      config: { minSelections: 0, maxSelections: null },
    });

    const inverted = validateQuestionConfig("MULTI_CHOICE", {
      minSelections: 3,
      maxSelections: 1,
    });
    expect(inverted.ok).toBe(false);
    expect(inverted.errors?.[0]?.path).toBe("maxSelections");
  });

  it("applies LIKERT defaults and rejects a non-increasing range", () => {
    const withDefaults = validateQuestionConfig("LIKERT", {});
    expect(withDefaults.ok).toBe(true);
    expect(withDefaults.config).toMatchObject({ minValue: 1, maxValue: 5 });

    expect(validateQuestionConfig("LIKERT", { minValue: 5, maxValue: 5 }).ok).toBe(false);
    expect(validateQuestionConfig("LIKERT", { minValue: 5, maxValue: 1 }).ok).toBe(false);
  });

  it("accepts an open-ended NUMERIC range and rejects an inverted one", () => {
    expect(validateQuestionConfig("NUMERIC", {}).ok).toBe(true);
    expect(validateQuestionConfig("NUMERIC", { minValue: 0, maxValue: 10 }).ok).toBe(true);
    expect(validateQuestionConfig("NUMERIC", { minValue: 10, maxValue: 0 }).ok).toBe(false);
  });

  it("applies FREE_TEXT defaults", () => {
    const result = validateQuestionConfig("FREE_TEXT", {});
    expect(result).toEqual({ ok: true, config: { maxLength: 1000, multiline: true } });
  });

  it("reports field-level errors for every type when the input is malformed", () => {
    for (const type of QUESTION_TYPES) {
      const result = validateQuestionConfig(type, { minValue: "not a number" });
      // SINGLE_CHOICE is `.strict()` with no fields at all, so an unknown key
      // still fails — every type must reject this malformed input.
      expect(result.ok).toBe(false);
      expect(result.errors?.length).toBeGreaterThan(0);
    }
  });
});
