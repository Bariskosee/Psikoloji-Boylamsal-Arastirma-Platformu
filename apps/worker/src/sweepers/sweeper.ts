import type { Pool } from "@lpr/db";

/**
 * What a reconciliation sweeper is (ADR-005, STRUCTURE.md §8.4).
 *
 * A sweeper answers one question against canonical state — "which sessions are
 * due to activate?", "which have run out of time?" — and repairs what it finds.
 * It is not a job handler with a schedule attached. The distinction matters:
 *
 *   A job knows what it was asked to do. A sweeper asks the database what is
 *   true and acts on the answer.
 *
 * That is the whole of ADR-005. A job can be lost, duplicated, delivered a week
 * late, or wiped by a restore, and nothing notices, because the queue is the
 * only record that the work was ever owed. A sweeper cannot lose anything,
 * because it re-derives the entire question from `participant_sessions` and
 * `notification_attempts` every sixty seconds.
 *
 * Every sweeper must therefore be safe to run twice, concurrently, out of
 * order, or after a six-hour outage. `reconcile()` in `reconcile.ts` supplies
 * the transaction and locking discipline that makes that true; a sweeper that
 * hand-rolls its own is a sweeper nobody has checked.
 */

export interface SweepLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface SweepContext {
  readonly pool: Pool;
  readonly logger: SweepLogger;
  /**
   * Aborted when the worker is shutting down. A sweeper mid-batch stops
   * claiming new rows rather than being killed between the lock and the commit
   * — the in-flight row finishes, the rest wait for the next cycle sixty
   * seconds from now. Nothing is lost by stopping early; that is the point of
   * being a sweeper.
   */
  readonly signal: AbortSignal;
}

/**
 * What one sweep did.
 *
 * Counts, never identifiers. An operations dashboard needs to know that 40 rows
 * were claimed and 12 skipped; it does not need — and under AGENT.md §5 must
 * not casually be given — the identity of the participants behind them.
 */
export interface SweepOutcome {
  /** Rows the claim query returned. */
  readonly claimed: number;
  /** Rows whose decision, re-derived under lock, was still valid and applied. */
  readonly acted: number;
  /**
   * Rows that were no longer due once locked, keyed by why. This is the
   * "recording why when research-relevant" of the ADR-005 handler contract, at
   * a granularity that is safe to log: `{ ALREADY_COMPLETED: 3 }`, not three
   * session identifiers.
   */
  readonly skipped: Readonly<Record<string, number>>;
  /** Rows that threw. The batch continues; the cycle is reported unclean. */
  readonly failed: number;
}

export interface Sweeper {
  /**
   * Dotted, stable, and used as the cross-replica lock key: `sweep.activate_due`.
   * Renaming one is therefore not cosmetic — during a rolling deploy the old
   * and new names are different locks, and both would run at once.
   */
  readonly name: string;
  run(context: SweepContext): Promise<SweepOutcome>;
}

export const EMPTY_SWEEP: SweepOutcome = Object.freeze({
  claimed: 0,
  acted: 0,
  skipped: Object.freeze({}),
  failed: 0,
});

/** One line an operator can read without needing to know the sweeper. */
export function describeSweepOutcome(outcome: SweepOutcome): string {
  const skipped = Object.entries(outcome.skipped)
    .map(([reason, count]) => `${reason}=${String(count)}`)
    .join(" ");

  return (
    `claimed=${String(outcome.claimed)} acted=${String(outcome.acted)} ` +
    `failed=${String(outcome.failed)}${skipped ? ` skipped[${skipped}]` : ""}`
  );
}
