import { describe, expect, it } from "vitest";
import {
  classifyStepDependencies,
  validateTriggerGraph,
  type TriggerGraphStep,
} from "./trigger-graph.js";

/**
 * The rules under test are FR-48 and ADR-011. The worked case throughout is
 * `docs/reference-protocol.md`: a baseline, a thirty-occurrence daily block,
 * and an endline that must survive a participant ignoring every daily report.
 */

const step = (
  overrides: Partial<TriggerGraphStep> & { id: string; stepKey: string },
): TriggerGraphStep => ({
  triggerType: "ENROLLMENT",
  triggerStepId: null,
  triggerOccurrenceIndex: null,
  occurrenceCount: 1,
  ...overrides,
});

const BASELINE = step({ id: "s1", stepKey: "baseline" });
const DAILY = step({
  id: "s2",
  stepKey: "daily",
  triggerType: "FIXED_DATETIME",
  occurrenceCount: 30,
});

describe("the reference protocol publishes", () => {
  it("accepts mode A: three steps, none referencing another", () => {
    const endline = step({ id: "s3", stepKey: "endline", triggerType: "FIXED_DATETIME" });

    expect(validateTriggerGraph([BASELINE, DAILY, endline]).ok).toBe(true);
  });

  it("accepts mode B: the daily block and the endline both hang off the baseline", () => {
    // Both reference the BASELINE, never each other, so daily adherence cannot
    // make the endline unreachable (`docs/reference-protocol.md` §5).
    const daily = step({
      id: "s2",
      stepKey: "daily",
      triggerType: "STEP_COMPLETED",
      triggerStepId: "s1",
      occurrenceCount: 30,
    });
    const endline = step({
      id: "s3",
      stepKey: "endline",
      triggerType: "STEP_COMPLETED",
      triggerStepId: "s1",
    });

    expect(validateTriggerGraph([BASELINE, daily, endline]).ok).toBe(true);
  });
});

describe("FR-48c — outcome independence", () => {
  it("rejects a step triggered by the completion of a recurring step", () => {
    const endline = step({
      id: "s3",
      stepKey: "endline",
      triggerType: "STEP_COMPLETED",
      triggerStepId: "s2",
      triggerOccurrenceIndex: 29,
    });

    const result = validateTriggerGraph([BASELINE, DAILY, endline]);

    expect(result.ok).toBe(false);
    expect(result.problems).toContainEqual({
      code: "COMPLETION_OF_RECURRING_STEP",
      stepKey: "endline",
      referencedStepKey: "daily",
      occurrenceCount: 30,
    });
  });

  it("rejects it whichever occurrence is named, including the first", () => {
    const after = step({
      id: "s3",
      stepKey: "endline",
      triggerType: "STEP_COMPLETED",
      triggerStepId: "s2",
      triggerOccurrenceIndex: 0,
    });

    expect(validateTriggerGraph([BASELINE, DAILY, after]).ok).toBe(false);
  });

  it("permits STEP_AVAILABLE against the same recurring step", () => {
    // Availability is computed by the server and does not depend on what the
    // participant did, which is the documented escape hatch.
    const after = step({
      id: "s3",
      stepKey: "endline",
      triggerType: "STEP_AVAILABLE",
      triggerStepId: "s2",
      triggerOccurrenceIndex: 29,
    });

    expect(validateTriggerGraph([BASELINE, DAILY, after]).ok).toBe(true);
  });

  it("permits completion-triggering a step that happens only once", () => {
    const followUp = step({
      id: "s3",
      stepKey: "follow_up",
      triggerType: "STEP_COMPLETED",
      triggerStepId: "s1",
    });

    expect(validateTriggerGraph([BASELINE, followUp]).ok).toBe(true);
  });
});

