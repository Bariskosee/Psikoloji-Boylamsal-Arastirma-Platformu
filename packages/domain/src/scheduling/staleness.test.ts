import { describe, expect, it } from "vitest";
import { fixedClock } from "../clock.js";
import {
  DEFAULT_STALENESS_FLOOR_MS,
  classifyStaleness,
  reminderStalenessToleranceMs,
} from "./staleness.js";

const NOW = new Date("2026-08-19T12:00:00.000Z");
const clock = fixedClock(NOW);
const ONE_HOUR = 60 * 60_000;

/** A time `ms` before `NOW`, i.e. work that is `ms` overdue. */
function overdueBy(ms: number): Date {
  return new Date(NOW.getTime() - ms);
}

describe("classifyStaleness", () => {
  it("is not stale for work that is not yet due", () => {
    const decision = classifyStaleness({
      scheduledFor: new Date(NOW.getTime() + 5_000),
      toleranceMs: ONE_HOUR,
      clock,
    });

    expect(decision.stale).toBe(false);
    // Negative rather than clamped: work running ahead of its own schedule is a
    // bug in the caller, and hiding it would make that bug undebuggable.
    expect(decision.ageMs).toBe(-5_000);
  });

  it("is not stale for work due exactly now", () => {
    expect(classifyStaleness({ scheduledFor: NOW, toleranceMs: ONE_HOUR, clock }).stale).toBe(
      false,
    );
  });

  /**
   * The policy reads "older than one reminder interval is suppressed", so one
   * interval late is the last moment that still sends. `>=` would quietly make
   * the documented tolerance exclusive.
   */
  it("is not stale exactly at the tolerance", () => {
    const decision = classifyStaleness({
      scheduledFor: overdueBy(ONE_HOUR),
      toleranceMs: ONE_HOUR,
      clock,
    });

    expect(decision.stale).toBe(false);
    expect(decision.ageMs).toBe(ONE_HOUR);
  });

  it("is stale one millisecond past the tolerance", () => {
    expect(
      classifyStaleness({ scheduledFor: overdueBy(ONE_HOUR + 1), toleranceMs: ONE_HOUR, clock })
        .stale,
    ).toBe(true);
  });

  /**
   * The case ADR-005 exists for, and the property that makes the guard worth
   * having: a six-hour outage ends and the sweepers correctly find six hourly
   * reminders that were owed. Sending all six would light up a participant's
   * phone six times at an hour nobody chose.
   *
   * The tolerance collapses the backlog to the most recent one — the only one
   * still close enough to the moment the researcher intended. The participant
   * gets a single nudge, and the five that were genuinely missed are recorded
   * as suppressed rather than sent late or silently dropped.
   */
  it("collapses an outage backlog to the single most recent notification", () => {
    const tolerance = reminderStalenessToleranceMs(ONE_HOUR);
    const owed = [1, 2, 3, 4, 5, 6].map((hours) => overdueBy(hours * ONE_HOUR));

    const decisions = owed.map((scheduledFor) =>
      classifyStaleness({ scheduledFor, toleranceMs: tolerance, clock }),
    );

    expect(decisions.filter((decision) => !decision.stale)).toHaveLength(1);
    expect(decisions[0]?.stale).toBe(false);
    expect(decisions.slice(1).every((decision) => decision.stale)).toBe(true);
  });

  it("reports the tolerance it judged against, so the suppression can say why", () => {
    const decision = classifyStaleness({
      scheduledFor: overdueBy(2 * ONE_HOUR),
      toleranceMs: ONE_HOUR,
      clock,
    });

    expect(decision).toEqual({ stale: true, ageMs: 2 * ONE_HOUR, toleranceMs: ONE_HOUR });
  });

  it("treats any lateness as stale when the tolerance is zero", () => {
    expect(classifyStaleness({ scheduledFor: overdueBy(1), toleranceMs: 0, clock }).stale).toBe(
      true,
    );
  });

  it("refuses an invalid scheduledFor", () => {
    expect(() =>
      classifyStaleness({ scheduledFor: new Date("nonsense"), toleranceMs: ONE_HOUR, clock }),
    ).toThrow(TypeError);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])(
    "refuses a toleranceMs of %s",
    (toleranceMs) => {
      expect(() => classifyStaleness({ scheduledFor: NOW, toleranceMs, clock })).toThrow(
        RangeError,
      );
    },
  );
});

describe("reminderStalenessToleranceMs", () => {
  it("uses the reminder interval when it is longer than the floor", () => {
    expect(reminderStalenessToleranceMs(6 * ONE_HOUR)).toBe(6 * ONE_HOUR);
  });

  /**
   * A "notify once, never chase" policy still carries an interval, and it may
   * be zero. Without the floor the tolerance would collapse to zero and an
   * initial notification delayed by a two-second deploy would be suppressed —
   * the guard firing on ordinary jitter rather than on an outage.
   */
  it("falls back to the floor for a policy whose interval is meaningless", () => {
    expect(reminderStalenessToleranceMs(0)).toBe(DEFAULT_STALENESS_FLOOR_MS);
  });

  it("raises a short interval to the floor", () => {
    expect(reminderStalenessToleranceMs(60_000)).toBe(DEFAULT_STALENESS_FLOOR_MS);
  });

  it("honours a caller-supplied floor", () => {
    expect(reminderStalenessToleranceMs(1_000, 5_000)).toBe(5_000);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])(
    "refuses a reminder interval of %s",
    (interval) => {
      expect(() => reminderStalenessToleranceMs(interval)).toThrow(RangeError);
    },
  );

  it("refuses a negative floor", () => {
    expect(() => reminderStalenessToleranceMs(1_000, -1)).toThrow(RangeError);
  });
});
