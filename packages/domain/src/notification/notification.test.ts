import { describe, expect, it } from "vitest";
import { evaluateNotification, nextChainLink, type NotificationContext } from "./guards.js";
import {
  isWithinQuietHours,
  quietHoursEndAfter,
  resolveQuietHoursZone,
  QuietHoursError,
} from "./quiet-hours.js";

/**
 * The notification guard chain and quiet hours (PLAN.md Phase 9,
 * STRUCTURE.md §9.1, FR-18, FR-40).
 *
 * Two things are asserted here that nothing else can assert: that each guard
 * stops what it should, and — the part that actually matters — that when
 * several guards would fire, the RIGHT ONE reports. A suppression reason is
 * research data. "The participant had finished" and "we chose not to disturb
 * them" are different facts, and an analysis that receives the second when the
 * first was true reads a success as an outreach failure.
 */

const HOUR = 3_600_000;
const NOW = new Date("2026-09-07T12:00:00Z");

/** A healthy initial notification: every guard passes, the answer is SEND. */
const OPEN: NotificationContext = {
  kind: "INITIAL",
  occurrenceIndex: 0,
  scheduledFor: NOW,
  sessionStatus: "AVAILABLE",
  availableUntil: new Date(NOW.getTime() + 12 * HOUR),
  participantActive: true,
  attemptAlreadyRecorded: false,
  hasActiveSubscription: true,
  timezone: "Europe/Istanbul",
  policy: {
    maxReminders: 3,
    intervalMs: 3 * HOUR,
    quietHours: null,
    quietHoursBehavior: "SKIP",
  },
};

function context(overrides: Partial<NotificationContext>): NotificationContext {
  return { ...OPEN, ...overrides, policy: { ...OPEN.policy, ...overrides.policy } };
}

describe("the guard chain, one guard at a time", () => {
  it("sends when every guard passes", () => {
    expect(evaluateNotification(OPEN, NOW)).toEqual({ action: "SEND" });
  });

  it("1 — suppresses on a session that is no longer open", () => {
    for (const status of ["COMPLETED", "CANCELLED", "EXPIRED_UNSTARTED", "SCHEDULED"] as const) {
      expect(evaluateNotification(context({ sessionStatus: status }), NOW)).toEqual({
        action: "SUPPRESS",
        reason: "SUPPRESSED_STATE",
        continueChain: false,
      });
    }
  });

  it("1 — still sends to a STARTED session", () => {
    // Partially answered is not finished, and it is the participant most worth
    // reminding: they have already invested effort in this questionnaire.
    expect(evaluateNotification(context({ sessionStatus: "STARTED" }), NOW)).toEqual({
      action: "SEND",
    });
  });

  it("2 — suppresses once the window has closed", () => {
    const closed = context({ availableUntil: new Date(NOW.getTime() - 1) });

    expect(evaluateNotification(closed, NOW)).toEqual({
      action: "SUPPRESS",
      reason: "SUPPRESSED_EXPIRED",
      continueChain: false,
    });
  });

  it("2 — suppresses an AVAILABLE session whose window has in fact passed", () => {
    // The status label lags: the expiry sweeper has not reached this row yet.
    // Chasing someone about a questionnaire they can no longer open is worse
    // than saying nothing, so the window decides, not the label.
    const stale = context({
      sessionStatus: "AVAILABLE",
      availableUntil: new Date(NOW.getTime() - HOUR),
    });

    expect(evaluateNotification(stale, NOW)).toMatchObject({ reason: "SUPPRESSED_EXPIRED" });
  });

  it("2 — suppresses a session with no window at all", () => {
    expect(evaluateNotification(context({ availableUntil: null }), NOW)).toMatchObject({
      reason: "SUPPRESSED_EXPIRED",
    });
  });

  it("3 — suppresses for a withdrawn participant", () => {
    expect(evaluateNotification(context({ participantActive: false }), NOW)).toEqual({
      action: "SUPPRESS",
      reason: "SUPPRESSED_WITHDRAWN",
      continueChain: false,
    });
  });

  it("4 — suppresses past the reminder cap", () => {
    const overCap = context({ kind: "REMINDER", occurrenceIndex: 4, policy: { maxReminders: 3 } });

    expect(evaluateNotification(overCap, NOW)).toEqual({
      action: "SUPPRESS",
      reason: "SUPPRESSED_CAP",
      continueChain: false,
    });
  });

  it("4 — sends the reminder that sits exactly on the cap", () => {
    const atCap = context({ kind: "REMINDER", occurrenceIndex: 3, policy: { maxReminders: 3 } });

    expect(evaluateNotification(atCap, NOW)).toEqual({ action: "SEND" });
  });

  it("4 — a cap of zero still allows the initial notification", () => {
    // "Tell them once, then leave them alone" is a legitimate and gentle
    // design, not a policy that sends nothing. The cap counts REMINDERS.
    const noChasing = context({ kind: "INITIAL", occurrenceIndex: 0, policy: { maxReminders: 0 } });

    expect(evaluateNotification(noChasing, NOW)).toEqual({ action: "SEND" });
  });

  it("5 — reports a duplicate as ALREADY_ATTEMPTED, with nothing to record", () => {
    // Not a suppression. The existing attempt row already says what happened,
    // and writing a second one would corrupt the count that makes "how many
    // times was this participant contacted?" answerable.
    expect(evaluateNotification(context({ attemptAlreadyRecorded: true }), NOW)).toEqual({
      action: "ALREADY_ATTEMPTED",
    });
  });

  it("6 — suppresses when there is nothing to send to", () => {
    expect(evaluateNotification(context({ hasActiveSubscription: false }), NOW)).toEqual({
      action: "SUPPRESS",
      reason: "SUPPRESSED_NO_SUBSCRIPTION",
      continueChain: false,
    });
  });

  it("8 — suppresses work that is older than one reminder interval", () => {
    // The post-outage burst guard (ADR-005). Eight hours late on a three-hour
    // cadence is the aftermath of an outage, not scheduling jitter.
    const late = context({ scheduledFor: new Date(NOW.getTime() - 8 * HOUR) });

    expect(evaluateNotification(late, NOW)).toEqual({
      action: "SUPPRESS",
      reason: "SUPPRESSED_STALE",
      continueChain: false,
    });
  });

  it("8 — tolerates lateness within one interval", () => {
    const slightlyLate = context({ scheduledFor: new Date(NOW.getTime() - 2 * HOUR) });

    expect(evaluateNotification(slightlyLate, NOW)).toEqual({ action: "SEND" });
  });

  it("8 — scales its tolerance with the study's own cadence", () => {
    // A study that nudges weekly is still happy to send a day late; on that
    // cadence a day late is still the notification the researcher intended.
    const weekly = context({
      scheduledFor: new Date(NOW.getTime() - 24 * HOUR),
      policy: { intervalMs: 7 * 24 * HOUR },
    });

    expect(evaluateNotification(weekly, NOW)).toEqual({ action: "SEND" });
  });
});

