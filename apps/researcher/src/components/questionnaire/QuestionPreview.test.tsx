import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { QuestionResponse, QuestionnaireVersionDetail } from "@lpr/contracts";
import { PreviewPane } from "./PreviewPane";
import { QuestionPreview, likertPoints } from "./QuestionPreview";

afterEach(cleanup);

const LABELS = {
  empty: "No questions yet.",
  page: "Page",
  of: "of",
  previous: "Previous",
  next: "Next",
  required: "Required",
  untranslated: "Not translated yet",
  submit: "Submit",
};

let counter = 0;
function question(overrides: Partial<QuestionResponse> = {}): QuestionResponse {
  counter += 1;
  return {
    id: `00000000-0000-4000-8000-00000000000${counter}`,
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

function renderQuestion(overrides: Partial<QuestionResponse> = {}) {
  return render(
    <ul>
      <QuestionPreview
        question={question(overrides)}
        locale="en"
        index={1}
        requiredLabel={LABELS.required}
        untranslatedLabel={LABELS.untranslated}
      />
    </ul>,
  );
}

/**
 * PLAN.md Phase 3, "Security considerations": a script payload entered as
 * question text must render as LITERAL TEXT in the builder preview.
 *
 * This is the whole defence for researcher-entered content, and it is a
 * defence by construction — React escapes interpolated children, and no
 * component in the builder uses `dangerouslySetInnerHTML`. The test exists so
 * that a future "just render the markdown" change fails loudly instead of
 * quietly turning a questionnaire into an injection vector for every
 * participant assigned to it.
 */
describe("stored XSS", () => {
  const payload = "<script>alert('xss')</script>";

  it("renders a script payload in question text as visible characters", () => {
    const { container } = renderQuestion({ translations: { en: payload } });

    expect(screen.getByText(payload, { exact: false })).toBeTruthy();
    expect(container.querySelector("script")).toBeNull();
    expect(container.innerHTML).toContain("&lt;script&gt;");
  });

  it("renders a script payload in an option label as visible characters", () => {
    const { container } = renderQuestion({
      type: "SINGLE_CHOICE",
      config: {},
      options: [
        {
          id: "opt-1",
          optionKey: "o_abcdefghij",
          displayOrder: 0,
          valueNumber: null,
          isExclusive: false,
          translations: { en: payload },
        },
      ],
    });

    expect(screen.getByText(payload)).toBeTruthy();
    expect(container.querySelector("script")).toBeNull();
  });

  it("renders an img/onerror payload as text, not as an element", () => {
    const { container } = renderQuestion({
      translations: { en: '<img src=x onerror="alert(1)">' },
    });
    expect(container.querySelector("img")).toBeNull();
  });
});

describe("question rendering", () => {
  it("renders radio inputs for a single-choice question and checkboxes for multi", () => {
    const options = [
      {
        id: "a",
        optionKey: "o_aaaaaaaaaa",
        displayOrder: 0,
        valueNumber: null,
        isExclusive: false,
        translations: { en: "Sample option A" },
      },
      {
        id: "b",
        optionKey: "o_bbbbbbbbbb",
        displayOrder: 1,
        valueNumber: null,
        isExclusive: false,
        translations: { en: "Sample option B" },
      },
    ];

    const single = renderQuestion({ type: "SINGLE_CHOICE", config: {}, options });
    expect(single.container.querySelectorAll('input[type="radio"]')).toHaveLength(2);
    cleanup();

    const multi = renderQuestion({
      type: "MULTI_CHOICE",
      config: { minSelections: 0, maxSelections: null },
      options,
    });
    expect(multi.container.querySelectorAll('input[type="checkbox"]')).toHaveLength(2);
  });

  it("renders one Likert point per value, inclusive of both bounds", () => {
    const { container } = renderQuestion({
      type: "LIKERT",
      config: { minValue: 1, maxValue: 7, minLabel: "Never", maxLabel: "Always" },
    });
    expect(container.querySelectorAll('input[type="radio"]')).toHaveLength(7);
    expect(screen.getByText("Never")).toBeTruthy();
    expect(screen.getByText("Always")).toBeTruthy();
  });

  it("carries the numeric bounds onto the input", () => {
    const { container } = renderQuestion({
      type: "NUMERIC",
      config: { minValue: 0, maxValue: 10, step: 0.5 },
    });
    const input = container.querySelector('input[type="number"]');
    expect(input?.getAttribute("min")).toBe("0");
    expect(input?.getAttribute("max")).toBe("10");
    expect(input?.getAttribute("step")).toBe("0.5");
  });

  it("uses a single-line input when free text is not multiline", () => {
    const { container } = renderQuestion({
      type: "FREE_TEXT",
      config: { maxLength: 40, multiline: false },
    });
    expect(container.querySelector("textarea")).toBeNull();
    expect(container.querySelector('input[type="text"]')?.getAttribute("maxlength")).toBe("40");
  });

  it("leaves every control disabled — the preview must not look answerable", () => {
    const { container } = renderQuestion({
      type: "LIKERT",
      config: { minValue: 1, maxValue: 5, minLabel: "", maxLabel: "" },
    });
    const enabled = [...container.querySelectorAll("input")].filter((input) => !input.disabled);
    expect(enabled).toEqual([]);
  });

  it("falls back to another language rather than showing an empty question", () => {
    renderQuestion({ translations: { tr: "Örnek soru" } });
    expect(screen.getByText("Örnek soru", { exact: false })).toBeTruthy();
  });

  it("says so when a question has no translation at all", () => {
    renderQuestion({ translations: {} });
    expect(screen.getByText(LABELS.untranslated)).toBeTruthy();
  });
});

describe("likertPoints", () => {
  it("includes both bounds", () => {
    expect(likertPoints({ minValue: 1, maxValue: 5 })).toEqual([1, 2, 3, 4, 5]);
    expect(likertPoints({ minValue: 0, maxValue: 0 })).toEqual([0]);
    expect(likertPoints({ minValue: -2, maxValue: 2 })).toEqual([-2, -1, 0, 1, 2]);
  });

  it("caps a pathological range instead of rendering hundreds of controls", () => {
    expect(likertPoints({ minValue: -100, maxValue: 100 })).toHaveLength(21);
  });
});

describe("PreviewPane", () => {
  function version(questions: QuestionResponse[]): QuestionnaireVersionDetail {
    return {
      id: "v1",
      questionnaireId: "q1",
      status: "DRAFT",
      versionNumber: null,
      questionCount: questions.length,
      publishedAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      questions,
    } as QuestionnaireVersionDetail;
  }

  it("shows only the current page's questions", () => {
    render(
      <PreviewPane
        version={version([
          question({ pageIndex: 0, translations: { en: "First page question" } }),
          question({ pageIndex: 1, translations: { en: "Second page question" } }),
        ])}
        locale="en"
        labels={LABELS}
      />,
    );

    expect(screen.getByText("First page question", { exact: false })).toBeTruthy();
    expect(screen.queryByText("Second page question", { exact: false })).toBeNull();
    expect(screen.getByText("Page 1 of 2")).toBeTruthy();
  });

  it("pages forward to the next group", () => {
    render(
      <PreviewPane
        version={version([
          question({ pageIndex: 0, translations: { en: "First page question" } }),
          question({ pageIndex: 3, translations: { en: "Second page question" } }),
        ])}
        locale="en"
        labels={LABELS}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    expect(screen.getByText("Second page question", { exact: false })).toBeTruthy();
  });

  it("says the questionnaire is empty rather than rendering a blank phone", () => {
    const { container } = render(<PreviewPane version={version([])} locale="en" labels={LABELS} />);
    expect(within(container).getByText(LABELS.empty)).toBeTruthy();
  });
});
