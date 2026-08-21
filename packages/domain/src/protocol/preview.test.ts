import { describe, expect, it } from "vitest";
import { previewProtocol, type HypotheticalParticipant, type PreviewStepInput } from "./preview.js";

/**
 * The acceptance criterion for Phase 4's preview: it must show exactly the
 * instants tabulated in `docs/reference-protocol.md` §6, for both anchor modes.
 *
 * Every number below is that study's configuration, reproduced as a fixture.
 * None of it may become a default anywhere in application code.
 */

const STUDY_ZONE = "Europe/Istanbul";

/** The participant from §6: enrolls 04 Sep 09:12Z, completes baseline 14:40Z. */
const PARTICIPANT: HypotheticalParticipant = {
  enrolledAt: new Date("2026-09-04T09:12:00Z"),
  participantTimezone: "Europe/Istanbul",
  completions: { baseline: new Date("2026-09-04T14:40:00Z") },
};

const CORE_V1 = "11111111-1111-4111-8111-111111111111";
const DAILY_V1 = "22222222-2222-4222-8222-222222222222";

const baseline: PreviewStepInput = {
  id: "s0",
  stepKey: "baseline",
  questionnaireVersionId: CORE_V1,
  triggerType: "ENROLLMENT",
  triggerStepId: null,
  triggerOccurrenceIndex: null,
  triggerFixedDate: null,
  occurrenceCount: 1,
  timing: {
    offsetIso: "PT0S",
    anchorLocalTime: null,
    anchorTimezoneSource: null,
    windowDurationIso: "P3D",
    occurrenceCount: 1,
    recurrenceIntervalIso: null,
  },
};

/** Mode A: the cohort's designated start day, 20:00 in the participant's zone. */
const dailyModeA: PreviewStepInput = {
  id: "s1",
  stepKey: "daily",
  questionnaireVersionId: DAILY_V1,
  triggerType: "FIXED_DATETIME",
  triggerStepId: null,
  triggerOccurrenceIndex: null,
  triggerFixedDate: "2026-09-07",
  occurrenceCount: 30,
  timing: {
    offsetIso: "PT0S",
    anchorLocalTime: "20:00",
    anchorTimezoneSource: "PARTICIPANT",
    windowDurationIso: "PT12H",
    occurrenceCount: 30,
    recurrenceIntervalIso: "P1D",
  },
};

/** The endline shares the block's ORIGIN — it is not chained to it (FR-48c). */
const endlineModeA: PreviewStepInput = {
  id: "s2",
  stepKey: "endline",
  // The same questionnaire version as the baseline: one instrument, two
  // administrations (FR-47).
  questionnaireVersionId: CORE_V1,
  triggerType: "FIXED_DATETIME",
  triggerStepId: null,
  triggerOccurrenceIndex: null,
  triggerFixedDate: "2026-09-07",
  occurrenceCount: 1,
  timing: {
    offsetIso: "P30D",
    anchorLocalTime: "20:00",
    anchorTimezoneSource: "PARTICIPANT",
    windowDurationIso: "P3D",
    occurrenceCount: 1,
    recurrenceIntervalIso: null,
  },
};