describe("the ORDER of the guards, which is what makes a reason mean something", () => {
  it("reports completion, not quiet hours, when both apply", () => {
    // The case this ordering exists for. A participant who finished at 23:30
    // must be recorded as SUPPRESSED_STATE — "they were done" — and never as
    // "we chose not to disturb them", which would read as an outreach failure
    // in every later analysis.
    const finishedAtNight = context({
      sessionStatus: "COMPLETED",
      policy: { quietHours: { start: "22:00", end: "08:00" }, quietHoursBehavior: "SKIP" },
    });
    const night = new Date("2026-09-07T20:30:00Z"); // 23:30 in Istanbul

    expect(evaluateNotification(finishedAtNight, night)).toMatchObject({
      reason: "SUPPRESSED_STATE",
    });
  });

  it("reports withdrawal, not the missing subscription it caused", () => {
    // Withdrawal deactivates subscriptions (Phase 8), so guard 6 would also
    // fire. "They left" and "we had no way to reach them" are different facts,
    // and only the second is a delivery problem worth chasing.
    const withdrawn = context({ participantActive: false, hasActiveSubscription: false });

    expect(evaluateNotification(withdrawn, NOW)).toMatchObject({ reason: "SUPPRESSED_WITHDRAWN" });
  });

  it("reports the cap before reporting a duplicate", () => {
    // A cap breach means the chain should have stopped earlier — a bug, or a
    // policy edited mid-chain. "Already attempted" is both less true and
    // unactionable.
    const both = context({
      kind: "REMINDER",
      occurrenceIndex: 9,
      attemptAlreadyRecorded: true,
      policy: { maxReminders: 2 },
    });

    expect(evaluateNotification(both, NOW)).toMatchObject({ reason: "SUPPRESSED_CAP" });
  });

  it("reports expiry, not staleness, for an old job on a closed window", () => {
    // After an outage both are true. The participant-facing fact is that the
    // window closed; the system-facing one is that we were down. The first is
    // what a compliance analysis needs.
    const both = context({
      availableUntil: new Date(NOW.getTime() - HOUR),
      scheduledFor: new Date(NOW.getTime() - 8 * HOUR),
    });

    expect(evaluateNotification(both, NOW)).toMatchObject({ reason: "SUPPRESSED_EXPIRED" });
  });

  it("does not let staleness pre-empt a missing subscription", () => {
    const both = context({
      hasActiveSubscription: false,
      scheduledFor: new Date(NOW.getTime() - 8 * HOUR),
    });

    expect(evaluateNotification(both, NOW)).toMatchObject({
      reason: "SUPPRESSED_NO_SUBSCRIPTION",
    });
  });
});

