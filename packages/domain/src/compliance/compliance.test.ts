import { describe, expect, it } from "vitest";
import { SESSION_STATUSES, type SessionStatus } from "../session/state-machine.js";
import { classifySession, type ComplianceSession } from "./classification.js";
import { summariseDay } from "./daily.js";
import {
  compliancePercent,
  elapsedCompliance,
  participantCompliance,
  stepCompliance,
  strictCompliance,
  studyAverageCompliance,
} from "./metrics.js";

/**
 * The compliance contract, test by test.
 *
 * `docs/compliance-formula.md` §10 lists the tests that must exist by name.
 * This file is that list, and the worked examples in §9 are reproduced exactly
 * — they are the specification, not illustrations of it. A number that changes
 * here is a number that changes in somebody's methods section.
 */

const session = (
  stepKey: string,
  status: SessionStatus,
  countsTowardCompliance = true,
): ComplianceSession => ({ stepKey, status, countsTowardCompliance });

/** `n` sessions of one step, in the given state. */
const many = (stepKey: string, status: SessionStatus, count: number): ComplianceSession[] =>
  Array.from({ length: count }, () => session(stepKey, status));

describe("§2 — every state's bucket assignment matches the table", () => {
  it("assigns exactly the documented bucket to each of the eight states", () => {
    expect(classifySession("PENDING_TRIGGER")).toBe("NOT_YET_DUE");
    expect(classifySession("SCHEDULED")).toBe("NOT_YET_DUE");
    expect(classifySession("AVAILABLE")).toBe("OPEN");
    expect(classifySession("STARTED")).toBe("OPEN");
    expect(classifySession("COMPLETED")).toBe("MET");
    expect(classifySession("EXPIRED_UNSTARTED")).toBe("MISSED");
    expect(classifySession("EXPIRED_PARTIAL")).toBe("MISSED");
    expect(classifySession("CANCELLED")).toBe("EXCLUDED");
  });

  it("covers every state the state machine defines", () => {
    // Guards against a ninth state being added without anyone deciding what it
    // means for compliance — which would otherwise surface as `undefined`
    // silently dropping sessions out of a denominator.
    for (const status of SESSION_STATUSES) {
      expect(classifySession(status)).toBeDefined();
    }
  });
});

describe("§5 — a zero denominator is not applicable, never zero", () => {
  it("refuses to compute a ratio for a participant with nothing due", () => {
    const justEnrolled = [
      session("baseline", "AVAILABLE"),
      ...many("daily", "SCHEDULED", 30),
      session("endline", "PENDING_TRIGGER"),
    ];

    const result = elapsedCompliance(justEnrolled);

    // Zero percent means "had opportunities and took none" — a materially
    // different claim about a person.
    expect(result.applicable).toBe(false);
    expect(compliancePercent(result)).toBeNull();
  });

  it("does not report zero for a participant who missed everything either", () => {
    // The contrast that makes the previous test meaningful: this participant
    // genuinely IS at zero, and must read as 0%, not as "not applicable".
    const missedAll = many("daily", "EXPIRED_UNSTARTED", 4);

    expect(compliancePercent(elapsedCompliance(missedAll))).toBe(0);
  });
});

describe("§2 — exclusions remove a session from both terms", () => {
  it("counts_toward_compliance = false removes it entirely", () => {
    const sessions = [
      session("baseline", "COMPLETED"),
      session("exit_interview", "EXPIRED_UNSTARTED", false),
    ];

    // Worked example D: whether they do the optional exit interview never moves
    // either metric.
    expect(elapsedCompliance(sessions)).toMatchObject({ numerator: 1, denominator: 1 });
    expect(strictCompliance(sessions)).toMatchObject({ numerator: 1, denominator: 1 });
  });

  it("CANCELLED removes it whatever the cancellation reason", () => {
    const sessions = [
      session("baseline", "COMPLETED"),
      session("daily", "CANCELLED"),
      session("daily", "CANCELLED"),
    ];

    expect(elapsedCompliance(sessions)).toMatchObject({ numerator: 1, denominator: 1 });
  });

  it("ENROLLED_AFTER_WINDOW sessions leave the STRICT denominator too", () => {
    /**
     * The rule that stops a late enrollment being punished.
     *
     * Strict compliance uses the whole protocol as its denominator, so this is
     * the metric where cancelled occurrences would do the most damage: a
     * participant who joined a thirty-day block on day three would appear to
     * have failed two measurements nobody ever showed them.
     */
    const lateEnrollment = [...many("daily", "CANCELLED", 2), ...many("daily", "COMPLETED", 28)];

    expect(strictCompliance(lateEnrollment)).toMatchObject({ numerator: 28, denominator: 28 });
    expect(compliancePercent(strictCompliance(lateEnrollment))).toBe(100);
  });
});

