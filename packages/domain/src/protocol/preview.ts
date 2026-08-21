import { classifyStepDependencies, type TriggerGraphStep } from "./trigger-graph.js";
import {
  computeOccurrenceWindows,
  type OccurrenceWindow,
  type StepOrigin,
  type StepTiming,
  type TimingZones,
} from "./timing.js";

/**
 * The timeline preview (PLAN.md Phase 4).
 *
 * Answers "what would this protocol do to a participant who enrolled at this
 * instant, in this zone, and completed these steps at these times?" — using the
 * same timing and classification functions the engine will use in Phase 7.
 *
 * That sharing is the requirement, not an optimisation. The preview is the
 * researcher's only defence against misconfiguring a study, and a preview
 * computed by a second implementation can agree with the builder while
 * disagreeing with what participants actually receive. The bug would then be
 * invisible until the data came back wrong.
 *
 * Nothing here reads a clock or a database. The hypothetical participant is an
 * argument, which is also what lets the whole thirty-day reference protocol be
 * asserted instant-by-instant in a unit test.
 */

export interface PreviewStepInput extends TriggerGraphStep {
  readonly questionnaireVersionId: string;
  readonly timing: StepTiming;
  /** Set when `triggerType` is FIXED_DATETIME. */
  readonly triggerFixedDate: string | null;
}

export interface HypotheticalParticipant {
  readonly enrolledAt: Date;
  /** Consent is a separate instant; enrollment is the default when unknown. */
  readonly consentedAt?: Date;
  readonly participantTimezone: string | null;
  /** Completion instants by `stepKey`. Absent means "never completed". */
  readonly completions: Readonly<Record<string, Date>>;
}

export type UnresolvedReason =
  | "PREREQUISITE_NOT_COMPLETED"
  | "PREREQUISITE_UNRESOLVED"
  | "PREREQUISITE_MISSING"
  | "PARTICIPANT_INITIATED";

export interface PreviewedStep {
  readonly stepId: string;
  readonly stepKey: string;
  readonly questionnaireVersionId: string;
  readonly dependency: "UNCONDITIONAL" | "CONDITIONAL";
  readonly dependsOnCompletionOf: readonly string[];
  /** Null when the origin could not be resolved for this participant. */
  readonly occurrences: readonly OccurrenceWindow[] | null;
  readonly unresolvedReason: UnresolvedReason | null;
}

export interface ProtocolPreview {
  readonly steps: readonly PreviewedStep[];
  readonly totalOccurrences: number;
}

export function previewProtocol(
  steps: readonly PreviewStepInput[],
  participant: HypotheticalParticipant,
  studyTimezone: string,
  stepKind: (step: PreviewStepInput) => "SCHEDULED" | "PARTICIPANT_INITIATED" = () => "SCHEDULED",
): ProtocolPreview {
  const zones: TimingZones = {
    studyTimezone,
    participantTimezone: participant.participantTimezone,
  };

  const dependencies = new Map(
    classifyStepDependencies(steps).map((entry) => [entry.stepKey, entry]),
  );
  const byId = new Map(steps.map((step) => [step.id, step]));

  /**
   * Memoised because resolving a step's origin may require resolving the one it
   * follows, and a chain of five steps would otherwise re-walk its whole
   * prefix at every link.
   */
  const resolved = new Map<string, readonly OccurrenceWindow[] | null>();
  const reasons = new Map<string, UnresolvedReason | null>();
  const inProgress = new Set<string>();

  const resolve = (step: PreviewStepInput): readonly OccurrenceWindow[] | null => {
    const cached = resolved.get(step.id);
    if (cached !== undefined) return cached;

    // A cycle is rejected at publish, but the preview must still render a draft
    // the researcher is halfway through building.
    if (inProgress.has(step.id)) return null;
    inProgress.add(step.id);

    const outcome = computeStep(step);
    inProgress.delete(step.id);

    resolved.set(step.id, outcome.windows);
    reasons.set(step.id, outcome.reason);
    return outcome.windows;
  };

  const computeStep = (
    step: PreviewStepInput,
  ): { windows: readonly OccurrenceWindow[] | null; reason: UnresolvedReason | null } => {
    if (stepKind(step) === "PARTICIPANT_INITIATED") {
      // No computable time by definition: a session is created when the
      // participant starts one (FR-46, STRUCTURE.md §8.2).
      return { windows: null, reason: "PARTICIPANT_INITIATED" };
    }

    const origin = resolveOrigin(step);
    if (origin === null) {
      return { windows: null, reason: reasons.get(step.id) ?? "PREREQUISITE_MISSING" };
    }

    return { windows: computeOccurrenceWindows(step.timing, origin, zones), reason: null };
  };

  const resolveOrigin = (step: PreviewStepInput): StepOrigin | null => {
    switch (step.triggerType) {
      case "ENROLLMENT":
        return { kind: "INSTANT", instant: participant.enrolledAt };

      case "CONSENT":
        // Consent precedes enrollment in the flow, and the two are the same
        // instant unless the caller distinguishes them.
        return { kind: "INSTANT", instant: participant.consentedAt ?? participant.enrolledAt };

      case "FIXED_DATETIME":
        if (step.triggerFixedDate === null) {
          reasons.set(step.id, "PREREQUISITE_MISSING");
          return null;
        }
        return { kind: "CALENDAR_DATE", date: step.triggerFixedDate };

      case "STEP_COMPLETED": {
        const target = step.triggerStepId === null ? undefined : byId.get(step.triggerStepId);
        if (!target) {
          reasons.set(step.id, "PREREQUISITE_MISSING");
          return null;
        }
        const completedAt = participant.completions[target.stepKey];
        if (completedAt === undefined) {
          // The case worth showing: a conditional step the participant never
          // reaches because they did not finish what it waits on.
          reasons.set(step.id, "PREREQUISITE_NOT_COMPLETED");
          return null;
        }
        return { kind: "INSTANT", instant: completedAt };
      }

      case "STEP_AVAILABLE": {
        const target = step.triggerStepId === null ? undefined : byId.get(step.triggerStepId);
        if (!target) {
          reasons.set(step.id, "PREREQUISITE_MISSING");
          return null;
        }
        const targetWindows = resolve(target);
        if (targetWindows === null) {
          reasons.set(step.id, "PREREQUISITE_UNRESOLVED");
          return null;
        }
        // Occurrence 0 unless an index was named. A non-recurring target has
        // exactly one, so the default is unambiguous there; FR-48a is what
        // makes it unambiguous for a recurring one.
        const index = step.triggerOccurrenceIndex ?? 0;
        const occurrence = targetWindows[index];
        if (!occurrence) {
          reasons.set(step.id, "PREREQUISITE_MISSING");
          return null;
        }
        return { kind: "INSTANT", instant: occurrence.availableFrom };
      }

      default:
        return null;
    }
  };

  const previewed = steps.map((step): PreviewedStep => {
    const occurrences = resolve(step);
    const dependency = dependencies.get(step.stepKey);

    return {
      stepId: step.id,
      stepKey: step.stepKey,
      questionnaireVersionId: step.questionnaireVersionId,
      dependency: dependency?.kind ?? "UNCONDITIONAL",
      dependsOnCompletionOf: dependency?.dependsOnCompletionOf ?? [],
      occurrences,
      unresolvedReason: occurrences === null ? (reasons.get(step.id) ?? null) : null,
    };
  });

  return {
    steps: previewed,
    totalOccurrences: previewed.reduce((total, step) => total + (step.occurrences?.length ?? 0), 0),
  };
}