describe("quiet hours, guard 7", () => {
  const QUIET = { start: "22:00", end: "08:00" };

  it("SKIP drops this reminder and keeps the chain alive", () => {
    // Stopping the chain here would mean one overnight reminder silently ended
    // all contact for the rest of the window.
    const night = new Date("2026-09-07T20:30:00Z"); // 23:30 Istanbul
    const skip = context({ policy: { quietHours: QUIET, quietHoursBehavior: "SKIP" } });

    expect(evaluateNotification(skip, night)).toEqual({
      action: "SUPPRESS",
      reason: "SUPPRESSED_QUIET_HOURS",
      continueChain: true,
    });
  });

  it("DEFER moves the notification to the end of the window and records nothing", () => {
    const night = new Date("2026-09-07T20:30:00Z"); // 23:30 Istanbul
    const defer = context({
      policy: { quietHours: QUIET, quietHoursBehavior: "DEFER" },
      availableUntil: new Date("2026-09-09T00:00:00Z"),
    });

    const decision = evaluateNotification(defer, night);

    // 08:00 Istanbul the next morning is 05:00Z.
    expect(decision).toEqual({ action: "DEFER", until: new Date("2026-09-08T05:00:00Z") });
  });

  it("sends normally outside the window", () => {
    const midday = new Date("2026-09-07T09:00:00Z"); // 12:00 Istanbul
    const quiet = context({ policy: { quietHours: QUIET, quietHoursBehavior: "DEFER" } });

    expect(evaluateNotification(quiet, midday)).toEqual({ action: "SEND" });
  });

  it("reads the window in the participant's zone, not the server's", () => {
    // 23:30 in Istanbul is 13:30 in Los Angeles. The same instant is quiet for
    // one participant and the middle of the afternoon for another.
    const instant = new Date("2026-09-07T20:30:00Z");

    expect(isWithinQuietHours(instant, "Europe/Istanbul", QUIET)).toBe(true);
    expect(isWithinQuietHours(instant, "America/Los_Angeles", QUIET)).toBe(false);
  });
});

describe("the quiet-hours window itself", () => {
  const OVERNIGHT = { start: "22:00", end: "08:00" };

  it("treats the overnight wrap as the normal case", () => {
    const at = (iso: string) => new Date(iso);
    // Istanbul is UTC+3 in September.
    expect(isWithinQuietHours(at("2026-09-07T19:00:00Z"), "Europe/Istanbul", OVERNIGHT)).toBe(true); // 22:00
    expect(isWithinQuietHours(at("2026-09-07T22:00:00Z"), "Europe/Istanbul", OVERNIGHT)).toBe(true); // 01:00
    expect(isWithinQuietHours(at("2026-09-08T04:59:00Z"), "Europe/Istanbul", OVERNIGHT)).toBe(true); // 07:59
    expect(isWithinQuietHours(at("2026-09-08T05:00:00Z"), "Europe/Istanbul", OVERNIGHT)).toBe(
      false,
    ); // 08:00
    expect(isWithinQuietHours(at("2026-09-07T18:59:00Z"), "Europe/Istanbul", OVERNIGHT)).toBe(
      false,
    ); // 21:59
  });

  it("supports a same-day window too", () => {
    const lunch = { start: "13:00", end: "14:00" };
    expect(isWithinQuietHours(new Date("2026-09-07T10:30:00Z"), "Europe/Istanbul", lunch)).toBe(
      true,
    );
    expect(isWithinQuietHours(new Date("2026-09-07T11:30:00Z"), "Europe/Istanbul", lunch)).toBe(
      false,
    );
  });

  it("treats equal bounds as no window rather than permanent silence", () => {
    // A single mistyped digit would otherwise silence a study forever, with no
    // error anywhere and no notification ever sent.
    const typo = { start: "08:00", end: "08:00" };

    expect(isWithinQuietHours(new Date("2026-09-07T05:00:00Z"), "Europe/Istanbul", typo)).toBe(
      false,
    );
  });

  it("computes the end of an overnight window in the participant's zone", () => {
    // 23:30 Istanbul → 08:00 the next morning, which is 05:00Z.
    expect(
      quietHoursEndAfter(new Date("2026-09-07T20:30:00Z"), "Europe/Istanbul", OVERNIGHT),
    ).toEqual(new Date("2026-09-08T05:00:00Z"));
  });

  it("computes the end within the same day when the window has not wrapped", () => {
    // 01:00 Istanbul is inside the window; it ends at 08:00 the SAME day.
    expect(
      quietHoursEndAfter(new Date("2026-09-07T22:00:00Z"), "Europe/Istanbul", OVERNIGHT),
    ).toEqual(new Date("2026-09-08T05:00:00Z"));
  });

  it("crosses a daylight-saving transition without landing inside the window", () => {
    /**
     * Berlin springs forward at 02:00 local on 2026-03-29. A deferral computed
     * by adding hours would fire an hour early — inside the quiet window — and
     * that failure would appear twice a year, in the dark, which is exactly
     * what quiet hours exist to prevent.
     *
     * 23:30 Berlin on the 28th is 22:30Z. The window ends at 08:00 Berlin on
     * the 29th, which after the transition is UTC+2, so 06:00Z.
     */
    const beforeTransition = new Date("2026-03-28T22:30:00Z");
    const end = quietHoursEndAfter(beforeTransition, "Europe/Berlin", OVERNIGHT);

    expect(end).toEqual(new Date("2026-03-29T06:00:00Z"));
    expect(isWithinQuietHours(end, "Europe/Berlin", OVERNIGHT)).toBe(false);
    // 25 hours would be the naive answer; the true gap is 7.5 hours of real
    // time because an hour of the night did not exist.
    expect(end.getTime() - beforeTransition.getTime()).toBe(7.5 * HOUR);
  });

  it("rejects a malformed local time rather than guessing", () => {
    expect(() =>
      isWithinQuietHours(NOW, "Europe/Istanbul", { start: "10pm", end: "08:00" }),
    ).toThrow(QuietHoursError);
    expect(() =>
      isWithinQuietHours(NOW, "Europe/Istanbul", { start: "25:00", end: "08:00" }),
    ).toThrow(QuietHoursError);
  });

  it("rejects an unknown timezone", () => {
    expect(() =>
      isWithinQuietHours(NOW, "Mars/Olympus_Mons", { start: "22:00", end: "08:00" }),
    ).toThrow(QuietHoursError);
  });

  it("falls back to the study's zone for a participant who reported none", () => {
    expect(resolveQuietHoursZone(null, "Europe/Istanbul")).toBe("Europe/Istanbul");
    expect(resolveQuietHoursZone("America/Los_Angeles", "Europe/Istanbul")).toBe(
      "America/Los_Angeles",
    );
  });
});

