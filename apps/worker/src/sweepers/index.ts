import type { Pool } from "@lpr/db";
import { HeartbeatWriter } from "./heartbeat.js";
import { activateDueSweeper, expireDueSweeper } from "./session-sweepers.js";
import { ReconciliationRunner } from "./sweep-runner.js";
import type { SweepLogger, Sweeper } from "./sweeper.js";

export * from "./sweeper.js";
export * from "./sweep-lock.js";
export * from "./reconcile.js";
export * from "./heartbeat.js";
export * from "./sweep-runner.js";
export * from "./session-sweepers.js";

/**
 * Composition for the reconciliation loop (ADR-005).
 *
 * ── What is registered here, and what is not ────────────────────────────────
 *
 * `sweep.heartbeat` runs. It is the sweeper that needs no domain tables, and
 * without it the other three could stop without anyone finding out.
 *
 * `sweep.activate_due` and `sweep.expire_due` run (Phase 7). Between them they
 * ARE the scheduling guarantee: wipe every job in the queue and these two
 * restore correct state within one cycle, because they ask the database what is
 * true rather than what the queue remembers.
 *
 * `sweep.notifications_due` is NOT registered — `notification_attempts` does
 * not exist yet, and Phase 7 deliberately ships no notifications. Sessions
 * become available silently, which is what keeps this phase reviewable.
 * Registering it later is adding one more entry to the array below; the loop,
 * the cross-replica exclusion, the batching, the per-row locking and the
 * heartbeat are already here and already tested against a real PostgreSQL.
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
    sweepers: options.sweepers ?? [activateDueSweeper(), expireDueSweeper()],
    heartbeat,
    intervalMs: options.sweepIntervalSeconds * 1000,
    logger: options.logger,
    ...(options.onError === undefined ? {} : { onError: options.onError }),
  });

  runner.start();
  return runner;
}
