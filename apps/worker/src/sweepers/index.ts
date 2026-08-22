import type { Pool } from "@lpr/db";
import type { SendDependencies } from "../notifications/send.js";
import { HeartbeatWriter } from "./heartbeat.js";
import { notificationsDueSweeper } from "./notification-sweeper.js";
import { expireSubscriptionsSweeper, pruneSubscriptionsSweeper } from "./push-sweepers.js";
import { activateDueSweeper, expireDueSweeper } from "./session-sweepers.js";
import { ReconciliationRunner } from "./sweep-runner.js";
import type { SweepLogger, Sweeper } from "./sweeper.js";

export * from "./sweeper.js";
export * from "./sweep-lock.js";
export * from "./reconcile.js";
export * from "./heartbeat.js";
export * from "./sweep-runner.js";
export * from "./session-sweepers.js";
export * from "./push-sweepers.js";
export * from "./notification-sweeper.js";

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
 * `sweep.expire_subscriptions` and `sweep.prune_subscriptions` run (Phase 8).
 * They are the subscription table's hygiene: one marks a subscription the push
 * service said had expired, the other deletes dead rows once their retention
 * window has run. PLAN.md called the second "the daily pruning job"; see
 * `push-sweepers.ts` for why it is a sweeper instead.
 *
 * `sweep.notifications_due` runs (Phase 9) — but only when `notifications` is
 * supplied. It is the safety net under the self-chaining reminder chain: it
 * re-derives which link each open session is owed next from
 * `notification_attempts` alone, so a lost job cannot silence a participant,
 * and the whole notification subsystem keeps working with pg-boss switched off.
 *
 * That is now every sweeper STRUCTURE.md §8.4 names. The loop, the
 * cross-replica exclusion, the batching, the per-row locking and the heartbeat
 * were built in ADR-005 and have not needed to change for any of them.
 */
export interface StartReconciliationOptions {
  readonly pool: Pool;
  readonly workerId: string;
  readonly sweepIntervalSeconds: number;
  readonly logger: SweepLogger;
  readonly onError?: (error: Error) => void;
  /**
   * What the notification sweeper needs to actually send. Omitted only where
   * there is nothing to send with — the sweeper is then left unregistered
   * rather than registered and inert, so the startup line tells the truth about
   * what this worker will do.
   */
  readonly notifications?: Omit<SendDependencies, "logger">;
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
    sweepers: options.sweepers ?? [
      activateDueSweeper(),
      expireDueSweeper(),
      expireSubscriptionsSweeper(),
      pruneSubscriptionsSweeper(),
      ...(options.notifications === undefined
        ? []
        : [notificationsDueSweeper(options.notifications)]),
    ],
    heartbeat,
    intervalMs: options.sweepIntervalSeconds * 1000,
    logger: options.logger,
    ...(options.onError === undefined ? {} : { onError: options.onError }),
  });

  runner.start();
  return runner;
}
