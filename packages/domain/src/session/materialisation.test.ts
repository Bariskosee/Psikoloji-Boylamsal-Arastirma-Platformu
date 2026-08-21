import { describe, expect, it } from "vitest";
import {
  findUnreachable,
  planMaterialisation,
  propagateCompletion,
  type MaterialisableStep,
  type MaterialisationContext,
} from "./materialisation.js";

/**
 * The assertion target is `docs/reference-protocol.md` §6 and §7: 32 sessions
 * at tabulated instants, and the late-enrollment case that produces cancelled
 * occurrences.
 *
 * Every number here is that study's configuration reproduced as a fixture.
 * None of it may become a default in application code (AGENT.md §3.4).
 */

const CORE_V1 = "11111111-1111-4111-8111-111111111111";
const DAILY_V1 = "22222222-2222-4222-8222-222222222222";

const step = (
  overrides: Partial<MaterialisableStep> & { id: string; stepKey: string },
): MaterialisableStep => ({
  questionnaireVersionId: CORE_V1,
  stepKind: "SCHEDULED",
  triggerType: "ENROLLMENT",
  triggerStepId: null,
  triggerOccurrenceIndex: null,
  triggerFixedDate: null,
  allowedGroupIds: [],
  timing: {
    offsetIso: "PT0S",
    anchorLocalTime: null,
    anchorTimezoneSource: null,
    windowDurationIso: "P3D",
    occurrenceCount: 1,
    recurrenceIntervalIso: null,
  },
  ...overrides,
});

const baseline = step({ id: "s0", stepKey: "baseline" });

const daily = step({
  id: "s1",
  stepKey: "daily",
  questionnaireVersionId: DAILY_V1,
  triggerType: "FIXED_DATETIME",
  triggerFixedDate: "2026-09-07",
  timing: {
    offsetIso: "PT0S",
    anchorLocalTime: "20:00",
    anchorTimezoneSource: "PARTICIPANT",
    windowDurationIso: "PT12H",
    occurrenceCount: 30,
    recurrenceIntervalIso: "P1D",
  },
});

/** The endline shares the block's ORIGIN — it is not chained to it (FR-48c). */
const endline = step({
  id: "s2",
  stepKey: "endline",
  triggerType: "FIXED_DATETIME",
  triggerFixedDate: "2026-09-07",
  timing: {
    offsetIso: "P30D",
    anchorLocalTime: "20:00",
    anchorTimezoneSource: "PARTICIPANT",
    windowDurationIso: "P3D",
    occurrenceCount: 1,
    recurrenceIntervalIso: null,
  },
});

const REFERENCE = [baseline, daily, endline];

const context = (overrides: Partial<MaterialisationContext> = {}): MaterialisationContext => ({
  enrolledAt: new Date("2026-09-04T09:12:00Z"),
  consentedAt: new Date("2026-09-04T09:12:00Z"),
  participantTimezone: "Europe/Istanbul",
  studyTimezone: "Europe/Istanbul",
  groupId: null,
  ...overrides,
});

describe("the reference protocol, enrolled before the block starts", () => {
  const ENROLLED = new Date("2026-09-04T09:12:00Z");

  it("materialises exactly 32 sessions", () => {
    // §8 of the reference document: 1 + 30 + 1.
    expect(planMaterialisation(REFERENCE, context(), ENROLLED)).toHaveLength(32);
  });

  it("opens the baseline immediately, at the enrollment instant", () => {
    const planned = planMaterialisation(REFERENCE, context(), ENROLLED);
    const first = planned.find((session) => session.stepKey === "baseline");

    expect(first?.status).toBe("AVAILABLE");
    expect(first?.availableFrom?.toISOString()).toBe("2026-09-04T09:12:00.000Z");
    expect(first?.availableUntil?.toISOString()).toBe("2026-09-07T09:12:00.000Z");
  });

  it("schedules the daily block on the tabulated instants", () => {
    const planned = planMaterialisation(REFERENCE, context(), ENROLLED);
    const block = planned.filter((session) => session.stepKey === "daily");

    expect(block).toHaveLength(30);
    expect(block[0]?.availableFrom?.toISOString()).toBe("2026-09-07T17:00:00.000Z");
    expect(block[0]?.availableUntil?.toISOString()).toBe("2026-09-08T05:00:00.000Z");
    expect(block[29]?.availableFrom?.toISOString()).toBe("2026-10-06T17:00:00.000Z");
    expect(block.every((session) => session.status === "SCHEDULED")).toBe(true);
  });

  it("schedules the endline on the block's origin plus P30D", () => {
    const planned = planMaterialisation(REFERENCE, context(), ENROLLED);
    const last = planned.find((session) => session.stepKey === "endline");

    expect(last?.availableFrom?.toISOString()).toBe("2026-10-07T17:00:00.000Z");
    expect(last?.availableUntil?.toISOString()).toBe("2026-10-10T17:00:00.000Z");
  });

  it("gives the endline a time that owes nothing to daily adherence", () => {
    // The acceptance criterion FR-48c exists for. Materialisation places it at
    // enrollment; nothing the participant does or fails to do can move it.
    const planned = planMaterialisation(REFERENCE, context(), ENROLLED);
    const last = planned.find((session) => session.stepKey === "endline");

    expect(last?.status).toBe("SCHEDULED");
    expect(last?.availableFrom).not.toBeNull();
  });

  it("cancels nothing", () => {
    const planned = planMaterialisation(REFERENCE, context(), ENROLLED);

    expect(planned.filter((session) => session.status === "CANCELLED")).toHaveLength(0);
  });
});