describe("mode A — fixed cohort date", () => {
  const steps = [baseline, dailyModeA, endlineModeA];

  it("reproduces the tabulated instants exactly", () => {
    const preview = previewProtocol(steps, PARTICIPANT, STUDY_ZONE);
    const [base, daily, endline] = preview.steps;

    expect(base?.occurrences?.[0]?.availableFrom.toISOString()).toBe("2026-09-04T09:12:00.000Z");
    expect(base?.occurrences?.[0]?.availableUntil.toISOString()).toBe("2026-09-07T09:12:00.000Z");

    expect(daily?.occurrences?.[0]?.availableFrom.toISOString()).toBe("2026-09-07T17:00:00.000Z");
    expect(daily?.occurrences?.[0]?.availableUntil.toISOString()).toBe("2026-09-08T05:00:00.000Z");
    expect(daily?.occurrences?.[29]?.availableFrom.toISOString()).toBe("2026-10-06T17:00:00.000Z");

    expect(endline?.occurrences?.[0]?.availableFrom.toISOString()).toBe("2026-10-07T17:00:00.000Z");
    expect(endline?.occurrences?.[0]?.availableUntil.toISOString()).toBe(
      "2026-10-10T17:00:00.000Z",
    );
  });

  it("gives the participant 32 sessions", () => {
    // §8 of the reference document: 1 + 30 + 1.
    expect(previewProtocol(steps, PARTICIPANT, STUDY_ZONE).totalOccurrences).toBe(32);
  });

  it("labels all three steps unconditional", () => {
    const preview = previewProtocol(steps, PARTICIPANT, STUDY_ZONE);

    expect(preview.steps.map((step) => step.dependency)).toEqual([
      "UNCONDITIONAL",
      "UNCONDITIONAL",
      "UNCONDITIONAL",
    ]);
  });

  it("still delivers the endline to a participant who completes nothing", () => {
    // The property FR-48c exists to protect, stated as a test.
    const nobody: HypotheticalParticipant = { ...PARTICIPANT, completions: {} };

    const preview = previewProtocol(steps, nobody, STUDY_ZONE);

    expect(preview.steps[2]?.occurrences?.[0]?.availableFrom.toISOString()).toBe(
      "2026-10-07T17:00:00.000Z",
    );
  });

  it("shows one questionnaire version administered at two steps", () => {
    const preview = previewProtocol(steps, PARTICIPANT, STUDY_ZONE);

    expect(preview.steps[0]?.questionnaireVersionId).toBe(CORE_V1);
    expect(preview.steps[2]?.questionnaireVersionId).toBe(CORE_V1);
  });
});

describe("mode B — participant-relative", () => {
  // Both the block and the endline hang off the BASELINE, never off each other.
  const dailyModeB: PreviewStepInput = {
    ...dailyModeA,
    triggerType: "STEP_COMPLETED",
    triggerStepId: "s0",
    triggerFixedDate: null,
    timing: { ...dailyModeA.timing, offsetIso: "P1D" },
  };
  const endlineModeB: PreviewStepInput = {
    ...endlineModeA,
    triggerType: "STEP_COMPLETED",
    triggerStepId: "s0",
    triggerFixedDate: null,
    timing: { ...endlineModeA.timing, offsetIso: "P31D" },
  };

  const steps = [baseline, dailyModeB, endlineModeB];

  it("reproduces §5's instants from the baseline completion", () => {
    const preview = previewProtocol(steps, PARTICIPANT, STUDY_ZONE);
    const [, daily, endline] = preview.steps;

    // Baseline completed 04 Sep 14:40Z; +P1D at 20:00 local = 05 Sep 17:00Z.
    expect(daily?.occurrences?.[0]?.availableFrom.toISOString()).toBe("2026-09-05T17:00:00.000Z");
    expect(daily?.occurrences?.[29]?.availableFrom.toISOString()).toBe("2026-10-04T17:00:00.000Z");
    expect(endline?.occurrences?.[0]?.availableFrom.toISOString()).toBe("2026-10-05T17:00:00.000Z");
    expect(endline?.occurrences?.[0]?.availableUntil.toISOString()).toBe(
      "2026-10-08T17:00:00.000Z",
    );
  });

  it("labels both dependent steps conditional on the baseline", () => {
    const preview = previewProtocol(steps, PARTICIPANT, STUDY_ZONE);

    expect(preview.steps[1]).toMatchObject({
      dependency: "CONDITIONAL",
      dependsOnCompletionOf: ["baseline"],
    });
    expect(preview.steps[2]).toMatchObject({
      dependency: "CONDITIONAL",
      dependsOnCompletionOf: ["baseline"],
    });
  });

  it("shows a participant who never completes the baseline receiving nothing after it", () => {
    // Acceptable and unavoidable — the baseline is the study's entry point —
    // but the researcher has to be able to SEE it before publishing.
    const nobody: HypotheticalParticipant = { ...PARTICIPANT, completions: {} };

    const preview = previewProtocol(steps, nobody, STUDY_ZONE);

    expect(preview.steps[0]?.occurrences).not.toBeNull();
    expect(preview.steps[1]?.occurrences).toBeNull();
    expect(preview.steps[1]?.unresolvedReason).toBe("PREREQUISITE_NOT_COMPLETED");
    expect(preview.steps[2]?.unresolvedReason).toBe("PREREQUISITE_NOT_COMPLETED");
    expect(preview.totalOccurrences).toBe(1);
  });

  it("is the contrast with mode A: there, nothing is lost", () => {
    const nobody: HypotheticalParticipant = { ...PARTICIPANT, completions: {} };

    const modeA = previewProtocol([baseline, dailyModeA, endlineModeA], nobody, STUDY_ZONE);
    const modeB = previewProtocol(steps, nobody, STUDY_ZONE);

    expect(modeA.totalOccurrences).toBe(32);
    expect(modeB.totalOccurrences).toBe(1);
  });
});

