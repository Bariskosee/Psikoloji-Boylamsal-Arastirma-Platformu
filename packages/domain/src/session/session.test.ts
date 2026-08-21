import { describe, expect, it } from "vitest";
import {
  canComplete,
  canWriteAnswer,
  expiryOutcome,
  isTerminal,
  SESSION_STATUSES,
  type SessionStatus,
  type SessionWindow,
} from "./state-machine.js";
import {
  countsAsAnswered,
  decideRevision,
  validateAnswer,
  type AnsweredQuestion,
} from "./answer-validation.js";

const OPEN_FROM = new Date("2026-09-07T17:00:00Z");
const OPEN_UNTIL = new Date("2026-09-08T05:00:00Z");
const INSIDE = new Date("2026-09-07T20:00:00Z");

const session = (overrides: Partial<SessionWindow> = {}): SessionWindow => ({
  status: "AVAILABLE",
  availableFrom: OPEN_FROM,
  availableUntil: OPEN_UNTIL,
  ...overrides,
});

describe("writing an answer", () => {
  it("is allowed inside the window and starts the session", () => {
    // STARTED is what separates "offered and ignored" from "opened and
    // abandoned" — two different facts in the compliance denominator.
    expect(canWriteAnswer(session(), INSIDE)).toEqual({ allowed: true, transitionTo: "STARTED" });
  });

  it("does not re-transition a session that is already started", () => {
    expect(canWriteAnswer(session({ status: "STARTED" }), INSIDE)).toEqual({
      allowed: true,
      transitionTo: null,
    });
  });

  it("refuses before the window opens", () => {
    expect(canWriteAnswer(session(), new Date("2026-09-07T16:59:59Z"))).toEqual({
      allowed: false,
      reason: "NOT_YET_AVAILABLE",
    });
  });

  it("refuses at the instant the window closes, not a moment later", () => {
    expect(canWriteAnswer(session(), OPEN_UNTIL)).toEqual({
      allowed: false,
      reason: "WINDOW_CLOSED",
    });
  });

  it("refuses a session still waiting on its trigger", () => {
    expect(canWriteAnswer(session({ status: "PENDING_TRIGGER" }), INSIDE).allowed).toBe(false);
  });

  it("refuses every terminal state", () => {
    for (const status of [
      "COMPLETED",
      "EXPIRED_UNSTARTED",
      "EXPIRED_PARTIAL",
      "CANCELLED",
    ] as const) {
      expect(canWriteAnswer(session({ status }), INSIDE).allowed).toBe(false);
    }
  });

  /**
   * The guard that makes a response window real. A sweeper may not have
   * relabelled an expired session yet (ADR-005), so the decision is taken on
   * the stored timestamps rather than on the status.
   */
  it("refuses a still-AVAILABLE session whose window has passed", () => {
    expect(canWriteAnswer(session(), new Date("2026-09-09T00:00:00Z"))).toEqual({
      allowed: false,
      reason: "WINDOW_CLOSED",
    });
  });

  it("classifies exactly four statuses as terminal", () => {
    const terminal = SESSION_STATUSES.filter((status: SessionStatus) => isTerminal(status));
    expect(terminal).toEqual(["COMPLETED", "EXPIRED_UNSTARTED", "EXPIRED_PARTIAL", "CANCELLED"]);
  });
});

describe("completing", () => {
  it("is allowed when every required question is answered", () => {
    expect(
      canComplete(session({ status: "STARTED" }), INSIDE, ["q_a", "q_b"], ["q_a", "q_b"]),
    ).toEqual({ allowed: true });
  });

  it("names the required questions still missing", () => {
    const verdict = canComplete(session({ status: "STARTED" }), INSIDE, ["q_a", "q_b"], ["q_a"]);

    expect(verdict).toEqual({ allowed: false, reason: "REQUIRED_UNANSWERED", missing: ["q_b"] });
  });

  it("ignores optional questions left blank", () => {
    expect(canComplete(session({ status: "STARTED" }), INSIDE, [], []).allowed).toBe(true);
  });

  it("refuses once the window has closed, however complete the answers", () => {
    const verdict = canComplete(session({ status: "STARTED" }), OPEN_UNTIL, ["q_a"], ["q_a"]);

    expect(verdict).toEqual({ allowed: false, reason: "WINDOW_CLOSED" });
  });

  it("refuses a second completion", () => {
    const verdict = canComplete(session({ status: "COMPLETED" }), INSIDE, [], []);

    expect(verdict).toEqual({ allowed: false, reason: "ALREADY_COMPLETED" });
  });
});