describe("enrolling after the block has started (§7)", () => {
  // 2026-09-20T09:00Z: occurrences 0–12 (07–19 Sep) have closed.
  const LATE = new Date("2026-09-20T09:00:00Z");

  it("cancels the occurrences whose windows already closed", () => {
    const planned = planMaterialisation(
      REFERENCE,
      context({ enrolledAt: LATE, consentedAt: LATE }),
      LATE,
    );
    const block = planned.filter((session) => session.stepKey === "daily");

    const cancelled = block.filter((session) => session.status === "CANCELLED");
    expect(cancelled).toHaveLength(13);
    expect(cancelled.map((session) => session.occurrenceIndex)).toEqual(
      Array.from({ length: 13 }, (_, index) => index),
    );
  });

  it("marks them ENROLLED_AFTER_WINDOW, never expired", () => {
    // EXPIRED_UNSTARTED means "offered and not done" and lands in the
    // compliance denominator. These were never offered.
    const planned = planMaterialisation(
      REFERENCE,
      context({ enrolledAt: LATE, consentedAt: LATE }),
      LATE,
    );

    const cancelled = planned.filter((session) => session.status === "CANCELLED");
    expect(cancelled.every((s) => s.cancellationReason === "ENROLLED_AFTER_WINDOW")).toBe(true);
  });

  it("schedules the remaining occurrences normally", () => {
    const planned = planMaterialisation(
      REFERENCE,
      context({ enrolledAt: LATE, consentedAt: LATE }),
      LATE,
    );
    const block = planned.filter((session) => session.stepKey === "daily");

    const scheduled = block.filter((session) => session.status === "SCHEDULED");
    expect(scheduled).toHaveLength(17);
    expect(scheduled[0]?.occurrenceIndex).toBe(13);
    expect(scheduled[0]?.availableFrom?.toISOString()).toBe("2026-09-20T17:00:00.000Z");
  });

  it("still materialises all 32 rows", () => {
    // The denominator must not depend on when someone enrolled.
    expect(
      planMaterialisation(REFERENCE, context({ enrolledAt: LATE, consentedAt: LATE }), LATE),
    ).toHaveLength(32);
  });

  it("marks an occurrence whose window is open right now as AVAILABLE", () => {
    // Only fully-closed windows are cancelled.
    const midWindow = new Date("2026-09-20T20:00:00Z");
    const planned = planMaterialisation(
      REFERENCE,
      context({ enrolledAt: midWindow, consentedAt: midWindow }),
      midWindow,
    );

    const open = planned.filter((s) => s.stepKey === "daily" && s.status === "AVAILABLE");
    expect(open).toHaveLength(1);
    expect(open[0]?.occurrenceIndex).toBe(13);
  });
});

