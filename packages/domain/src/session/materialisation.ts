import {
  computeOccurrenceWindows,
  type StepOrigin,
  type StepTiming,
  type TimingZones,
} from "../protocol/timing.js";
import { isStepReferencingTrigger, type TriggerType } from "@lpr/contracts";

/**
 * Materialisation (STRUCTURE.md §8.2, PLAN.md Phase 7).
 *
 * At enrollment, every step of the bound protocol version is expanded into the
 * sessions that step will ever produce for this participant — all of them, in
 * one transaction, immediately.
 *
 * ── Why upfront and not lazily ──────────────────────────────────────────────
 * Materialising on demand would mean the compliance denominator is unknown
 * until the study ends, and the participant timeline could not show what is
 * coming. More seriously, a partially materialised enrollment is a participant
 * with a silently truncated protocol that no sweeper can detect: the sweepers
 * reconcile the sessions that EXIST against the clock, not against the protocol
 * they should have come from.
 *
 * This function is pure. It reads no clock and touches no database — `now` and
 * the participant's context come in as arguments, which is what lets a
 * thirty-day protocol crossing two daylight-saving transitions be asserted
 * instant-by-instant in a unit test.
 */

export interface MaterialisableStep {
  readonly id: string;
  readonly stepKey: string;
  readonly questionnaireVersionId: string;
  readonly stepKind: "SCHEDULED" | "PARTICIPANT_INITIATED";
  readonly triggerType: TriggerType;
  readonly triggerStepId: string | null;
  readonly triggerOccurrenceIndex: number | null;
  readonly triggerFixedDate: string | null;
  readonly timing: StepTiming;
  /** Empty means every group (FR-45). */
  readonly allowedGroupIds: readonly string[];
}

export interface MaterialisationContext {
  readonly enrolledAt: Date;
  readonly consentedAt: Date;
  readonly participantTimezone: string | null;
  readonly studyTimezone: string;
  /** Null in a study with no groups. */
  readonly groupId: string | null;
}

export type PlannedStatus = "PENDING_TRIGGER" | "SCHEDULED" | "AVAILABLE" | "CANCELLED";

export interface PlannedSession {
  readonly protocolStepId: string;
  readonly stepKey: string;
  readonly occurrenceIndex: number;
  readonly questionnaireVersionId: string;
  readonly status: PlannedStatus;
  readonly availableFrom: Date | null;
  readonly availableUntil: Date | null;
  readonly cancellationReason: "ENROLLED_AFTER_WINDOW" | null;
}

/**
 * Plan every session this enrollment creates.
 *
 * Two kinds of step never produce a row at all, and the difference from a
 * cancelled row matters: a session that does not exist was never part of this
 * participant's protocol, while a CANCELLED one was and is excluded from
 * compliance by name.
 *
 *   • a step whose `allowed_group_ids` excludes this participant (FR-45)
 *   • a `PARTICIPANT_INITIATED` step, which has no computable time and is
 *     created on demand when the participant starts one (FR-46)
 */
export function planMaterialisation(
  steps: readonly MaterialisableStep[],
  context: MaterialisationContext,
  now: Date,
): readonly PlannedSession[] {
  const zones: TimingZones = {
    studyTimezone: context.studyTimezone,
    participantTimezone: context.participantTimezone,
  };

  const byId = new Map(steps.map((step) => [step.id, step]));
  const windowsByStep = new Map<
    string,
    readonly { availableFrom: Date; availableUntil: Date }[] | null
  >();
  const resolving = new Set<string>();

  /**
   * The windows for a step, or null when its origin depends on something that
   * has not happened yet.
   *
   * Memoised because a `STEP_AVAILABLE` chain would otherwise re-walk its whole
   * prefix at every link, and a thirty-occurrence block is not cheap to place
   * twice.
   */
  const windowsFor = (
    step: MaterialisableStep,
  ): readonly { availableFrom: Date; availableUntil: Date }[] | null => {
    const cached = windowsByStep.get(step.id);
    if (cached !== undefined) return cached;

    // A cycle is rejected before publish; this guard only keeps a malformed
    // version from recursing forever rather than failing an enrollment.
    if (resolving.has(step.id)) return null;
    resolving.add(step.id);

    const origin = resolveOrigin(step);
    const computed =
      origin === null
        ? null
        : computeOccurrenceWindows(step.timing, origin, zones).map((window) => ({
            availableFrom: window.availableFrom,
            availableUntil: window.availableUntil,
          }));

    resolving.delete(step.id);
    windowsByStep.set(step.id, computed);
    return computed;
  };

  const resolveOrigin = (step: MaterialisableStep): StepOrigin | null => {
    switch (step.triggerType) {
      case "ENROLLMENT":
        return { kind: "INSTANT", instant: context.enrolledAt };
      case "CONSENT":
        return { kind: "INSTANT", instant: context.consentedAt };
      case "FIXED_DATETIME":
        return step.triggerFixedDate === null
          ? null
          : { kind: "CALENDAR_DATE", date: step.triggerFixedDate };
      case "STEP_COMPLETED":
        // Not computable at enrollment by definition — it depends on something
        // the participant has not done yet. The session waits in
        // PENDING_TRIGGER until the completion transaction schedules it.
        return null;
      case "STEP_AVAILABLE": {
        const target = step.triggerStepId === null ? undefined : byId.get(step.triggerStepId);
        if (!target) return null;

        const targetWindows = windowsFor(target);
        if (targetWindows === null) return null;

        const occurrence = targetWindows[step.triggerOccurrenceIndex ?? 0];
        if (!occurrence) return null;
        // Availability is server-computed, so a step hanging off it IS
        // computable at enrollment — which is what makes it the permitted way
        // to follow a recurring block (FR-48c).
        return { kind: "INSTANT", instant: occurrence.availableFrom };
      }
      default:
        return null;
    }
  };

  const planned: PlannedSession[] = [];

  for (const step of steps) {
    if (step.stepKind === "PARTICIPANT_INITIATED") continue;
    if (step.allowedGroupIds.length > 0) {
      if (context.groupId === null || !step.allowedGroupIds.includes(context.groupId)) continue;
    }

    const windows = windowsFor(step);

    if (windows === null) {
      // One row per occurrence even while the time is unknown: the compliance
      // denominator has to know how many measurements this participant owes,
      // and a step that materialised fewer rows once its trigger fired would
      // change that number retroactively.
      for (let index = 0; index < step.timing.occurrenceCount; index += 1) {
        planned.push({
          protocolStepId: step.id,
          stepKey: step.stepKey,
          occurrenceIndex: index,
          questionnaireVersionId: step.questionnaireVersionId,
          status: "PENDING_TRIGGER",
          availableFrom: null,
          availableUntil: null,
          cancellationReason: null,
        });
      }
      continue;
    }

    for (const [index, window] of windows.entries()) {
      planned.push({
        protocolStepId: step.id,
        stepKey: step.stepKey,
        occurrenceIndex: index,
        questionnaireVersionId: step.questionnaireVersionId,
        ...statusAtEnrollment(window, now),
      });
    }
  }

  return planned;
}