describe("expiry", () => {
  it("distinguishes a session nobody opened from one abandoned midway", () => {
    // Collapsing these would hide the difference in every later compliance
    // figure — they say different things about the participant.
    expect(expiryOutcome("AVAILABLE", 0)).toBe("EXPIRED_UNSTARTED");
    expect(expiryOutcome("STARTED", 3)).toBe("EXPIRED_PARTIAL");
  });

  it("treats an AVAILABLE session with answers as partial", () => {
    expect(expiryOutcome("AVAILABLE", 1)).toBe("EXPIRED_PARTIAL");
  });

  it("leaves a terminal session alone", () => {
    expect(expiryOutcome("COMPLETED", 5)).toBeNull();
    expect(expiryOutcome("CANCELLED", 0)).toBeNull();
  });
});

describe("answer validation", () => {
  const question = (overrides: Partial<AnsweredQuestion>): AnsweredQuestion => ({
    type: "SINGLE_CHOICE",
    isRequired: true,
    optionIds: ["opt-1", "opt-2", "opt-3"],
    config: {},
    ...overrides,
  });

  describe("choice questions", () => {
    it("accepts one option of the version shown", () => {
      expect(validateAnswer(question({}), { selectedOptionIds: ["opt-2"] })).toEqual({
        ok: true,
        valueKind: "OPTION",
      });
    });

    it("rejects an option belonging to a different question version", () => {
      // Storing it would record a selection against a question it is not part
      // of, which no analysis could interpret afterwards.
      expect(validateAnswer(question({}), { selectedOptionIds: ["opt-from-elsewhere"] })).toEqual({
        ok: false,
        problem: "OPTION_NOT_IN_QUESTION",
      });
    });

    it("rejects two selections on a single-choice question", () => {
      expect(validateAnswer(question({}), { selectedOptionIds: ["opt-1", "opt-2"] })).toEqual({
        ok: false,
        problem: "TOO_MANY_SELECTIONS",
      });
    });

    it("rejects the same option twice", () => {
      const multi = question({ type: "MULTI_CHOICE" });

      expect(validateAnswer(multi, { selectedOptionIds: ["opt-1", "opt-1"] })).toEqual({
        ok: false,
        problem: "DUPLICATE_OPTION",
      });
    });

    it("enforces the selection bounds of a multi-choice question", () => {
      const multi = question({
        type: "MULTI_CHOICE",
        config: { minSelections: 2, maxSelections: 3 },
      });

      expect(validateAnswer(multi, { selectedOptionIds: ["opt-1"] }).ok).toBe(false);
      expect(validateAnswer(multi, { selectedOptionIds: ["opt-1", "opt-2"] }).ok).toBe(true);
    });

    it("lets a participant clear an answer despite a minimum", () => {
      // Clearing is how an optional question gets un-answered; enforcing the
      // minimum on an empty answer would trap them into answering it.
      const multi = question({ type: "MULTI_CHOICE", config: { minSelections: 2 } });

      expect(validateAnswer(multi, { selectedOptionIds: [] }).ok).toBe(true);
    });

    it("rejects a number where options were expected", () => {
      expect(validateAnswer(question({}), { valueNumber: 3 })).toEqual({
        ok: false,
        problem: "WRONG_VALUE_KIND",
      });
    });
  });

  describe("likert", () => {
    const likert = question({
      type: "LIKERT",
      config: { minValue: 1, maxValue: 5 },
      optionIds: [],
    });

    it("accepts a value on the scale", () => {
      expect(validateAnswer(likert, { valueNumber: 3 })).toEqual({ ok: true, valueKind: "NUMBER" });
    });

    it("rejects a value off the scale", () => {
      expect(validateAnswer(likert, { valueNumber: 6 }).ok).toBe(false);
      expect(validateAnswer(likert, { valueNumber: 0 }).ok).toBe(false);
    });

    it("rejects a fractional point on an integer scale", () => {
      expect(validateAnswer(likert, { valueNumber: 3.5 })).toEqual({
        ok: false,
        problem: "NOT_AN_INTEGER",
      });
    });
  });

  describe("numeric", () => {
    it("enforces the configured bounds", () => {
      const numeric = question({
        type: "NUMERIC",
        config: { minValue: 0, maxValue: 10, step: null },
        optionIds: [],
      });

      expect(validateAnswer(numeric, { valueNumber: 10 }).ok).toBe(true);
      expect(validateAnswer(numeric, { valueNumber: 10.1 }).ok).toBe(false);
    });

    it("accepts a value the rendered control could produce, despite float error", () => {
      // 0.1 + 0.2 lands 4e-17 off. Rejecting that would refuse a value the
      // participant picked from the control we gave them.
      const numeric = question({
        type: "NUMERIC",
        config: { minValue: 0, maxValue: 1, step: 0.1 },
        optionIds: [],
      });

      expect(validateAnswer(numeric, { valueNumber: 0.1 + 0.2 }).ok).toBe(true);
    });

    it("rejects a value between steps", () => {
      const numeric = question({
        type: "NUMERIC",
        config: { minValue: 0, maxValue: 10, step: 5 },
        optionIds: [],
      });

      expect(validateAnswer(numeric, { valueNumber: 3 })).toEqual({
        ok: false,
        problem: "NOT_ON_STEP",
      });
    });

    it("rejects a non-finite value", () => {
      const numeric = question({ type: "NUMERIC", config: {}, optionIds: [] });

      expect(validateAnswer(numeric, { valueNumber: Number.NaN }).ok).toBe(false);
    });
  });

  describe("free text", () => {
    const text = question({ type: "FREE_TEXT", config: { maxLength: 10 }, optionIds: [] });

    it("accepts text within the limit", () => {
      expect(validateAnswer(text, { valueText: "fine" })).toEqual({ ok: true, valueKind: "TEXT" });
    });

    it("rejects text past the limit", () => {
      expect(validateAnswer(text, { valueText: "far too long to fit" })).toEqual({
        ok: false,
        problem: "TOO_LONG",
      });
    });

    it("accepts an empty string, which is how an answer is cleared", () => {
      expect(validateAnswer(text, { valueText: "" }).ok).toBe(true);
    });
  });
});