describe("participant-relative steps", () => {
  const dailyRelative = step({
    ...daily,
    triggerType: "STEP_COMPLETED",
    triggerStepId: "s0",
    triggerFixedDate: null,
    timing: { ...daily.timing, offsetIso: "P1D" },
  });

  it("materialises every occurrence as PENDING_TRIGGER with no time yet", () => {
    const planned = planMaterialisation(
      [baseline, dailyRelative],
      context(),
      new Date("2026-09-04T09:12:00Z"),
    );
    const block = planned.filter((session) => session.stepKey === "daily");

    expect(block).toHaveLength(30);
    expect(block.every((s) => s.status === "PENDING_TRIGGER" && s.availableFrom === null)).toBe(
      true,
    );
  });

  it("places them from the completion instant once the baseline is done", () => {
    const completedAt = new Date("2026-09-04T14:40:00Z");

    const propagated = propagateCompletion(
      [baseline, dailyRelative],
      "s0",
      completedAt,
      context(),
      completedAt,
    );

    expect(propagated).toHaveLength(30);
    // Baseline completed 04 Sep 14:40Z; +P1D at 20:00 local = 05 Sep 17:00Z.
    expect(propagated[0]?.availableFrom.toISOString()).toBe("2026-09-05T17:00:00.000Z");
    expect(propagated[29]?.availableFrom.toISOString()).toBe("2026-10-04T17:00:00.000Z");
  });

  it("opens an occurrence immediately when the trigger fires inside its window", () => {
    // A trigger firing late can produce a window that is already open;
    // scheduling it for the past would leave it invisible until a sweep.
    const followUp = step({
      id: "s9",
      stepKey: "follow_up",
      triggerType: "STEP_COMPLETED",
      triggerStepId: "s0",
      timing: { ...baseline.timing, offsetIso: "PT0S" },
    });

    const completedAt = new Date("2026-09-04T14:40:00Z");
    const propagated = propagateCompletion(
      [baseline, followUp],
      "s0",
      completedAt,
      context(),
      completedAt,
    );

    expect(propagated[0]?.status).toBe("AVAILABLE");
  });

  it("propagates nothing for a step triggered by a different one", () => {
    expect(
      // An explicit instant, not `new Date()`: reading the wall clock inside
      // this package is forbidden precisely so a schedule test cannot depend on
      // when it ran (AGENT.md §17).
      propagateCompletion(
        [baseline, dailyRelative],
        "s2",
        new Date("2026-09-04T14:40:00Z"),
        context(),
        new Date("2026-09-04T14:40:00Z"),
      ),
    ).toHaveLength(0);
  });
});

describe("availability-anchored steps are computable at enrollment", () => {
  it("places a step hanging off a named occurrence of the block", () => {
    // Availability is server-computed and independent of what the participant
    // did, which is what makes it the permitted way to follow a block.
    const after = step({
      id: "s3",
      stepKey: "after_block",
      triggerType: "STEP_AVAILABLE",
      triggerStepId: "s1",
      triggerOccurrenceIndex: 29,
      timing: { ...endline.timing, offsetIso: "P1D" },
    });

    const planned = planMaterialisation(
      [baseline, daily, after],
      context(),
      new Date("2026-09-04T09:12:00Z"),
    );
    const session = planned.find((s) => s.stepKey === "after_block");

    // Daily #29 opens 06 Oct 17:00Z; +P1D at 20:00 local = 07 Oct 17:00Z.
    expect(session?.status).toBe("SCHEDULED");
    expect(session?.availableFrom?.toISOString()).toBe("2026-10-07T17:00:00.000Z");
  });
});

describe("steps that produce no session at all", () => {
  it("skips a participant-initiated step", () => {
    // No computable time; a session is created when the participant starts one.
    const onDemand = step({ id: "s5", stepKey: "on_demand", stepKind: "PARTICIPANT_INITIATED" });

    const planned = planMaterialisation(
      [baseline, onDemand],
      context(),
      new Date("2026-09-04T09:12:00Z"),
    );
    expect(planned.filter((s) => s.stepKey === "on_demand")).toHaveLength(0);
  });

  it("skips a step restricted to a group the participant is not in", () => {
    const restricted = step({ id: "s6", stepKey: "arm_b", allowedGroupIds: ["group-b"] });

    const planned = planMaterialisation(
      [baseline, restricted],
      context({ groupId: "group-a" }),
      new Date("2026-09-04T09:12:00Z"),
    );
    expect(planned.filter((s) => s.stepKey === "arm_b")).toHaveLength(0);
  });

  it("includes a restricted step for a participant who IS in the group", () => {
    const restricted = step({ id: "s6", stepKey: "arm_b", allowedGroupIds: ["group-b"] });

    const planned = planMaterialisation(
      [baseline, restricted],
      context({ groupId: "group-b" }),
      new Date("2026-09-04T09:12:00Z"),
    );
    expect(planned.filter((s) => s.stepKey === "arm_b")).toHaveLength(1);
  });

  it("distinguishes never-materialised from cancelled", () => {
    // A row that does not exist was never part of this protocol; a CANCELLED
    // one was, and is excluded from compliance by name.
    const restricted = step({ id: "s6", stepKey: "arm_b", allowedGroupIds: ["group-b"] });

    const planned = planMaterialisation(
      [restricted],
      context({ groupId: "group-a" }),
      new Date("2026-09-04T09:12:00Z"),
    );
    expect(planned).toHaveLength(0);
  });
});

