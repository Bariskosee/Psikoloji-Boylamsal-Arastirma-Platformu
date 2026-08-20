// Must be the FIRST import: populates process.env before anything reads it.
import "./config/load-env.js";
import "reflect-metadata";
import { hostname } from "node:os";
import * as Sentry from "@sentry/node";
import { createJobQueue, createPool, type JobQueue, type Pool } from "@lpr/db";
import { loadWorkerEnv } from "./config/env.js";
import { startReconciliation } from "./sweepers/index.js";

/**
 * Background worker entry point.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * OPERATIONAL WARNING (ADR-005, ADR-010)
 *
 * This process must run ALWAYS-ON. On a hosting tier that spins services down
 * when idle, the reconciliation sweepers stop running and the entire scheduling
 * correctness guarantee silently disappears — questionnaires never open,
 * reminders never fire, and nothing reports an error.
 *
 * If scheduling ever looks wrong, check `system_heartbeats` first.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The worker is the OWNER of the job system (ADR-004): it installs and migrates
 * the `pgboss` schema, runs pg-boss maintenance, and is the only process
 * permitted to consume jobs. The API attaches to the same queue as a client and
 * enqueues only.
 *
 * The reconciliation loop starts here too and runs for the life of the process.
 * It is what makes the scheduling guarantee real, and it does not depend on
 * pg-boss: it asks the database what is true rather than what the queue
 * remembers. `sweep.heartbeat` is registered today; the three session sweepers
 * join the same loop once `participant_sessions` exists (see `sweepers/`).
 *
 * Current job scope: the queue itself, with ZERO job definitions and ZERO
 * handlers registered. `session.activate`, `session.expire`,
 * `notification.send`, `protocol.materialize` and the four sweepers arrive in
 * Phase 7 against the handler contract in ADR-005, which
 * `sweepers/reconcile.ts` already implements — every one of them re-derives its
 * decision from canonical state and is safe to run twice, out of order, or a
 * week late.
 */
async function bootstrap(): Promise<void> {
  const env = loadWorkerEnv();

  if (env.SENTRY_DSN) {
    Sentry.init({
      dsn: env.SENTRY_DSN,
      environment: env.NODE_ENV,
      sendDefaultPii: false,
      maxBreadcrumbs: 20,
    });
  }

  /**
   * One pool for the process, shared with pg-boss. A queue that opened its own
   * pool would double this process's connection count against a database whose
   * connection limit is the binding constraint (ADR-003).
   *
   * Sharing the pool does not couple the sweepers to the queue: what keeps a
   * broken queue from stopping reconciliation is that `queue.start()` below is
   * allowed to fail, not that the two hold separate connections (ADR-005).
   */
  const pool: Pool = createPool({
    connectionString: env.DATABASE_URL,
    max: 5,
    // Log and carry on. The pool reconnects on its own; the process must
    // survive to let it, because a worker that dies on a database blip stops
    // the sweep loop and silently switches the guarantee off.
    onError: (error) => {
      console.error(`worker pool idle client error: ${error.message}`);
      Sentry.captureException(error);
    },
  });

  /**
   * Stable per instance, not per process: the hostname a container platform
   * assigns survives a restart, so a crash-looping worker keeps updating one
   * heartbeat row instead of leaving permanently-stale orphans behind.
   */
  const workerId = env.WORKER_ID ?? hostname();

  const reconciliation = startReconciliation({
    pool,
    workerId,
    sweepIntervalSeconds: env.SWEEP_INTERVAL_SECONDS,
    logger: {
      info: (message) => console.info(`[sweep] ${message}`),
      warn: (message) => console.warn(`[sweep] ${message}`),
      error: (message) => console.error(`[sweep] ${message}`),
    },
    onError: (error) => Sentry.captureException(error),
  });

  const queue: JobQueue = createJobQueue({
    pool,
    role: "owner",
    onError: (error) => Sentry.captureException(error),
  });

  /**
   * A queue that will not start must NOT take the sweepers down with it.
   *
   * Letting this throw would exit the process, the platform would restart it,
   * and it would fail again — a crash loop in which nothing ever reconciles.
   * Operationally that is indistinguishable from the always-on tier ADR-010
   * warns about: the scheduling guarantee is switched off and the only visible
   * symptom is a restarting container.
   *
   * ADR-005's whole argument is that jobs make the system prompt while sweepers
   * make it correct. A worker with a broken queue is therefore degraded, not
   * useless — questionnaires still open, windows still expire, reminders still
   * go out, each up to one sweep interval late. Staying up and loudly broken
   * strictly dominates restarting quietly forever.
   */
  let queueReady = false;
  try {
    await queue.start();
    queueReady = true;
  } catch (error) {
    console.error(
      `worker could not start the job queue: ${describe(error)}. ` +
        "Continuing WITHOUT the queue: reconciliation sweepers still run, so scheduling " +
        "stays correct but loses its sub-interval timing (ADR-005). Fix the queue.",
    );
    Sentry.captureException(error);
  }

  console.log(
    `worker started (${env.NODE_ENV}) as "${workerId}"; ` +
      `pg-boss ${queueReady ? "connected as queue owner" : "UNAVAILABLE"}; ` +
      `${String(queue.registeredQueues.length)} queues, 0 handlers, 0 sweepers registered; ` +
      `reconciliation sweeping every ${String(env.SWEEP_INTERVAL_SECONDS)}s`,
  );

  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    // A second SIGTERM during a rolling deploy must not cut short the graceful
    // stop already under way.
    if (shuttingDown) return;
    shuttingDown = true;

    console.log(`worker received ${signal}, stopping…`);

    // Sweepers first: stop claiming new work before the things that execute it
    // go away. An interrupted sweep costs nothing — the next cycle re-derives
    // it from canonical state, which is the entire point of ADR-005.
    await reconciliation.stop().catch((error: unknown) => {
      console.error(`worker failed to stop the sweep loop cleanly: ${describe(error)}`);
    });

    // Graceful stop lets in-flight handlers finish, which matters once handlers
    // exist: a handler killed mid-transaction must not leave partial state.
    // Skipped when the queue never started, so shutdown does not report a
    // second failure that only restates the first.
    if (queueReady) {
      await queue.stop({ graceful: true }).catch((error: unknown) => {
        console.error(`worker failed to stop the job queue cleanly: ${describe(error)}`);
      });
    }

    // The pool belongs to the process, not to pg-boss, so it is closed last and
    // by us — `queue.stop()` deliberately leaves it open.
    await pool.end().catch((error: unknown) => {
      console.error(`worker failed to close the pool: ${describe(error)}`);
    });

    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

void bootstrap().catch((error: unknown) => {
  console.error(`worker failed to start: ${describe(error)}`);
  process.exit(1);
});