describe("§9 — the worked examples reproduce exactly", () => {
  it("Example A — mid-study participant: 3/5 elapsed, 3/9 strict", () => {
    const sessions = [
      session("baseline", "COMPLETED"),
      session("followup", "COMPLETED"),
      session("daily", "COMPLETED"),
      session("daily", "EXPIRED_UNSTARTED"),
      session("daily", "EXPIRED_PARTIAL"),
      session("daily", "AVAILABLE"),
      ...many("daily", "SCHEDULED", 3),
    ];

    expect(elapsedCompliance(sessions)).toMatchObject({ numerator: 3, denominator: 5 });
    expect(compliancePercent(elapsedCompliance(sessions))).toBe(60);
    expect(strictCompliance(sessions)).toMatchObject({ numerator: 3, denominator: 9 });
  });

  it("Example B — just enrolled: not applicable", () => {
    const sessions = [
      session("baseline", "AVAILABLE"),
      ...many("daily", "SCHEDULED", 6),
      session("endline", "PENDING_TRIGGER"),
    ];

    expect(elapsedCompliance(sessions).applicable).toBe(false);
  });

  it("Example C — withdrawal: 2/3, and excluded from the study average", () => {
    const sessions = [
      session("a", "COMPLETED"),
      session("b", "COMPLETED"),
      session("c", "EXPIRED_UNSTARTED"),
      ...many("d", "CANCELLED", 5),
    ];

    const elapsed = elapsedCompliance(sessions);
    expect(elapsed).toMatchObject({ numerator: 2, denominator: 3 });

    const average = studyAverageCompliance([{ withdrawn: true, elapsed }]);
    expect(average.mean).toBeNull();
    expect(average.withdrawnCount).toBe(1);
  });

  it("Example E — the reference design mid-block, every figure", () => {
    /**
     * The example that pins down all three rules at once: cancelled occurrences
     * absent from both denominators, the open window excluded, and the endline
     * reporting a state rather than a percentage.
     */
    const sessions = [
      session("baseline", "COMPLETED"),
      ...many("daily", "CANCELLED", 2), // #0–#1, ENROLLED_AFTER_WINDOW
      ...many("daily", "COMPLETED", 7), // seven of #2–#10
      session("daily", "EXPIRED_UNSTARTED"),
      session("daily", "EXPIRED_PARTIAL"),
      session("daily", "AVAILABLE"), // #11, window open
      ...many("daily", "SCHEDULED", 18), // #12–#29
      session("endline", "SCHEDULED"),
    ];

    expect(elapsedCompliance(sessions)).toMatchObject({ numerator: 8, denominator: 10 });
    expect(compliancePercent(elapsedCompliance(sessions))).toBe(80);
    expect(strictCompliance(sessions)).toMatchObject({ numerator: 8, denominator: 30 });

    const steps = [
      { stepKey: "baseline", occurrenceCount: 1, countsTowardCompliance: true },
      { stepKey: "daily", occurrenceCount: 30, countsTowardCompliance: true },
      { stepKey: "endline", occurrenceCount: 1, countsTowardCompliance: true },
    ];
    const perStep = participantCompliance(sessions, steps).perStep;

    // daily adherence = 7/9 = 78%
    expect(perStep[1]).toMatchObject({ kind: "ADHERENCE" });
    expect(perStep[1]?.compliance).toMatchObject({ numerator: 7, denominator: 9 });
    expect(compliancePercent(perStep[1]!.compliance)).toBe(77.8);

    // baseline completed, endline not yet due — states, not percentages.
    expect(perStep[0]).toMatchObject({ kind: "COMPLETION", state: "COMPLETED" });
    expect(perStep[2]).toMatchObject({ kind: "COMPLETION", state: "NOT_YET_DUE" });
  });
});

