import type { Pool } from "@lpr/db";
import type { HeartbeatRecorder } from "./heartbeat.js";
import { LOCK_NOT_ACQUIRED, withSweepLock } from "./sweep-lock.js";
import {
  describeSweepOutcome,
  type SweepContext,
  type SweepLogger,
  type SweepOutcome,
  type Sweeper,
} from "./sweeper.js";

/**
 * The loop that makes ADR-005 true.
 *
 * Every `SWEEP_INTERVAL_SECONDS`, run each sweeper once, then record a
 * heartbeat. That is the entire mechanism behind "the system converges on
 * correct state from any starting condition": queue wiped, worker down for six
 * hours, database restored from a backup, jobs delivered twice — none of it
 * changes what this loop does, because the loop never consults the queue. It
 * asks the database what is true now.
 *
 * Four properties are load-bearing, and each exists because of a specific way
 * this could fail quietly:
 *
 *   **Cycles never overlap.** Rescheduled after the previous cycle finishes,
 *   not on a fixed drumbeat. A `setInterval` whose callback outlives its
 *   period queues callbacks, and the worker's first bad minute becomes an
 *   unbounded pile-up on the database that never recovers.
 *
 *   **One sweeper cannot take down the others.** Each is isolated. If
 *   `sweep.notifications_due` throws on a malformed policy, activation and
 *   expiry must keep running — a participant not being reminded is bad; their
 *   questionnaire never opening is worse.
 *
 *   **A failing cycle still writes a heartbeat**, with the failure recorded.
 *   Skipping the write would surface as "the loop stopped", pointing an
 *   operator at the wrong problem.
 *
 *   **The first cycle runs immediately at startup.** After a restart the whole
 *   point is to converge now, not in sixty seconds. This is what makes a
 *   six-hour outage self-heal the moment the process comes back.
 */

export interface CycleReport {
  readonly startedAt: Date;
  readonly durationMs: number;
  /** By sweeper name. Absent for a sweeper another replica was already running. */
  readonly outcomes: Readonly<Record<string, SweepOutcome>>;
  /** Sweepers skipped because another replica held the lock. */
  readonly skipped: readonly string[];
  /** `name: message`, one per sweeper that threw or reported failed rows. */
  readonly failures: readonly string[];
}

export interface ReconciliationRunnerOptions {
  readonly pool: Pool;
  readonly sweepers: readonly Sweeper[];
  readonly heartbeat: HeartbeatRecorder;
  readonly intervalMs: number;
  readonly logger: SweepLogger;
  /** Wire to Sentry. Called for anything that escapes a single sweeper. */
  readonly onError?: (error: Error) => void;
}

export class ReconciliationRunner {
  readonly #options: ReconciliationRunnerOptions;
  #timer: NodeJS.Timeout | null = null;
  #stopping = false;
  #completedCycles = 0;
  /** The in-flight cycle, so `stop()` can wait for it rather than sever it. */
  #inFlight: Promise<CycleReport> | null = null;
  #abort: AbortController | null = null;

  constructor(options: ReconciliationRunnerOptions) {
    if (!Number.isFinite(options.intervalMs) || options.intervalMs <= 0) {
      throw new RangeError(
        `intervalMs must be a positive number of milliseconds, got ${String(options.intervalMs)}`,
      );
    }
    this.#options = options;
  }

  get running(): boolean {
    return this.#timer !== null || this.#inFlight !== null;
  }

  /**
   * Begin sweeping. Returns as soon as the first cycle is scheduled; the first
   * cycle itself starts on the next tick, so a caller can `start()` and then
   * finish wiring signal handlers without racing it.
   */
  start(): void {
    if (this.#stopping) {
      throw new Error("ReconciliationRunner cannot be restarted after stop()");
    }
    if (this.running) return;

    this.#scheduleNext(0);
  }

