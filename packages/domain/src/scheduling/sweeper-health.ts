import type { Clock } from "../clock.js";

/**
 * Judging whether the reconciliation loop is still running (ADR-005).
 *
 * ADR-005 makes the sweepers the authoritative scheduling mechanism, which
 * turns "is the loop running?" into a research-integrity question rather than
 * an operational nicety: a stopped loop means questionnaires that never open
 * and reminders that never fire, with nothing anywhere reporting an error.
 *
 * The judgement lives here, pure and clock-injected, so every boundary case —
 * exactly at the threshold, a heartbeat from the future — is decided by one
 * tested function rather than by an inequality repeated in a worker, a health
 * endpoint and an operations page.
 *
 * The absence of a row is deliberately NOT modelled as a status. A worker with
 * no heartbeat yet is a worker that was deployed seconds ago, and treating that
 * as an outage would raise an alert on every deploy — an alert that fires on
 * every deploy is an alert that gets ignored on the day it matters. Callers
 * handle `null` by waiting for the first cycle.
 */

/** The parts of a `system_heartbeats` row this decision needs. */
export interface SweeperHeartbeat {
  readonly workerId: string;
  /** End of the last completed sweep cycle. */
  readonly sweptAt: Date;
  readonly consecutiveFailures: number;
}

export type SweeperHealthStatus =
  /** Sweeping on time, last cycle clean. */
  | "HEALTHY"
  /** Cycles are completing, but the work inside them keeps failing. */
  | "FAILING"
  /** No cycle has completed within the threshold. The loop has stopped. */
  | "STALE";

export interface SweeperHealth {
  readonly workerId: string;
  readonly status: SweeperHealthStatus;
  /**
   * How long ago the last cycle completed. Negative when the heartbeat is
   * ahead of the clock it is compared against — reported rather than clamped,
   * because a negative age means the two clocks disagree and hiding that would
   * turn a diagnosable configuration fault into a mystery.
   */
  readonly ageMs: number;
  readonly consecutiveFailures: number;
}

/**
 * ADR-005 and STRUCTURE.md §17 both name five minutes.
 *
 * It is five sweep intervals at the default sixty seconds: long enough that a
 * slow cycle, a deploy, or a brief database blip does not page anyone, short
 * enough that the worst case — a participant's questionnaire opening five
 * minutes late — stays far inside every response window the platform supports.
 */
export const HEARTBEAT_STALE_AFTER_MS = 5 * 60_000;

/**
 * How many consecutive failed cycles before a worker counts as FAILING.
 *
 * Not one: a single cycle can fail on a transient deadlock or a connection
 * reset, and the next cycle sixty seconds later repairs it. Three consecutive
 * failures is no longer transient — something is wrong that retrying will not
 * fix.
 */
export const HEARTBEAT_FAILURE_THRESHOLD = 3;

export interface SweeperHealthOptions {
  readonly clock: Clock;
  readonly staleAfterMs?: number;
  readonly failureThreshold?: number;
}

/**
 * Classify one worker's heartbeat.
 *
 * STALE outranks FAILING. A worker that stopped sweeping half an hour ago may
 * well also have been failing when it stopped, but "the loop is not running" is
 * the finding that has to reach an operator first — it is the one that means
 * the scheduling guarantee is currently switched off.
 */
export function classifySweeperHeartbeat(
  heartbeat: SweeperHeartbeat,
  options: SweeperHealthOptions,
): SweeperHealth {
  const sweptAt = heartbeat.sweptAt.getTime();
  if (Number.isNaN(sweptAt)) {
    throw new TypeError("classifySweeperHeartbeat received an invalid sweptAt date");
  }

  const staleAfterMs = options.staleAfterMs ?? HEARTBEAT_STALE_AFTER_MS;
  if (!Number.isFinite(staleAfterMs) || staleAfterMs <= 0) {
    throw new RangeError(
      `staleAfterMs must be a positive number of milliseconds, got ${String(staleAfterMs)}`,
    );
  }

  const failureThreshold = options.failureThreshold ?? HEARTBEAT_FAILURE_THRESHOLD;
  if (!Number.isInteger(failureThreshold) || failureThreshold < 1) {
    throw new RangeError(
      `failureThreshold must be a positive integer, got ${String(failureThreshold)}`,
    );
  }

  const ageMs = options.clock.now().getTime() - sweptAt;

  // Strictly greater: a heartbeat exactly at the threshold is the oldest one
  // still considered on time. The alternative makes the alert fire one
  // millisecond before the deadline it documents.
  const status: SweeperHealthStatus =
    ageMs > staleAfterMs
      ? "STALE"
      : heartbeat.consecutiveFailures >= failureThreshold
        ? "FAILING"
        : "HEALTHY";

  return {
    workerId: heartbeat.workerId,
    status,
    ageMs,
    consecutiveFailures: heartbeat.consecutiveFailures,
  };
}