describe("§6 — per-step compliance, and why one number is not enough", () => {
  it("distinguishes the two participants that §6 says look identical", () => {
    /**
     * The table in §6, run for real. Both report 16/32 = 50% overall. One
     * completed the baseline and the endline and is usable for the primary
     * analysis; the other missed both and is not. A dashboard showing only the
     * overall figure cannot tell a researcher which is which.
     */
    const steps = [
      { stepKey: "baseline", occurrenceCount: 1, countsTowardCompliance: true },
      { stepKey: "daily", occurrenceCount: 30, countsTowardCompliance: true },
      { stepKey: "endline", occurrenceCount: 1, countsTowardCompliance: true },
    ];

    const usable = [
      session("baseline", "COMPLETED"),
      ...many("daily", "COMPLETED", 14),
      ...many("daily", "EXPIRED_UNSTARTED", 16),
      session("endline", "COMPLETED"),
    ];
    const unusable = [
      session("baseline", "EXPIRED_UNSTARTED"),
      ...many("daily", "COMPLETED", 16),
      ...many("daily", "EXPIRED_UNSTARTED", 14),
      session("endline", "EXPIRED_UNSTARTED"),
    ];

    // Identical overall.
    expect(compliancePercent(elapsedCompliance(usable))).toBe(50);
    expect(compliancePercent(elapsedCompliance(unusable))).toBe(50);

    // Entirely different per step, which is the point.
    const a = participantCompliance(usable, steps).perStep;
    const b = participantCompliance(unusable, steps).perStep;

    expect([a[0]?.state, a[2]?.state]).toEqual(["COMPLETED", "COMPLETED"]);
    expect([b[0]?.state, b[2]?.state]).toEqual(["MISSED", "MISSED"]);
  });

  it("a single-occurrence step reports a state, never a percentage", () => {
    // A percentage is a poor rendering of a one-in-one measurement, and §6
    // forbids it. The kind travels with the figure so the interface cannot
    // accidentally render 100%.
    const result = stepCompliance([session("endline", "COMPLETED")], {
      stepKey: "endline",
      occurrenceCount: 1,
      countsTowardCompliance: true,
    });

    expect(result.kind).toBe("COMPLETION");
    expect(result.state).toBe("COMPLETED");
  });

  it("a recurring block reports adherence, with no state", () => {
    const result = stepCompliance(
      [...many("daily", "COMPLETED", 3), ...many("daily", "EXPIRED_UNSTARTED", 1)],
      { stepKey: "daily", occurrenceCount: 30, countsTowardCompliance: true },
    );

    expect(result.kind).toBe("ADHERENCE");
    expect(result.state).toBeNull();
    expect(result.compliance).toMatchObject({ numerator: 3, denominator: 4 });
  });

  it("reports a cancelled single-occurrence step as excluded, not missed", () => {
    // "Not applicable" and "they did not do it" are different facts about a
    // participant, and only one of them is about behaviour.
    const result = stepCompliance([session("endline", "CANCELLED")], {
      stepKey: "endline",
      occurrenceCount: 1,
      countsTowardCompliance: true,
    });

    expect(result.state).toBe("EXCLUDED");
    expect(result.compliance.applicable).toBe(false);
  });
});

describe("§7 — the study average", () => {
  const applicable = (numerator: number, denominator: number) =>
    elapsedCompliance([
      ...many("s", "COMPLETED", numerator),
      ...many("s", "EXPIRED_UNSTARTED", denominator - numerator),
    ]);

  it("is the unweighted mean over participants, not pooled over sessions", () => {
    /**
     * Pooled, these would be (1 + 30) / (2 + 60) = 50%. Unweighted, they are
     * the mean of 50% and 50% — the same here by construction, so the test that
     * matters is the asymmetric one below.
     */
    const average = studyAverageCompliance([
      { withdrawn: false, elapsed: applicable(1, 2) },
      { withdrawn: false, elapsed: applicable(30, 60) },
    ]);

    expect(average.mean).toBeCloseTo(0.5);
    expect(average.participantCount).toBe(2);
  });

  it("does not let a participant with many occurrences outvote the others", () => {
    // Pooled: (2 + 0) / (2 + 30) = 6%. Unweighted: mean(100%, 0%) = 50%. The
    // second is what §7 specifies, and the difference is the whole reason the
    // choice is documented.
    const average = studyAverageCompliance([
      { withdrawn: false, elapsed: applicable(2, 2) },
      { withdrawn: false, elapsed: applicable(0, 30) },
    ]);

    expect(average.mean).toBeCloseTo(0.5);
  });

  it("excludes withdrawn participants from the mean and counts them separately", () => {
    const average = studyAverageCompliance([
      { withdrawn: false, elapsed: applicable(4, 4) },
      { withdrawn: true, elapsed: applicable(0, 4) },
    ]);

    expect(average.mean).toBe(1);
    expect(average.participantCount).toBe(1);
    expect(average.withdrawnCount).toBe(1);
  });

  it("excludes zero-denominator participants and says how many there were", () => {
    // Otherwise the participant count behind the average is unexplainable: a
    // study with forty people showing "mean over 12" needs the other 28
    // accounted for.
    const average = studyAverageCompliance([
      { withdrawn: false, elapsed: applicable(1, 2) },
      { withdrawn: false, elapsed: elapsedCompliance([session("s", "SCHEDULED")]) },
    ]);

    expect(average.participantCount).toBe(1);
    expect(average.notYetApplicableCount).toBe(1);
  });

  it("reports no mean at all rather than zero when nobody is eligible", () => {
    const average = studyAverageCompliance([
      { withdrawn: false, elapsed: elapsedCompliance([session("s", "SCHEDULED")]) },
    ]);

    expect(average.mean).toBeNull();
  });
});

