import type { Clock } from "../clock.js";

/**
 * The staleness guard (ADR-005).
 *
 * ADR-005 makes the sweepers authoritative, and that creates a hazard of its
 * own. After a six-hour outage the sweepers wake up and correctly discover
 * every notification that was owed during those six hours. Sending them all is
 * *literally* correct and operationally indefensible: a participant's phone
 * lights up nine times at 04:00, and the burst arrives at an hour nobody chose.
 *
 * So overdue work is not sent late. It is suppressed, with the reason recorded,
 * so the miss is visible in the data as a suppression rather than being either
 * invisible or indistinguishable from a participant who ignored a reminder.
 * The Phase 9 guard chain (STRUCTURE.md §9.1, guard 8) records that as
 * `SUPPRESSED_STALE`.
 *
 * "Older than one reminder interval" is the tolerance ADR-005 names, and it is
 * the right shape: it scales with the study's own cadence. A study that nudges
 * every two hours tolerates two hours of lateness; one that nudges weekly is
 * still happy to send a day late, because on that cadence a day late is still
 * the notification the researcher intended.
 *
 * This decides ONLY lateness. Whether the session is still open, whether the
 * participant withdrew, and whether this reminder already went out are separate
 * guards, checked against canonical state under a row lock.
 */

export interface StalenessDecision {
  /** True when the work is too late to run and must be suppressed instead. */
  readonly stale: boolean;
  /**
   * How overdue the work is. Negative when it is not yet due — reported rather
   * than clamped, because a caller running work ahead of its own schedule has a
   * bug worth seeing.
   */
  readonly ageMs: number;
  /** The tolerance the decision was made against, for the recorded reason. */
  readonly toleranceMs: number;
}

export interface StalenessInput {
  /** When this work was supposed to run, in UTC. */
  readonly scheduledFor: Date;
  /**
   * How late is still acceptable. For a reminder chain this is one reminder
   * interval; see `reminderStalenessToleranceMs`.
   */
  readonly toleranceMs: number;
  readonly clock: Clock;
}

/**
 * Decide whether scheduled work has aged past the point of being worth doing.
 *
 * Boundary: work exactly `toleranceMs` late is NOT stale. The tolerance is
 * stated as "one interval late is still fine", and `>=` would quietly make it
 * "anything up to one interval, exclusive" — a difference nobody reading the
 * policy would predict.
 */
export function classifyStaleness(input: StalenessInput): StalenessDecision {
  const scheduledFor = input.scheduledFor.getTime();
  if (Number.isNaN(scheduledFor)) {
    throw new TypeError("classifyStaleness received an invalid scheduledFor date");
  }

  if (!Number.isFinite(input.toleranceMs) || input.toleranceMs < 0) {
    throw new RangeError(
      `toleranceMs must be a non-negative number of milliseconds, got ${String(input.toleranceMs)}`,
    );
  }

  const ageMs = input.clock.now().getTime() - scheduledFor;

  return {
    stale: ageMs > input.toleranceMs,
    ageMs,
    toleranceMs: input.toleranceMs,
  };
}

/**
 * The tolerance for one link in a reminder chain.
 *
 * `max_reminders` is allowed to be zero — a policy of "notify once, never
 * chase". Such a policy still has an `interval_iso`, but nothing in it is
 * meaningful, and a zero or absent interval would collapse the tolerance to
 * "anything at all late is stale". That would suppress an initial notification
 * delayed by a two-second deploy, which is not what the guard is for.
 *
 * `floorMs` is therefore a real policy decision, not defensive padding: below
 * it, lateness is ordinary scheduling jitter rather than the aftermath of an
 * outage.
 */
export const DEFAULT_STALENESS_FLOOR_MS = 15 * 60_000;

export function reminderStalenessToleranceMs(
  reminderIntervalMs: number,
  floorMs: number = DEFAULT_STALENESS_FLOOR_MS,
): number {
  if (!Number.isFinite(reminderIntervalMs) || reminderIntervalMs < 0) {
    throw new RangeError(
      `reminderIntervalMs must be a non-negative number, got ${String(reminderIntervalMs)}`,
    );
  }
  if (!Number.isFinite(floorMs) || floorMs < 0) {
    throw new RangeError(`floorMs must be a non-negative number, got ${String(floorMs)}`);
  }

  return Math.max(reminderIntervalMs, floorMs);
}
