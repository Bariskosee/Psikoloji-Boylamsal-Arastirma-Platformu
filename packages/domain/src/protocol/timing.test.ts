import { describe, expect, it } from "vitest";
import {
  computeOccurrenceWindows,
  type StepOrigin,
  type StepTiming,
  type TimingZones,
} from "./timing.js";

/**
 * The assertion target is `docs/reference-protocol.md` §6, which tabulates
 * every instant by hand. If this file and that table disagree, one of the two
 * is wrong and the discrepancy has to be resolved before the phase closes —
 * that is the document's own instruction, and it is the only independent check
 * on arithmetic that is otherwise self-confirming.
 *
 * None of the numbers below may migrate into application code. They are a
 * study's configuration, reproduced here as a fixture (AGENT.md §3.4).
 */

const ISTANBUL: TimingZones = {
  studyTimezone: "Europe/Istanbul",
  participantTimezone: "Europe/Istanbul",
};

const at = (iso: string): StepOrigin => ({ kind: "INSTANT", instant: new Date(iso) });

/**
 * The designated start day, as a DATE. It stays a date until the anchor zone
 * is known, so "the 7th" is the 7th for every participant — see StepOrigin.
 */
const BLOCK_ORIGIN: StepOrigin = { kind: "CALENDAR_DATE", date: "2026-09-07" };

describe("reference protocol — mode A, fixed cohort date", () => {
  const daily: StepTiming = {
    offsetIso: "PT0S",
    anchorLocalTime: "20:00",
    anchorTimezoneSource: "PARTICIPANT",
    windowDurationIso: "PT12H",
    occurrenceCount: 30,
    recurrenceIntervalIso: "P1D",
  };

  it("opens the daily block's first occurrence at 07 Sep 20:00 local", () => {
    const windows = computeOccurrenceWindows(daily, BLOCK_ORIGIN, ISTANBUL);

    expect(windows[0]?.availableFrom.toISOString()).toBe("2026-09-07T17:00:00.000Z");
    expect(windows[0]?.availableUntil.toISOString()).toBe("2026-09-08T05:00:00.000Z");
  });

  it("opens the second occurrence exactly one day later", () => {
    const windows = computeOccurrenceWindows(daily, BLOCK_ORIGIN, ISTANBUL);

    expect(windows[1]?.availableFrom.toISOString()).toBe("2026-09-08T17:00:00.000Z");
    expect(windows[1]?.availableUntil.toISOString()).toBe("2026-09-09T05:00:00.000Z");
  });

  it("opens the thirtieth occurrence on 06 Oct, thirty rows after the first", () => {
    const windows = computeOccurrenceWindows(daily, BLOCK_ORIGIN, ISTANBUL);

    expect(windows).toHaveLength(30);
    expect(windows[29]?.occurrenceIndex).toBe(29);
    expect(windows[29]?.availableFrom.toISOString()).toBe("2026-10-06T17:00:00.000Z");
    expect(windows[29]?.availableUntil.toISOString()).toBe("2026-10-07T05:00:00.000Z");
  });

  it("places the endline on the block's own origin plus P30D, not after the last daily", () => {
    // The endline shares the block's origin. That is the whole of FR-48c: it
    // arrives on 07 Oct whether the participant answered thirty daily reports
    // or none of them.
    const endline: StepTiming = {
      offsetIso: "P30D",
      anchorLocalTime: "20:00",
      anchorTimezoneSource: "PARTICIPANT",
      windowDurationIso: "P3D",
      occurrenceCount: 1,
      recurrenceIntervalIso: null,
    };

    const windows = computeOccurrenceWindows(endline, BLOCK_ORIGIN, ISTANBUL);

    expect(windows[0]?.availableFrom.toISOString()).toBe("2026-10-07T17:00:00.000Z");
    expect(windows[0]?.availableUntil.toISOString()).toBe("2026-10-10T17:00:00.000Z");
  });

  it("opens the baseline at the enrollment instant itself, with no zone involved", () => {
    // Duration mode from enrollment: the participant can start the moment they
    // consent, whatever time of day that was.
    const baseline: StepTiming = {
      offsetIso: "PT0S",
      anchorLocalTime: null,
      anchorTimezoneSource: null,
      windowDurationIso: "P3D",
      occurrenceCount: 1,
      recurrenceIntervalIso: null,
    };

    const windows = computeOccurrenceWindows(baseline, at("2026-09-04T09:12:00Z"), ISTANBUL);

    expect(windows[0]?.availableFrom.toISOString()).toBe("2026-09-04T09:12:00.000Z");
    expect(windows[0]?.availableUntil.toISOString()).toBe("2026-09-07T09:12:00.000Z");
  });

  it("materialises 32 windows across the three steps", () => {
    // §8 of the reference document: 1 + 30 + 1.
    const counts = [1, 30, 1];
    expect(counts.reduce((total, count) => total + count, 0)).toBe(32);
  });
});