describe("§8 — the daily view categories sum to the window totals", () => {
  it("splits closed windows into completed, never-opened, and partial", () => {
    const day = summariseDay([
      { status: "COMPLETED", windowClosedOnDate: true, hasResponses: true },
      { status: "COMPLETED", windowClosedOnDate: true, hasResponses: true },
      { status: "EXPIRED_UNSTARTED", windowClosedOnDate: true, hasResponses: false },
      { status: "EXPIRED_PARTIAL", windowClosedOnDate: true, hasResponses: true },
    ]);

    expect(day.closed).toBe(4);
    // The invariant §8 demands: the parts sum to the total, so a reader adding
    // them up is not told there were more sessions than there were.
    expect(day.completed + day.missedUnstarted + day.missedPartial).toBe(day.closed);
    expect(day).toMatchObject({ completed: 2, missedUnstarted: 1, missedPartial: 1 });
  });

  it("splits open windows into not started and in progress", () => {
    const day = summariseDay([
      { status: "AVAILABLE", windowClosedOnDate: false, hasResponses: false },
      { status: "AVAILABLE", windowClosedOnDate: false, hasResponses: true },
      { status: "STARTED", windowClosedOnDate: false, hasResponses: true },
    ]);

    expect(day.open).toBe(3);
    expect(day.notStarted + day.inProgress).toBe(day.open);
    expect(day).toMatchObject({ notStarted: 1, inProgress: 2 });
  });

  it("counts an AVAILABLE session with answers as in progress", () => {
    // The status label can lag the participant's behaviour. "Did they type
    // anything?" is the fact a researcher is asking about.
    const day = summariseDay([
      { status: "AVAILABLE", windowClosedOnDate: false, hasResponses: true },
    ]);

    expect(day).toMatchObject({ notStarted: 0, inProgress: 1 });
  });

  it("ignores sessions that neither closed today nor are open", () => {
    const day = summariseDay([
      { status: "SCHEDULED", windowClosedOnDate: false, hasResponses: false },
      { status: "PENDING_TRIGGER", windowClosedOnDate: false, hasResponses: false },
      { status: "CANCELLED", windowClosedOnDate: true, hasResponses: false },
    ]);

    expect(day).toMatchObject({ closed: 0, open: 0 });
  });

  it("counts a completion against the day its window closed", () => {
    // Otherwise a session answered just after midnight vanishes from the day it
    // belonged to and reappears in a day that had no window at all.
    const day = summariseDay([
      { status: "COMPLETED", windowClosedOnDate: false, hasResponses: true },
    ]);

    expect(day.closed).toBe(0);
  });
});

describe("elapsed and strict converge once every session is terminal", () => {
  it("agrees exactly at the end of a protocol", () => {
    // The property that makes strict compliance meaningful in a methods
    // section, and meaningless before then.
    const finished = [
      session("baseline", "COMPLETED"),
      ...many("daily", "COMPLETED", 20),
      ...many("daily", "EXPIRED_UNSTARTED", 10),
      session("endline", "COMPLETED"),
    ];

    expect(elapsedCompliance(finished)).toEqual(strictCompliance(finished));
  });

  it("disagrees mid-study, which is why strict is never the default", () => {
    const midStudy = [session("baseline", "COMPLETED"), ...many("daily", "SCHEDULED", 29)];

    expect(compliancePercent(elapsedCompliance(midStudy))).toBe(100);
    expect(compliancePercent(strictCompliance(midStudy))).toBe(3.3);
  });
});
