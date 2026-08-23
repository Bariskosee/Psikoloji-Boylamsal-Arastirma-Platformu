import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { axe } from "vitest-axe";
import type { QuestionResponse } from "@lpr/contracts";
import { withIntl } from "./test-intl";
import { QuestionEditor } from "./QuestionEditor";

vi.mock("@/lib/api", () => ({
  api: {
    get: vi.fn(),
    post: vi.fn().mockResolvedValue({}),
    patch: vi.fn().mockResolvedValue({}),
    put: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
  },
}));

afterEach(cleanup);

/**
 * Automated accessibility checks on the researcher's densest screen
 * (PLAN.md Phase 12, NFR-15).
 *
 * ── Why the question editor, of everything on the dashboard ─────────────────
 * It is the screen with the most controls per square inch, the most controls
 * that appear and disappear as the question type changes, and the most inputs
 * whose meaning depends entirely on their label. Those three properties are
 * where unlabelled controls actually come from — nobody forgets the label on a
 * lone text box, they forget it on the fourth conditional field of a variant
 * they were not thinking about.
 *
 * Contrast is disabled for the same reason as in the participant suite: axe
 * needs a canvas to compute it, jsdom has none, and the rule SKIPS rather than
 * failing. The palette is checked arithmetically in `@lpr/ui`.
 */
const AXE_OPTIONS = { rules: { "color-contrast": { enabled: false } } };

const BASE = "/api/studies/s/questionnaires/q/versions/v";

function question(overrides: Partial<QuestionResponse> = {}): QuestionResponse {
  return {
    id: "00000000-0000-4000-8000-000000000001",
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

const OPTIONS = [
  {
    id: "opt-a",
    optionKey: "o_aaaaaaaaaa",
    displayOrder: 0,
    valueNumber: 1,
    isExclusive: false,
    translations: { en: "Sample option A" },
  },
  {
    id: "opt-b",
    optionKey: "o_bbbbbbbbbb",
    displayOrder: 1,
    valueNumber: 2,
    isExclusive: true,
    translations: { en: "Sample option B" },
  },
];

/**
 * Every question type, because the editor renders a DIFFERENT set of controls
 * for each. Testing one type would leave the other four unexamined while
 * reporting a green accessibility check.
 */
const TYPES: QuestionResponse["type"][] = [
  "FREE_TEXT",
  "NUMERIC",
  "LIKERT",
  "SINGLE_CHOICE",
  "MULTI_CHOICE",
];

describe("question editor accessibility", () => {
  it.each(TYPES)("%s has no automatically detectable violations", async (type) => {
    const { container } = render(
      withIntl(
        <QuestionEditor
          question={question({
            type,
            options: type === "SINGLE_CHOICE" || type === "MULTI_CHOICE" ? OPTIONS : [],
            config:
              type === "LIKERT"
                ? { minValue: 1, maxValue: 5 }
                : type === "NUMERIC"
                  ? { minValue: 0, maxValue: 10 }
                  : { maxLength: 1000, multiline: true },
          })}
          basePath={BASE}
          locales={["en", "tr"]}
          disabled={false}
          onChanged={vi.fn()}
          onError={vi.fn()}
        />,
      ),
    );

    const results = await axe(container, AXE_OPTIONS);

    expect(results.violations).toEqual([]);
  });

  /**
   * The disabled state is a separate render path, and it is the one a VIEWER
   * sees. A control that loses its label when disabled is invisible to review
   * precisely because the person reviewing usually has edit rights.
   */
  it("has no violations when the editor is read-only", async () => {
    const { container } = render(
      withIntl(
        <QuestionEditor
          question={question({ type: "SINGLE_CHOICE", options: OPTIONS })}
          basePath={BASE}
          locales={["en", "tr"]}
          disabled
          onChanged={vi.fn()}
          onError={vi.fn()}
        />,
      ),
    );

    const results = await axe(container, AXE_OPTIONS);

    expect(results.violations).toEqual([]);
  });
});