describe("FR-48a — determinacy", () => {
  it("rejects an unqualified reference to a recurring step", () => {
    const after = step({
      id: "s3",
      stepKey: "endline",
      triggerType: "STEP_AVAILABLE",
      triggerStepId: "s2",
    });

    const result = validateTriggerGraph([BASELINE, DAILY, after]);

    expect(result.ok).toBe(false);
    expect(result.problems[0]).toMatchObject({
      code: "RECURRING_TRIGGER_NEEDS_OCCURRENCE",
      stepKey: "endline",
      referencedStepKey: "daily",
      occurrenceCount: 30,
    });
  });

  it("rejects an occurrence index past the end of the block", () => {
    // Thirty occurrences are indices 0–29. Naming 30 is a step that can never
    // fire, reached by an off-by-one.
    const after = step({
      id: "s3",
      stepKey: "endline",
      triggerType: "STEP_AVAILABLE",
      triggerStepId: "s2",
      triggerOccurrenceIndex: 30,
    });

    const result = validateTriggerGraph([BASELINE, DAILY, after]);

    expect(result.ok).toBe(false);
    expect(result.problems[0]?.code).toBe("OCCURRENCE_INDEX_OUT_OF_RANGE");
  });

  it("accepts the last valid occurrence index", () => {
    const after = step({
      id: "s3",
      stepKey: "endline",
      triggerType: "STEP_AVAILABLE",
      triggerStepId: "s2",
      triggerOccurrenceIndex: 29,
    });

    expect(validateTriggerGraph([BASELINE, DAILY, after]).ok).toBe(true);
  });
});

describe("structural validity", () => {
  it("rejects a reference to a step that is not in this version", () => {
    const orphan = step({
      id: "s3",
      stepKey: "orphan",
      triggerType: "STEP_COMPLETED",
      triggerStepId: "does-not-exist",
    });

    const result = validateTriggerGraph([BASELINE, orphan]);

    expect(result.problems).toContainEqual({
      code: "DANGLING_TRIGGER_REFERENCE",
      stepKey: "orphan",
    });
  });

  it("rejects a cycle and names the steps in it", () => {
    const a = step({ id: "a", stepKey: "a", triggerType: "STEP_COMPLETED", triggerStepId: "b" });
    const b = step({ id: "b", stepKey: "b", triggerType: "STEP_COMPLETED", triggerStepId: "a" });

    const result = validateTriggerGraph([a, b]);

    expect(result.ok).toBe(false);
    const cycle = result.problems.find((problem) => problem.code === "TRIGGER_CYCLE");
    expect(cycle?.cycle).toEqual(["a", "b", "a"]);
  });

  it("rejects a step that triggers on itself", () => {
    const self = step({
      id: "a",
      stepKey: "loop",
      triggerType: "STEP_COMPLETED",
      triggerStepId: "a",
    });

    expect(validateTriggerGraph([self]).problems[0]?.code).toBe("TRIGGER_CYCLE");
  });

  it("reports one cycle once, not once per step in it", () => {
    const a = step({ id: "a", stepKey: "a", triggerType: "STEP_COMPLETED", triggerStepId: "b" });
    const b = step({ id: "b", stepKey: "b", triggerType: "STEP_COMPLETED", triggerStepId: "c" });
    const c = step({ id: "c", stepKey: "c", triggerType: "STEP_COMPLETED", triggerStepId: "a" });

    const cycles = validateTriggerGraph([a, b, c]).problems.filter(
      (problem) => problem.code === "TRIGGER_CYCLE",
    );

    expect(cycles).toHaveLength(1);
  });

  it("rejects two steps sharing an export key", () => {
    const twin = step({ id: "s9", stepKey: "baseline" });

    expect(validateTriggerGraph([BASELINE, twin]).problems).toContainEqual({
      code: "DUPLICATE_STEP_KEY",
      stepKey: "baseline",
    });
  });

  it("reports every problem at once rather than the first", () => {
    const dangling = step({
      id: "s3",
      stepKey: "orphan",
      triggerType: "STEP_COMPLETED",
      triggerStepId: "nope",
    });
    const unqualified = step({
      id: "s4",
      stepKey: "after_daily",
      triggerType: "STEP_AVAILABLE",
      triggerStepId: "s2",
    });

    const result = validateTriggerGraph([BASELINE, DAILY, dangling, unqualified]);

    expect(result.problems.map((problem) => problem.code).sort()).toEqual([
      "DANGLING_TRIGGER_REFERENCE",
      "RECURRING_TRIGGER_NEEDS_OCCURRENCE",
    ]);
  });

  it("accepts one questionnaire version referenced by two steps (FR-47)", () => {
    // Nothing in the graph mentions questionnaires: reuse is simply not a
    // structural concern, which is what "through the ordinary path" means.
    const endline = step({ id: "s3", stepKey: "endline", triggerType: "FIXED_DATETIME" });

    expect(validateTriggerGraph([BASELINE, endline]).ok).toBe(true);
  });
});

