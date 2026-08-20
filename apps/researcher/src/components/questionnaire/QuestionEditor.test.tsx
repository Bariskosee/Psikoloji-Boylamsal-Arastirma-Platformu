import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { QuestionResponse } from "@lpr/contracts";
import { QuestionEditor } from "./QuestionEditor";
import { withIntl } from "./test-intl";

/**
 * The editor writes straight through to the API and asks the parent to
 * reload — it holds no copy of the draft. So what is worth testing is the
 * REQUEST each control produces: the path, the verb, and the body. A control
 * that silently sends the wrong field looks identical on screen to one that
 * works, and only shows up as a researcher's edit that never took.
 */
vi.mock("@/lib/api", () => ({
  api: {
    get: vi.fn(),
    post: vi.fn().mockResolvedValue({}),
    patch: vi.fn().mockResolvedValue({}),
    put: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
  },
  ApiError: class ApiError extends Error {},
}));

const { api } = await import("@/lib/api");

const BASE = "/api/studies/s1/questionnaires/q1";
const QUESTION_ID = "00000000-0000-4000-8000-000000000001";

beforeEach(() => {
  vi.mocked(api.patch).mockClear();
  vi.mocked(api.post).mockClear();
  vi.mocked(api.put).mockClear();
  vi.mocked(api.delete).mockClear();
});

afterEach(cleanup);