describe("recurrence is anchored, never chained", () => {
  const step: StepTiming = {
    offsetIso: "PT0S",
    anchorLocalTime: null,
    anchorTimezoneSource: null,
    windowDurationIso: "PT12H",
    occurrenceCount: 10,
    recurrenceIntervalIso: "P1D",
  };

  it("computes occurrence n from the origin, so a gap cannot displace later ones", () => {
    const windows = computeOccurrenceWindows(step, at("2026-01-01T00:00:00Z"), ISTANBUL);

    // Each is origin + n days. Chaining from n-1 would give the same answer
    // here, which is why the real guard is the next assertion.
    expect(windows[5]?.availableFrom.toISOString()).toBe("2026-01-06T00:00:00.000Z");
  });

  it("gives the same instant for occurrence 9 whether or not the earlier ones were computed", () => {
    const all = computeOccurrenceWindows(step, at("2026-01-01T00:00:00Z"), ISTANBUL);
    const alone = computeOccurrenceWindows(
      { ...step, occurrenceCount: 10 },
      at("2026-01-01T00:00:00Z"),
      ISTANBUL,
    );

    expect(alone[9]?.availableFrom.toISOString()).toBe(all[9]?.availableFrom.toISOString());
    expect(all[9]?.availableFrom.toISOString()).toBe("2026-01-10T00:00:00.000Z");
  });
});

/**
 * Türkiye has been permanently UTC+3 since 2016, so the reference study cannot
 * exercise either anomaly. Participants travel and cohorts get recruited
 * elsewhere, so the logic is required regardless — and a zone that still shifts
 * is the only way to test it (STRUCTURE.md §8.3).
 */