/**
 * The state an occurrence starts in, given when the participant enrolled.
 *
 * ── Why an already-closed occurrence is CANCELLED, never EXPIRED ────────────
 * A participant enrolling on the 20th into a block that started on the 7th was
 * never offered occurrences 0–12. `EXPIRED_UNSTARTED` means "offered and not
 * done" and lands in the compliance denominator; charging them for
 * measurements nobody ever showed them would make compliance depend on
 * enrollment date rather than on behaviour, and in a published paper would
 * misdescribe the sample (FR-38, FR-44).
 *
 * The occurrence whose window is OPEN at that instant materialises as
 * AVAILABLE, not CANCELLED — only fully-closed windows are cancelled.
 */
function statusAtEnrollment(
  window: { availableFrom: Date; availableUntil: Date },
  now: Date,
): Pick<PlannedSession, "status" | "availableFrom" | "availableUntil" | "cancellationReason"> {
  const base = { availableFrom: window.availableFrom, availableUntil: window.availableUntil };

  if (now.getTime() >= window.availableUntil.getTime()) {
    return { ...base, status: "CANCELLED", cancellationReason: "ENROLLED_AFTER_WINDOW" };
  }
  if (now.getTime() >= window.availableFrom.getTime()) {
    return { ...base, status: "AVAILABLE", cancellationReason: null };
  }
  return { ...base, status: "SCHEDULED", cancellationReason: null };
}

/**
 * When a step completes, which waiting sessions become schedulable, and at what
 * instants (STRUCTURE.md §8.5 `protocol.materialize`).
 *
 * Runs inside the completion transaction, so the state change and the schedule
 * it implies commit together. A crash between them would otherwise leave a
 * participant whose baseline is complete and whose follow-up never arrives —
 * invisible until the data came back short.
 */
export interface TriggerPropagation {
  readonly protocolStepId: string;
  readonly occurrenceIndex: number;
  readonly availableFrom: Date;
  readonly availableUntil: Date;
  readonly status: "SCHEDULED" | "AVAILABLE";
}

export function propagateCompletion(
  steps: readonly MaterialisableStep[],
  completedStepId: string,
  completedAt: Date,
  context: MaterialisationContext,
  now: Date,
): readonly TriggerPropagation[] {
  const zones: TimingZones = {
    studyTimezone: context.studyTimezone,
    participantTimezone: context.participantTimezone,
  };

  const propagations: TriggerPropagation[] = [];

  for (const step of steps) {
    if (step.triggerType !== "STEP_COMPLETED") continue;
    if (step.triggerStepId !== completedStepId) continue;
    if (step.stepKind === "PARTICIPANT_INITIATED") continue;

    const windows = computeOccurrenceWindows(
      step.timing,
      { kind: "INSTANT", instant: completedAt },
      zones,
    );

    for (const window of windows) {
      propagations.push({
        protocolStepId: step.id,
        occurrenceIndex: window.occurrenceIndex,
        availableFrom: window.availableFrom,
        availableUntil: window.availableUntil,
        // A trigger that fires late can produce a window that is already open;
        // scheduling it for the past would leave it invisible until a sweep.
        status: now.getTime() >= window.availableFrom.getTime() ? "AVAILABLE" : "SCHEDULED",
      });
    }
  }

  return propagations;
}

/**
 * Which waiting sessions can never fire, once a step reached a terminal state
 * without completing (STRUCTURE.md §7).
 *
 * A step triggered by a completion that will never happen would otherwise sit
 * in PENDING_TRIGGER forever, counting toward a denominator it can never
 * satisfy. Cancelling cascades: a step waiting on the cancelled one is equally
 * unreachable.
 */
export function findUnreachable(
  steps: readonly MaterialisableStep[],
  unreachableStepIds: readonly string[],
): readonly string[] {
  const pending = new Set(unreachableStepIds);
  const cancelled = new Set<string>();

  let changed = true;
  while (changed) {
    changed = false;
    for (const step of steps) {
      if (cancelled.has(step.id)) continue;
      if (!isStepReferencingTrigger(step.triggerType)) continue;
      if (step.triggerType !== "STEP_COMPLETED") continue;
      if (step.triggerStepId === null) continue;

      if (pending.has(step.triggerStepId) || cancelled.has(step.triggerStepId)) {
        cancelled.add(step.id);
        changed = true;
      }
    }
  }

  return [...cancelled];
}