describe("two participants on different dates", () => {
  it("get independent timelines from the same fixed-date protocol", () => {
    const early = planMaterialisation(REFERENCE, context(), new Date("2026-09-04T09:12:00Z"));
    const lateAt = new Date("2026-09-09T09:12:00Z");
    const late = planMaterialisation(
      REFERENCE,
      context({ enrolledAt: lateAt, consentedAt: lateAt }),
      lateAt,
    );

    // The cohort block is the same for both — that is what a fixed date means.
    const earlyBlock = early.filter((s) => s.stepKey === "daily");
    const lateBlock = late.filter((s) => s.stepKey === "daily");
    expect(earlyBlock[0]?.availableFrom?.toISOString()).toBe(
      lateBlock[0]?.availableFrom?.toISOString(),
    );

    // Their baselines differ, because those are anchored on enrollment.
    expect(early.find((s) => s.stepKey === "baseline")?.availableFrom?.toISOString()).toBe(
      "2026-09-04T09:12:00.000Z",
    );
    expect(late.find((s) => s.stepKey === "baseline")?.availableFrom?.toISOString()).toBe(
      "2026-09-09T09:12:00.000Z",
    );
    // And the later participant has already missed the first two occurrences.
    expect(lateBlock.filter((s) => s.status === "CANCELLED")).toHaveLength(2);
  });

  it("gives participant-relative steps genuinely separate timelines", () => {
    const relative = step({
      ...daily,
      triggerType: "STEP_COMPLETED",
      triggerStepId: "s0",
      triggerFixedDate: null,
      timing: {
        ...daily.timing,
        offsetIso: "P1D",
        occurrenceCount: 3,
        recurrenceIntervalIso: "P1D",
      },
    });

    const first = propagateCompletion(
      [baseline, relative],
      "s0",
      new Date("2026-09-04T14:40:00Z"),
      context(),
      new Date("2026-09-04T14:40:00Z"),
    );
    const second = propagateCompletion(
      [baseline, relative],
      "s0",
      new Date("2026-09-09T08:00:00Z"),
      context(),
      new Date("2026-09-09T08:00:00Z"),
    );

    expect(first[0]?.availableFrom.toISOString()).toBe("2026-09-05T17:00:00.000Z");
    expect(second[0]?.availableFrom.toISOString()).toBe("2026-09-10T17:00:00.000Z");
  });
});

describe("unreachable triggers cascade", () => {
  it("finds a step waiting on one that can never complete", () => {
    const followUp = step({
      id: "s7",
      stepKey: "follow_up",
      triggerType: "STEP_COMPLETED",
      triggerStepId: "s0",
    });

    expect(findUnreachable([baseline, followUp], ["s0"])).toEqual(["s7"]);
  });

  it("cascades through a chain", () => {
    // A step waiting on an unreachable one is equally unreachable, and would
    // otherwise sit in PENDING_TRIGGER forever, counting toward a denominator
    // it can never satisfy.
    const middle = step({
      id: "m",
      stepKey: "middle",
      triggerType: "STEP_COMPLETED",
      triggerStepId: "s0",
    });
    const last = step({
      id: "l",
      stepKey: "last",
      triggerType: "STEP_COMPLETED",
      triggerStepId: "m",
    });

    expect(findUnreachable([baseline, middle, last], ["s0"]).sort()).toEqual(["l", "m"]);
  });

  it("leaves an availability-triggered step alone", () => {
    // Availability does not depend on the participant completing anything, so
    // a failed completion upstream does not make it unreachable.
    const after = step({
      id: "a",
      stepKey: "after",
      triggerType: "STEP_AVAILABLE",
      triggerStepId: "s0",
    });

    expect(findUnreachable([baseline, after], ["s0"])).toEqual([]);
  });
});

describe("daylight saving", () => {
  it("keeps a wall-clock block on its local time across a transition", () => {
    const berlinBlock = step({
      id: "b",
      stepKey: "daily",
      triggerType: "FIXED_DATETIME",
      triggerFixedDate: "2026-03-27",
      timing: {
        offsetIso: "PT0S",
        anchorLocalTime: "20:00",
        anchorTimezoneSource: "STUDY",
        windowDurationIso: "PT12H",
        occurrenceCount: 4,
        recurrenceIntervalIso: "P1D",
      },
    });

    const at = new Date("2026-03-20T00:00:00Z");
    const planned = planMaterialisation(
      [berlinBlock],
      context({
        enrolledAt: at,
        consentedAt: at,
        studyTimezone: "Europe/Berlin",
        participantTimezone: "Europe/Berlin",
      }),
      at,
    );

    // Berlin springs forward on 2026-03-29: 27 and 28 Mar are CET (+01:00),
    // 29 and 30 Mar are CEST (+02:00). The local hour is preserved; the UTC
    // instant moves, which is the entire point of wall-clock mode.
    expect(planned[0]?.availableFrom?.toISOString()).toBe("2026-03-27T19:00:00.000Z");
    expect(planned[1]?.availableFrom?.toISOString()).toBe("2026-03-28T19:00:00.000Z");
    expect(planned[2]?.availableFrom?.toISOString()).toBe("2026-03-29T18:00:00.000Z");
    expect(planned[3]?.availableFrom?.toISOString()).toBe("2026-03-30T18:00:00.000Z");
  });
});
