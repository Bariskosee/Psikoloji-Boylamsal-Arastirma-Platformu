import type { Pool } from "@lpr/db";
import { HeartbeatWriter } from "./heartbeat.js";
import { ReconciliationRunner } from "./sweep-runner.js";
import type { SweepLogger, Sweeper } from "./sweeper.js";

export * from "./sweeper.js";
export * from "./sweep-lock.js";
export * from "./reconcile.js";
export * from "./heartbeat.js";
export * from "./sweep-runner.js";

/**
 * Composition for the reconciliation loop (ADR-005).
 *
 * ── What is registered here, and what is not ────────────────────────────────
 *
 * `sweep.heartbeat` runs. It is the sweeper that needs no domain tables, and
 * without it the other three could stop without anyone finding out.
 *
 * `sweep.activate_due`, `sweep.expire_due` and `sweep.notifications_due` are
 * NOT registered, because `participant_sessions` and `notification_attempts`
 * do not exist yet — they arrive with the protocol and runtime phases. Each is
 * a `Sweeper` supplying four functions to `reconcile()`, and registering them
 * is adding them to the array below. The loop, the cross-replica exclusion, the
 * batching, the per-row locking and the heartbeat are already here and already
 * tested against a real PostgreSQL, so Phase 7 writes queries, not machinery.
 *
 * Running with one sweeper is not a placeholder standing in for the guarantee.
 * It is the guarantee's foundation: the part that proves the loop runs, and
 * says so out loud when it does not.
 */
export interface StartReconciliationOptions {
  readonly pool: Pool;
  readonly workerId: string;
  readonly sweepIntervalSeconds: number;
  readonly logger: SweepLogger;
  readonly onError?: (error: Error) => void;
  /** Test seam. Production passes nothing and gets the registered set. */
  readonly sweepers?: readonly Sweeper[];
}

export function startReconciliation(options: StartReconciliationOptions): ReconciliationRunner {
  const heartbeat = new HeartbeatWriter({
    pool: options.pool,
    workerId: options.workerId,
    sweepIntervalSeconds: options.sweepIntervalSeconds,
    logger: options.logger,
    // A worker that finds its own previous heartbeat stale was alive but not
    // sweeping — a blocked event loop, a frozen container. It is raised through
    // the same channel as a crash because it has the same consequence: for that
    // window, nothing was reconciling the schedule.
    ...(options.onError === undefined
      ? {}
      : {
          onStale: (health) => {
            options.onError?.(
              new Error(
                `sweep loop stalled: ${health.workerId} did not sweep for ` +
                  `${String(Math.round(health.ageMs / 1000))}s`,
              ),
            );
          },
        }),
  });

  const runner = new ReconciliationRunner({
    pool: options.pool,
    sweepers: options.sweepers ?? [],
    heartbeat,
    intervalMs: options.sweepIntervalSeconds * 1000,
    logger: options.logger,
    ...(options.onError === undefined ? {} : { onError: options.onError }),
  });

  runner.start();
  return runner;
}