describe("the self-chaining rule", () => {
  it("follows the initial notification with reminder 1", () => {
    expect(
      nextChainLink({
        kind: "INITIAL",
        occurrenceIndex: 0,
        scheduledFor: NOW,
        policy: OPEN.policy,
      }),
    ).toEqual({ occurrenceIndex: 1, scheduledFor: new Date(NOW.getTime() + 3 * HOUR) });
  });

  it("stops at the cap", () => {
    expect(
      nextChainLink({
        kind: "REMINDER",
        occurrenceIndex: 3,
        scheduledFor: NOW,
        policy: { ...OPEN.policy, maxReminders: 3 },
      }),
    ).toBeNull();
  });

  it("schedules nothing at all when the policy forbids chasing", () => {
    expect(
      nextChainLink({
        kind: "INITIAL",
        occurrenceIndex: 0,
        scheduledFor: NOW,
        policy: { ...OPEN.policy, maxReminders: 0 },
      }),
    ).toBeNull();
  });

  it("measures from the scheduled instant, so the cadence cannot drift", () => {
    /**
     * Chaining off `now` would let each link's delay absorb the previous one's
     * lateness, so "every three hours" would arrive progressively later all
     * day — and after a deferral it would push the rest of the chain past the
     * end of the response window entirely.
     */
    const scheduled = new Date("2026-09-07T12:00:00Z");
    const link = nextChainLink({
      kind: "REMINDER",
      occurrenceIndex: 1,
      scheduledFor: scheduled,
      policy: OPEN.policy,
    });

    expect(link?.scheduledFor).toEqual(new Date("2026-09-07T15:00:00Z"));
  });

  it("produces exactly maxReminders links from one initial notification", () => {
    // The FR-40 cap, walked end to end: the participant is contacted once plus
    // at most `maxReminders` times for this session, and never more.
    const policy = { ...OPEN.policy, maxReminders: 3 };
    let link = nextChainLink({
      kind: "INITIAL",
      occurrenceIndex: 0,
      scheduledFor: NOW,
      policy,
    });

    const scheduled: number[] = [];
    while (link !== null) {
      scheduled.push(link.occurrenceIndex);
      link = nextChainLink({
        kind: "REMINDER",
        occurrenceIndex: link.occurrenceIndex,
        scheduledFor: link.scheduledFor,
        policy,
      });
    }

    expect(scheduled).toEqual([1, 2, 3]);
  });
});