describe("FR-48b — dependency classification", () => {
  it("calls a step anchored on enrollment unconditional", () => {
    const [baseline] = classifyStepDependencies([BASELINE]);

    expect(baseline?.kind).toBe("UNCONDITIONAL");
    expect(baseline?.dependsOnCompletionOf).toEqual([]);
  });

  it("calls mode A's three steps all unconditional", () => {
    const endline = step({ id: "s3", stepKey: "endline", triggerType: "FIXED_DATETIME" });

    const kinds = classifyStepDependencies([BASELINE, DAILY, endline]).map((s) => s.kind);

    expect(kinds).toEqual(["UNCONDITIONAL", "UNCONDITIONAL", "UNCONDITIONAL"]);
  });

  it("calls mode B's daily and endline conditional on the baseline", () => {
    const daily = step({
      id: "s2",
      stepKey: "daily",
      triggerType: "STEP_COMPLETED",
      triggerStepId: "s1",
      occurrenceCount: 30,
    });
    const endline = step({
      id: "s3",
      stepKey: "endline",
      triggerType: "STEP_COMPLETED",
      triggerStepId: "s1",
    });

    const classified = classifyStepDependencies([BASELINE, daily, endline]);

    expect(classified[1]).toEqual({
      stepKey: "daily",
      kind: "CONDITIONAL",
      dependsOnCompletionOf: ["baseline"],
    });
    expect(classified[2]).toEqual({
      stepKey: "endline",
      kind: "CONDITIONAL",
      dependsOnCompletionOf: ["baseline"],
    });
  });

  it("does not treat availability as a dependency", () => {
    // A window opening is a fact about the schedule, not about the participant.
    const after = step({
      id: "s3",
      stepKey: "endline",
      triggerType: "STEP_AVAILABLE",
      triggerStepId: "s2",
      triggerOccurrenceIndex: 29,
    });

    const classified = classifyStepDependencies([BASELINE, DAILY, after]);

    expect(classified[2]?.kind).toBe("UNCONDITIONAL");
  });

  it("follows a chain and names every completion it passes through, nearest first", () => {
    const middle = step({
      id: "s2",
      stepKey: "middle",
      triggerType: "STEP_COMPLETED",
      triggerStepId: "s1",
    });
    const last = step({
      id: "s3",
      stepKey: "last",
      triggerType: "STEP_COMPLETED",
      triggerStepId: "s2",
    });

    const classified = classifyStepDependencies([BASELINE, middle, last]);

    expect(classified[2]?.dependsOnCompletionOf).toEqual(["middle", "baseline"]);
  });

  it("stays total on a cyclic draft rather than looping forever", () => {
    // The cycle is rejected by validateTriggerGraph; the preview still has to
    // render something for a draft the researcher is halfway through.
    const a = step({ id: "a", stepKey: "a", triggerType: "STEP_COMPLETED", triggerStepId: "b" });
    const b = step({ id: "b", stepKey: "b", triggerType: "STEP_COMPLETED", triggerStepId: "a" });

    const classified = classifyStepDependencies([a, b]);

    expect(classified).toHaveLength(2);
    expect(classified[0]?.kind).toBe("CONDITIONAL");
  });
});