  /**
   * Run one cycle now. Public because it is the whole behaviour worth testing,
   * and because an operator recovering from an incident should be able to force
   * convergence without waiting out an interval.
   */
  async runCycle(): Promise<CycleReport> {
    // Serialise against the timer-driven cycle rather than refusing: a manual
    // run during an incident should produce a report, not an error, and the
    // report of the cycle already in progress is an honest answer.
    if (this.#inFlight) return await this.#inFlight;

    // A cycle started after shutdown began would open transactions on a pool
    // that is about to close, and `stop()` — which has already looked at
    // `#inFlight` and found nothing — would not wait for it.
    if (this.#stopping) {
      return { startedAt: new Date(), durationMs: 0, outcomes: {}, skipped: [], failures: [] };
    }

    const abort = new AbortController();
    this.#abort = abort;

    const cycle = this.#executeCycle(abort.signal);
    this.#inFlight = cycle;

    try {
      return await cycle;
    } finally {
      this.#inFlight = null;
      this.#abort = null;
    }
  }

  /**
   * Stop sweeping and wait for the cycle in flight.
   *
   * Waiting rather than severing: a sweeper killed between `SELECT … FOR
   * UPDATE` and `COMMIT` is safe — the transaction rolls back and the next
   * cycle re-derives it — but finishing is cheaper than re-deriving, and it
   * leaves the shutdown log honest about what completed.
   */
  async stop(timeoutMs = 15_000): Promise<void> {
    this.#stopping = true;

    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }

    this.#abort?.abort();

    const inFlight = this.#inFlight;
    if (!inFlight) return;

    await Promise.race([
      inFlight.catch(() => undefined),
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        // The only timer in this class that is unref'd: it exists to bound a
        // shutdown, and must never itself be the reason the process lingers.
        timer.unref();
      }),
    ]);
  }

  #scheduleNext(delayMs: number): void {
    if (this.#stopping) return;

    // NOT unref'd. This loop is the scheduling guarantee; if it were the only
    // thing left running, the correct behaviour is for the process to stay
    // alive, not to exit quietly with the sweepers switched off (ADR-010).
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.#tick();
    }, delayMs);
  }

  async #tick(): Promise<void> {
    try {
      await this.runCycle();
    } catch (error) {
      // Unreachable in practice — `#executeCycle` contains every failure — but
      // a throw that escaped here would silently end the loop, which is the one
      // outcome this class must never have.
      this.#report("reconciliation cycle failed", error);
    } finally {
      this.#scheduleNext(this.#options.intervalMs);
    }
  }

  async #executeCycle(signal: AbortSignal): Promise<CycleReport> {
    const { pool, logger, sweepers, heartbeat, intervalMs } = this.#options;
    // Wall clock in an adapter, for a log line and a duration. Domain decisions
    // take an injected Clock; this is neither (AGENT.md §17).
    const startedAt = new Date();
    const startedAtMs = Date.now();

    const outcomes: Record<string, SweepOutcome> = {};
    const skipped: string[] = [];
    const failures: string[] = [];
    const context: SweepContext = { pool, logger, signal };

    for (const sweeper of sweepers) {
      if (signal.aborted) break;

      try {
        const result = await withSweepLock(
          pool,
          sweeper.name,
          async () => await sweeper.run(context),
        );

        if (result === LOCK_NOT_ACQUIRED) {
          // Expected whenever more than one replica runs. Not a warning: it
          // means another instance is doing this work right now, which is the
          // system behaving as designed.
          skipped.push(sweeper.name);
          continue;
        }

        outcomes[sweeper.name] = result;
        logger.info(`${sweeper.name} ${describeSweepOutcome(result)}`);

        if (result.failed > 0) {
          // Individual rows already logged with their identifiers by
          // `reconcile`. Recorded here so the cycle counts as unclean and the
          // heartbeat says so.
          failures.push(`${sweeper.name}: ${String(result.failed)} row(s) failed`);
        }
      } catch (error) {
        const message = describeError(error);
        failures.push(`${sweeper.name}: ${message}`);
        this.#report(`${sweeper.name} failed`, error);
      }
    }

    const durationMs = Date.now() - startedAtMs;

    // Always, clean or not: a cycle that failed and then wrote no heartbeat
    // would read from outside as a stopped loop.
    try {
      const report = await heartbeat.record({ failures });
      if (report.consecutiveFailures > 0) {
        logger.warn(
          `sweep cycle unclean; consecutive failing cycles: ${String(report.consecutiveFailures)}`,
        );
      }
    } catch (error) {
      this.#report("heartbeat write failed", error);
    }

    this.#completedCycles += 1;

    // Said once, at startup, and never again.
    //
    // Until this line appears, "the loop is running" is an assumption: the
    // startup message only proves the runner was constructed. With no sweepers
    // yet registered and nothing logged per cycle, a worker whose first sweep
    // silently failed would look identical to a healthy one — which is the
    // exact ambiguity ADR-005 exists to remove. Repeating it every cycle would
    // turn the guarantee into log noise and defeat the purpose.
    if (this.#completedCycles === 1) {
      logger.info(
        `first reconciliation cycle complete in ${String(durationMs)}ms ` +
          `(${String(sweepers.length)} sweeper(s), heartbeat written); ` +
          `sweeping every ${String(intervalMs)}ms`,
      );
    }

    if (durationMs > intervalMs) {
      // The loop is no longer keeping up. Sweeps will not overlap — the next is
      // scheduled after this one — but the effective interval has stretched,
      // and with it the recovery window ADR-005 bounds.
      logger.warn(
        `sweep cycle took ${String(durationMs)}ms, longer than the ` +
          `${String(intervalMs)}ms interval; recovery time is now bounded by the cycle, not the interval`,
      );
    }

    return { startedAt, durationMs, outcomes, skipped, failures };
  }

  #report(message: string, error: unknown): void {
    this.#options.logger.error(`${message}: ${describeError(error)}`);
    this.#options.onError?.(error instanceof Error ? error : new Error(String(error)));
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
