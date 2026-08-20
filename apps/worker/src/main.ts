// Must be the FIRST import: populates process.env before anything reads it.
import "./config/load-env.js";
import "reflect-metadata";
import * as Sentry from "@sentry/node";
import { createJobQueue, createPool, type JobQueue, type Pool } from "@lpr/db";
import { loadWorkerEnv } from "./config/env.js";

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
 * Current scope: the queue itself, with ZERO job definitions and ZERO handlers
 * registered. `session.activate`, `session.expire`, `notification.send`,
 * `protocol.materialize` and the four sweepers arrive in Phase 7 against the
 * handler contract in ADR-005 — every one of them re-derives its decision from
 * canonical state and is safe to run twice, out of order, or a week late.
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

  // One pool for the process, shared with pg-boss. A queue that opened its own
  // pool would double this process's connection count against a database whose
  // connection limit is the binding constraint (ADR-003).
  const pool: Pool = createPool({
    connectionString: env.DATABASE_URL,
    max: 5,
    // Log and carry on. The pool reconnects; the process must survive, because
    // a worker that dies on a database blip stops the sweepers.
    onError: (error) => console.error(`worker pool idle client error: ${error.message}`),
  });

  const queue: JobQueue = createJobQueue({
    pool,
    role: "owner",
    onError: (error) => Sentry.captureException(error),
  });

  await queue.start();

  console.log(
    `worker started (${env.NODE_ENV}); pg-boss connected as queue owner; ` +
      `${String(queue.registeredQueues.length)} queues, 0 handlers, 0 sweepers registered; ` +
      `sweep interval configured at ${String(env.SWEEP_INTERVAL_SECONDS)}s`,
  );

  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    // A second SIGTERM during a rolling deploy must not cut short the graceful
    // stop already in progress.
    if (shuttingDown) return;
    shuttingDown = true;

    console.log(`worker received ${signal}, stopping the job queue…`);
    try {
      // Graceful: an in-flight handler finishes its transaction rather than
      // being killed halfway through one.
      await queue.stop({ graceful: true });
    } catch (error) {
      console.error(`worker failed to stop the job queue cleanly: ${describe(error)}`);
    } finally {
      await pool.end().catch((error: unknown) => {
        console.error(`worker failed to close the pool: ${describe(error)}`);
      });
    }
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