describe("what counts as answered", () => {
  it("does not count a blank as an answer to a required question", () => {
    // Valid to write, but not a response — conflating the two would either
    // forbid clearing or let a blank satisfy a required question.
    expect(countsAsAnswered("FREE_TEXT", { valueText: "   " })).toBe(false);
    expect(countsAsAnswered("MULTI_CHOICE", { selectedOptionIds: [] })).toBe(false);
    expect(countsAsAnswered("LIKERT", {})).toBe(false);
  });

  it("counts a real answer", () => {
    expect(countsAsAnswered("FREE_TEXT", { valueText: "something" })).toBe(true);
    expect(countsAsAnswered("SINGLE_CHOICE", { selectedOptionIds: ["opt-1"] })).toBe(true);
    expect(countsAsAnswered("NUMERIC", { valueNumber: 0 })).toBe(true);
  });
});

describe("autosave revisions", () => {
  it("applies the first write", () => {
    expect(decideRevision(null, 1)).toBe("APPLY");
  });

  it("applies a newer revision", () => {
    expect(decideRevision(3, 4)).toBe("APPLY");
  });

  it("treats a retry of the same revision as a duplicate, not a conflict", () => {
    // A retried request must be a no-op, not an error the client shows.
    expect(decideRevision(3, 3)).toBe("IGNORE_DUPLICATE");
  });

  it("ignores a stale write rather than resurrecting an old answer", () => {
    // An outbox replaying after the participant corrected the answer must not
    // overwrite the correction.
    expect(decideRevision(5, 2)).toBe("IGNORE_STALE");
  });
});
