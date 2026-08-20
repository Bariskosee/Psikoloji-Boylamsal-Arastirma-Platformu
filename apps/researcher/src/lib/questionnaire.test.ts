import { describe, expect, it } from "vitest";
import type { QuestionResponse } from "@lpr/contracts";
import { defaultConfigFor, groupByPage, localizedText, moveItem } from "./questionnaire";

function question(overrides: Partial<QuestionResponse> = {}): QuestionResponse {
  return {
    id: overrides.id ?? "00000000-0000-4000-8000-000000000001",
    questionKey: "q_abcdefghij",
    type: "FREE_TEXT",
    isRequired: true,
    pageIndex: 0,
    displayOrder: 0,
    config: { maxLength: 1000, multiline: true },
    translations: { en: "Sample question" },
    options: [],
    ...overrides,
  } as QuestionResponse;
}

describe("groupByPage", () => {
  it("groups by pageIndex and orders the pages ascending", () => {
    const pages = groupByPage([
      question({ id: "a", pageIndex: 2 }),
      question({ id: "b", pageIndex: 0 }),
      question({ id: "c", pageIndex: 2 }),
    ]);

    expect(pages.map((page) => page.pageIndex)).toEqual([0, 2]);
    expect(pages[1]!.questions.map((q) => q.id)).toEqual(["a", "c"]);
  });

  it("preserves the server's order within a page", () => {
    const pages = groupByPage([
      question({ id: "second", displayOrder: 1 }),
      question({ id: "first", displayOrder: 0 }),
    ]);
    // Deliberately NOT re-sorted: the array arrives ordered by display_order
    // and re-sorting here would silently mask a server-side ordering bug.
    expect(pages[0]!.questions.map((q) => q.id)).toEqual(["second", "first"]);
  });

  it("returns no pages for an empty questionnaire", () => {
    expect(groupByPage([])).toEqual([]);
  });
});

describe("moveItem", () => {
  it("moves an item forward and backward", () => {
    expect(moveItem(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
    expect(moveItem(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
  });

  it("is a no-op for an unchanged or out-of-range move", () => {
    expect(moveItem(["a", "b"], 1, 1)).toEqual(["a", "b"]);
    expect(moveItem(["a", "b"], 5, 0)).toEqual(["a", "b"]);
    expect(moveItem(["a", "b"], 0, -1)).toEqual(["a", "b"]);
  });

  it("never mutates its input", () => {
    const original = ["a", "b", "c"];
    moveItem(original, 0, 2);
    expect(original).toEqual(["a", "b", "c"]);
  });
});

describe("defaultConfigFor", () => {
  it("matches the contract's defaults for every type", () => {
    expect(defaultConfigFor("LIKERT")).toEqual({
      minValue: 1,
      maxValue: 5,
      minLabel: "",
      maxLabel: "",
    });
    expect(defaultConfigFor("FREE_TEXT")).toEqual({ maxLength: 1000, multiline: true });
    expect(defaultConfigFor("NUMERIC")).toEqual({ minValue: null, maxValue: null, step: null });
    expect(defaultConfigFor("MULTI_CHOICE")).toEqual({ minSelections: 0, maxSelections: null });
    expect(defaultConfigFor("SINGLE_CHOICE")).toEqual({});
  });
});

describe("localizedText", () => {
  it("prefers the requested locale", () => {
    expect(localizedText({ en: "English", tr: "Türkçe" }, "tr")).toEqual({
      text: "Türkçe",
      isFallback: false,
    });
  });

  it("falls back to a locale that is filled in, and says so", () => {
    expect(localizedText({ tr: "Türkçe" }, "en")).toEqual({ text: "Türkçe", isFallback: true });
  });

  it("returns null when nothing is translated", () => {
    expect(localizedText({}, "en")).toBeNull();
  });
});