describe("availability-anchored steps", () => {
  it("resolves from a named occurrence of a recurring step without needing completion", () => {
    const after: PreviewStepInput = {
      ...endlineModeA,
      triggerType: "STEP_AVAILABLE",
      triggerStepId: "s1",
      triggerOccurrenceIndex: 29,
      triggerFixedDate: null,
      timing: {
        ...endlineModeA.timing,
        offsetIso: "P1D",
      },
    };

    const nobody: HypotheticalParticipant = { ...PARTICIPANT, completions: {} };
    const preview = previewProtocol([baseline, dailyModeA, after], nobody, STUDY_ZONE);

    // Daily #29 opens 06 Oct 17:00Z; +P1D at 20:00 local = 07 Oct 17:00Z.
    expect(preview.steps[2]?.occurrences?.[0]?.availableFrom.toISOString()).toBe(
      "2026-10-07T17:00:00.000Z",
    );
    expect(preview.steps[2]?.dependency).toBe("UNCONDITIONAL");
  });
});

describe("a half-built draft still renders", () => {
  it("reports a dangling reference rather than throwing", () => {
    const orphan: PreviewStepInput = {
      ...endlineModeA,
      triggerType: "STEP_COMPLETED",
      triggerStepId: "does-not-exist",
      triggerFixedDate: null,
    };

    const preview = previewProtocol([baseline, orphan], PARTICIPANT, STUDY_ZONE);

    expect(preview.steps[1]?.occurrences).toBeNull();
    expect(preview.steps[1]?.unresolvedReason).toBe("PREREQUISITE_MISSING");
  });

  it("terminates on a cycle instead of recursing forever", () => {
    const a: PreviewStepInput = {
      ...endlineModeA,
      id: "a",
      stepKey: "a",
      triggerType: "STEP_AVAILABLE",
      triggerStepId: "b",
      triggerFixedDate: null,
    };
    const b: PreviewStepInput = { ...a, id: "b", stepKey: "b", triggerStepId: "a" };

    const preview = previewProtocol([a, b], PARTICIPANT, STUDY_ZONE);

    expect(preview.steps).toHaveLength(2);
    expect(preview.totalOccurrences).toBe(0);
  });
});

describe("the participant's zone", () => {
  it("keeps the designated day the same day for a participant further west", () => {
    // The bug this guards: resolving the cohort's start DATE to an instant in
    // the study's zone makes a westward participant read it as the day before,
    // shifting their entire schedule by one day.
    const preview = previewProtocol(
      [dailyModeA],
      { ...PARTICIPANT, participantTimezone: "Europe/London" },
      STUDY_ZONE,
    );

    // 07 Sep 20:00 BST = 19:00Z — still the 7th.
    expect(preview.steps[0]?.occurrences?.[0]?.availableFrom.toISOString()).toBe(
      "2026-09-07T19:00:00.000Z",
    );
  });
});