function question(overrides: Partial<QuestionResponse> = {}): QuestionResponse {
  return {
    id: QUESTION_ID,
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

function renderEditor(overrides: Partial<QuestionResponse> = {}, disabled = false) {
  const onChanged = vi.fn();
  const onError = vi.fn();
  render(
    withIntl(
      <QuestionEditor
        question={question(overrides)}
        basePath={BASE}
        locales={["en", "tr"]}
        disabled={disabled}
        onChanged={onChanged}
        onError={onError}
      />,
    ),
  );
  return { onChanged, onError };
}

const OPTIONS = [
  {
    id: "opt-a",
    optionKey: "o_aaaaaaaaaa",
    displayOrder: 0,
    valueNumber: null,
    isExclusive: false,
    translations: { en: "Sample option A" },
  },
  {
    id: "opt-b",
    optionKey: "o_bbbbbbbbbb",
    displayOrder: 1,
    valueNumber: null,
    isExclusive: false,
    translations: { en: "Sample option B" },
  },
];

describe("question fields", () => {
  it("toggles required through PATCH and reloads", async () => {
    const { onChanged } = renderEditor();

    fireEvent.click(screen.getByRole("checkbox", { name: /Required/i }));

    expect(api.patch).toHaveBeenCalledWith(`${BASE}/questions/${QUESTION_ID}`, {
      isRequired: false,
    });
    await vi.waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("sends a 0-based pageIndex from the 1-based field the researcher sees", () => {
    renderEditor({ pageIndex: 0 });
    fireEvent.change(screen.getByRole("spinbutton", { name: /Page/i }), {
      target: { value: "3" },
    });
    expect(api.patch).toHaveBeenCalledWith(`${BASE}/questions/${QUESTION_ID}`, { pageIndex: 2 });
  });

  it("ignores a page number below one instead of sending a negative index", () => {
    renderEditor();
    const field = screen.getByRole("spinbutton", { name: /Page/i });
    fireEvent.change(field, { target: { value: "0" } });
    fireEvent.change(field, { target: { value: "" } });
    expect(api.patch).not.toHaveBeenCalled();
  });

  it("commits question text on blur, not on every keystroke", () => {
    renderEditor();
    const field = screen.getByLabelText(/Question text \(EN\)/i);

    fireEvent.change(field, { target: { value: "Rewritten" } });
    expect(api.patch).not.toHaveBeenCalled();

    fireEvent.blur(field);
    expect(api.patch).toHaveBeenCalledWith(`${BASE}/questions/${QUESTION_ID}`, {
      translations: { en: "Rewritten" },
    });
  });

  it("does not send an empty translation, which the contract would reject", () => {
    renderEditor();
    const field = screen.getByLabelText(/Question text \(EN\)/i);
    fireEvent.change(field, { target: { value: "   " } });
    fireEvent.blur(field);
    expect(api.patch).not.toHaveBeenCalled();
  });

  it("offers one text field per study language", () => {
    renderEditor();
    expect(screen.getByLabelText(/Question text \(EN\)/i)).toBeTruthy();
    expect(screen.getByLabelText(/Question text \(TR\)/i)).toBeTruthy();
  });

  it("disables every control when the viewer cannot edit", () => {
    renderEditor({ type: "SINGLE_CHOICE", config: {}, options: OPTIONS }, true);

    // Asserted as `disabled`, not by firing a click and expecting silence:
    // `fireEvent` dispatches straight to the handler and would sail past a
    // disabled attribute that a real pointer cannot. Disabling is presentation
    // in any case — the server re-checks `questionnaire:edit` on every write.
    for (const control of [
      ...screen.getAllByRole("checkbox"),
      ...screen.getAllByRole("textbox"),
      ...screen.getAllByRole("spinbutton"),
      ...screen.getAllByRole("button"),
    ]) {
      expect((control as HTMLInputElement).disabled).toBe(true);
    }
  });
});

describe("per-type config panels", () => {
  it("sends the WHOLE config, not just the changed field", () => {
    renderEditor({
      type: "LIKERT",
      config: { minValue: 1, maxValue: 5, minLabel: "", maxLabel: "" },
    });

    const field = screen.getByLabelText("Highest value");
    fireEvent.change(field, { target: { value: "7" } });
    fireEvent.blur(field);

    // A partial config would fail the server's per-type schema.
    expect(api.patch).toHaveBeenCalledWith(`${BASE}/questions/${QUESTION_ID}`, {
      config: { minValue: 1, maxValue: 7, minLabel: "", maxLabel: "" },
    });
  });

  it("clears a nullable numeric bound to null rather than to zero", () => {
    renderEditor({ type: "NUMERIC", config: { minValue: 3, maxValue: null, step: null } });

    const field = screen.getByLabelText("Lowest value");
    fireEvent.change(field, { target: { value: "" } });
    fireEvent.blur(field);

    expect(api.patch).toHaveBeenCalledWith(`${BASE}/questions/${QUESTION_ID}`, {
      config: { minValue: null, maxValue: null, step: null },
    });
  });

  it("shows no config panel for single choice, which has none", () => {
    renderEditor({ type: "SINGLE_CHOICE", config: {}, options: OPTIONS });
    expect(screen.queryByLabelText("Highest value")).toBeNull();
  });
});

describe("options", () => {
  it("warns while a choice question has fewer than two options", () => {
    renderEditor({ type: "SINGLE_CHOICE", config: {}, options: [OPTIONS[0]!] });
    expect(screen.getByRole("status").textContent).toMatch(/at least two options/i);
  });

  it("drops the warning once there are two", () => {
    renderEditor({ type: "SINGLE_CHOICE", config: {}, options: OPTIONS });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("sends a full permutation when an option is moved", () => {
    renderEditor({ type: "SINGLE_CHOICE", config: {}, options: OPTIONS });
    fireEvent.click(screen.getAllByRole("button", { name: /Move down/i })[0]!);

    expect(api.put).toHaveBeenCalledWith(`${BASE}/questions/${QUESTION_ID}/options/order`, {
      optionIds: ["opt-b", "opt-a"],
    });
  });

  it("cannot move the first option up or the last one down", () => {
    renderEditor({ type: "SINGLE_CHOICE", config: {}, options: OPTIONS });
    const up = screen.getAllByRole("button", { name: /Move up/i });
    const down = screen.getAllByRole("button", { name: /Move down/i });

    expect((up[0] as HTMLButtonElement).disabled).toBe(true);
    expect((down[1] as HTMLButtonElement).disabled).toBe(true);
  });

  it("sends an option's numeric value, and null when it is cleared", () => {
    renderEditor({
      type: "SINGLE_CHOICE",
      config: {},
      options: [{ ...OPTIONS[0]!, valueNumber: 2 }, OPTIONS[1]!],
    });

    const field = screen.getAllByLabelText(/Numeric value/i)[0]!;
    fireEvent.change(field, { target: { value: "" } });
    fireEvent.blur(field);

    expect(api.patch).toHaveBeenCalledWith(`${BASE}/questions/${QUESTION_ID}/options/opt-a`, {
      valueNumber: null,
    });
  });

  it("offers the exclusive flag on multi-choice and withholds it on single choice", () => {
    renderEditor({
      type: "MULTI_CHOICE",
      config: { minSelections: 0, maxSelections: null },
      options: OPTIONS,
    });
    const multi = screen.getAllByRole("checkbox", { name: /Exclusive/i });
    expect((multi[0] as HTMLInputElement).disabled).toBe(false);

    fireEvent.click(multi[0]!);
    expect(api.patch).toHaveBeenCalledWith(`${BASE}/questions/${QUESTION_ID}/options/opt-a`, {
      isExclusive: true,
    });

    cleanup();

    // "Clears every other selection" is meaningless where only one selection
    // is possible, so the control is present but inert.
    renderEditor({ type: "SINGLE_CHOICE", config: {}, options: OPTIONS });
    const single = screen.getAllByRole("checkbox", { name: /Exclusive/i });
    expect((single[0] as HTMLInputElement).disabled).toBe(true);
  });

  it("deletes an option by id", () => {
    renderEditor({ type: "SINGLE_CHOICE", config: {}, options: OPTIONS });
    fireEvent.click(screen.getAllByRole("button", { name: /^Remove$/i })[0]!);
    expect(api.delete).toHaveBeenCalledWith(`${BASE}/questions/${QUESTION_ID}/options/opt-a`);
  });

  it("creates a new option with placeholder text in every language", () => {
    renderEditor({ type: "SINGLE_CHOICE", config: {}, options: OPTIONS });
    fireEvent.click(screen.getByRole("button", { name: /Add an option/i }));

    expect(api.post).toHaveBeenCalledWith(`${BASE}/questions/${QUESTION_ID}/options`, {
      translations: { en: "Sample option", tr: "Sample option" },
    });
  });

  it("shows no option editor for a type that has no options", () => {
    renderEditor({ type: "FREE_TEXT" });
    expect(screen.queryByRole("button", { name: /Add an option/i })).toBeNull();
  });

  it("reports a failed write to the parent instead of failing silently", async () => {
    vi.mocked(api.patch).mockRejectedValueOnce(new Error("boom"));
    const { onError } = renderEditor();

    fireEvent.click(screen.getByRole("checkbox", { name: /Required/i }));
    await vi.waitFor(() => expect(onError).toHaveBeenCalled());
  });
});
