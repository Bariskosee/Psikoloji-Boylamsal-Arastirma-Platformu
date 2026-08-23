import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { axe } from "vitest-axe";
import type { RuntimeQuestion } from "@lpr/contracts";
import messages from "@lpr/i18n/messages/en.json";
import { EMPTY_ANSWER, QuestionInput } from "./QuestionInput";

afterEach(cleanup);

/**
 * Automated accessibility checks on the one screen a participant must use
 * (PLAN.md Phase 12, NFR-15).
 *
 * ── Why this component and not the researcher dashboard ─────────────────────
 * A researcher who hits an accessibility problem can email somebody. A
 * participant cannot: they are alone with a phone inside a time-limited window,
 * and a question they cannot perceive is not an inconvenience, it is a missing
 * data point that the export will later have to classify. This is the surface
 * where an accessibility defect turns directly into research damage.
 *
 * ── What axe can and cannot tell us ─────────────────────────────────────────
 * axe finds violations of things that are mechanically checkable: an input with
 * no accessible name, a control with no role, a group with no label. It cannot
 * tell whether the resulting announcement makes SENSE to somebody who cannot
 * see the screen. PLAN.md asks for a screen-reader pass on real hardware for
 * that, and this file does not substitute for it.
 */

let counter = 0;
function question(overrides: Partial<RuntimeQuestion> = {}): RuntimeQuestion {
  counter += 1;
  return {
    id: `00000000-0000-4000-8000-00000000000${counter}`,
    questionKey: `q_${String(counter)}`,
    type: "FREE_TEXT",
    text: "How rested do you feel right now?",
    isRequired: true,
    pageIndex: 0,
    displayOrder: 0,
    config: {},
    options: [],
    ...overrides,
  } as RuntimeQuestion;
}

const OPTIONS = [
  { id: "opt-1", optionKey: "a", label: "Not at all", displayOrder: 0, isExclusive: false },
  { id: "opt-2", optionKey: "b", label: "Somewhat", displayOrder: 1, isExclusive: false },
  { id: "opt-3", optionKey: "c", label: "Prefer not to say", displayOrder: 2, isExclusive: true },
];

/**
 * Rendered the way the session page renders it: the question text is a real
 * element with an id, and that id is what names the control.
 *
 * Testing the component stripped of that context would test a situation no
 * participant is ever in, and would pass while the real screen failed.
 */
function renderQuestion(q: RuntimeQuestion) {
  const labelId = `${q.id}-label`;
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <main>
        <p id={labelId}>{q.text}</p>
        <QuestionInput
          question={q}
          labelledBy={labelId}
          value={EMPTY_ANSWER}
          disabled={false}
          onChange={() => undefined}
        />
      </main>
    </NextIntlClientProvider>,
  );
}

const TYPES: { name: string; q: RuntimeQuestion }[] = [
  { name: "FREE_TEXT", q: question({ type: "FREE_TEXT" }) },
  { name: "NUMERIC", q: question({ type: "NUMERIC", config: { minValue: 0, maxValue: 10 } }) },
  {
    name: "LIKERT",
    q: question({
      type: "LIKERT",
      config: { minValue: 1, maxValue: 5, minLabel: "Not at all", maxLabel: "Extremely" },
    }),
  },
  { name: "SINGLE_CHOICE", q: question({ type: "SINGLE_CHOICE", options: OPTIONS }) },
  { name: "MULTI_CHOICE", q: question({ type: "MULTI_CHOICE", options: OPTIONS }) },
];

/**
 * Colour contrast is switched OFF here, deliberately and with a replacement.
 *
 * axe computes contrast by rasterising text, and jsdom has no canvas — the rule
 * cannot run. Left enabled it does not fail, it SKIPS, which is worse than
 * absent: the suite reports a contrast check that never happened. It is
 * disabled explicitly so nobody reads a green run as evidence, and the palette
 * is checked arithmetically in `contrast.test.ts` instead.
 */
const AXE_OPTIONS = { rules: { "color-contrast": { enabled: false } } };

describe("participant question accessibility", () => {
  it.each(TYPES)("$name has no automatically detectable violations", async ({ q }) => {
    const { container } = renderQuestion(q);

    const results = await axe(container, AXE_OPTIONS);

    expect(results.violations).toEqual([]);
  });

  /**
   * The specific failure axe was catching before this was fixed: a numeric or
   * free-text answer box whose only description was a placeholder.
   *
   * A placeholder is not an accessible name. It disappears the moment the
   * participant types, several screen readers do not announce it at all, and
   * the ones that do announce it as a value rather than as a label. The
   * participant hears "edit text, blank" and has to remember which question
   * they are on.
   */
  it.each([
    ["FREE_TEXT", question({ type: "FREE_TEXT" })],
    ["NUMERIC", question({ type: "NUMERIC" })],
  ] as const)("%s names its control from the question text, not a placeholder", (_name, q) => {
    const { container } = renderQuestion(q);
    const control = container.querySelector("input, textarea");

    expect(control?.getAttribute("aria-labelledby")).toBe(`${q.id}-label`);
  });

  /**
   * A choice question is a GROUP, and the group must carry the question.
   *
   * Without it, a participant who arrows onto the third radio hears only
   * "Somewhat" — a word with no question attached. They can answer the wrong
   * item without ever knowing, and nothing downstream can detect that it
   * happened.
   */
  it.each([
    ["SINGLE_CHOICE", "radiogroup"],
    ["MULTI_CHOICE", "group"],
  ] as const)("%s exposes its options as a labelled %s", (type, role) => {
    const q = question({ type, options: OPTIONS } as Partial<RuntimeQuestion>);
    const { container } = renderQuestion(q);
    const group = container.querySelector(`[role="${role}"]`);

    expect(group).not.toBeNull();
    expect(group?.getAttribute("aria-labelledby")).toBe(`${q.id}-label`);
  });

  /**
   * Every tappable row is at least the platform minimum.
   *
   * A 20px radio on a phone is missed by anyone whose hands are unsteady, and
   * repeated missed taps in a short response window are exactly how a
   * participant gives up on a session.
   */
  it("gives every option row a touch target of at least 44px", () => {
    const { container } = renderQuestion(question({ type: "SINGLE_CHOICE", options: OPTIONS }));

    const rows = container.querySelectorAll("label");
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(Number.parseInt((row as HTMLElement).style.minHeight, 10)).toBeGreaterThanOrEqual(44);
    }
  });
});