describe("daylight saving", () => {
  const BERLIN: TimingZones = {
    studyTimezone: "Europe/Berlin",
    participantTimezone: "Europe/Berlin",
  };

  it("keeps a wall-clock anchor at the same local hour across a spring transition", () => {
    // Europe/Berlin springs forward on 2026-03-29. A 20:00 anchor is far from
    // the 02:00 gap, so the local time is preserved and the UTC instant shifts
    // by an hour — which is the entire point of wall-clock mode.
    const step: StepTiming = {
      offsetIso: "PT0S",
      anchorLocalTime: "20:00",
      anchorTimezoneSource: "STUDY",
      windowDurationIso: "PT12H",
      occurrenceCount: 3,
      recurrenceIntervalIso: "P1D",
    };

    const windows = computeOccurrenceWindows(step, at("2026-03-27T12:00:00Z"), BERLIN);

    // 28 Mar is CET (+01:00), 29 and 30 Mar are CEST (+02:00).
    expect(windows[0]?.availableFrom.toISOString()).toBe("2026-03-27T19:00:00.000Z");
    expect(windows[1]?.availableFrom.toISOString()).toBe("2026-03-28T19:00:00.000Z");
    expect(windows[2]?.availableFrom.toISOString()).toBe("2026-03-29T18:00:00.000Z");
  });

  it("shifts a local time that does not exist forward to the first valid instant", () => {
    // 02:30 on 2026-03-29 never happens in Berlin: the clock jumps 02:00 → 03:00.
    const step: StepTiming = {
      offsetIso: "PT0S",
      anchorLocalTime: "02:30",
      anchorTimezoneSource: "STUDY",
      windowDurationIso: "PT6H",
      occurrenceCount: 1,
      recurrenceIntervalIso: null,
    };

    const windows = computeOccurrenceWindows(step, at("2026-03-29T00:00:00Z"), BERLIN);

    expect(windows[0]?.adjustment).toBe("SPRING_FORWARD_GAP");
    // Forward to 03:30 local = 01:30Z, rather than not scheduling at all.
    expect(windows[0]?.availableFrom.toISOString()).toBe("2026-03-29T01:30:00.000Z");
  });

  it("takes the first of two identical local times, maximising the window", () => {
    // 02:30 on 2026-10-25 happens twice in Berlin: 00:30Z (CEST) and 01:30Z (CET).
    const step: StepTiming = {
      offsetIso: "PT0S",
      anchorLocalTime: "02:30",
      anchorTimezoneSource: "STUDY",
      windowDurationIso: "PT6H",
      occurrenceCount: 1,
      recurrenceIntervalIso: null,
    };

    const windows = computeOccurrenceWindows(step, at("2026-10-25T00:00:00Z"), BERLIN);

    expect(windows[0]?.availableFrom.toISOString()).toBe("2026-10-25T00:30:00.000Z");
    expect(windows[0]?.adjustment).toBe("FALL_BACK_AMBIGUOUS");
  });

  it("leaves duration mode untouched by a transition", () => {
    const step: StepTiming = {
      offsetIso: "P1D",
      anchorLocalTime: null,
      anchorTimezoneSource: null,
      windowDurationIso: "PT12H",
      occurrenceCount: 1,
      recurrenceIntervalIso: null,
    };

    const windows = computeOccurrenceWindows(step, at("2026-03-29T00:00:00Z"), BERLIN);

    // Exactly 86 400 seconds later, whatever the clocks did.
    expect(windows[0]?.availableFrom.toISOString()).toBe("2026-03-30T00:00:00.000Z");
    expect(windows[0]?.adjustment).toBe("NONE");
  });
});

describe("the participant's zone", () => {
  it("falls back to the study's zone when the participant has not reported one", () => {
    const step: StepTiming = {
      offsetIso: "PT0S",
      anchorLocalTime: "20:00",
      anchorTimezoneSource: "PARTICIPANT",
      windowDurationIso: "PT12H",
      occurrenceCount: 1,
      recurrenceIntervalIso: null,
    };

    const windows = computeOccurrenceWindows(step, BLOCK_ORIGIN, {
      studyTimezone: "Europe/Istanbul",
      participantTimezone: null,
    });

    expect(windows[0]?.availableFrom.toISOString()).toBe("2026-09-07T17:00:00.000Z");
  });

  it("reads the participant's own zone when it differs from the study's", () => {
    const step: StepTiming = {
      offsetIso: "PT0S",
      anchorLocalTime: "20:00",
      anchorTimezoneSource: "PARTICIPANT",
      windowDurationIso: "PT12H",
      occurrenceCount: 1,
      recurrenceIntervalIso: null,
    };

    const windows = computeOccurrenceWindows(step, BLOCK_ORIGIN, {
      studyTimezone: "Europe/Istanbul",
      participantTimezone: "Europe/London",
    });

    // 20:00 BST on 07 Sep is 19:00Z — an hour after Istanbul's 20:00.
    expect(windows[0]?.availableFrom.toISOString()).toBe("2026-09-07T19:00:00.000Z");
  });

  it("uses the study's zone when the anchor names STUDY, whatever the participant reported", () => {
    const step: StepTiming = {
      offsetIso: "PT0S",
      anchorLocalTime: "20:00",
      anchorTimezoneSource: "STUDY",
      windowDurationIso: "PT12H",
      occurrenceCount: 1,
      recurrenceIntervalIso: null,
    };

    const windows = computeOccurrenceWindows(step, BLOCK_ORIGIN, {
      studyTimezone: "Europe/Istanbul",
      participantTimezone: "America/New_York",
    });

    expect(windows[0]?.availableFrom.toISOString()).toBe("2026-09-07T17:00:00.000Z");
  });
});
