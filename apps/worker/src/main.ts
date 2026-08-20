// Must be the FIRST import: populates process.env before anything reads it.
import "./config/load-env.js";
import "reflect-metadata";
import { hostname } from "node:os";
import * as Sentry from "@sentry/node";
import PgBoss from "pg-boss";
import { createPool } from "@lpr/db";
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
 * The reconciliation loop starts here and runs for the life of the process. It
 * is what makes the scheduling guarantee real, and it does not depend on
 * pg-boss: it asks the database what is true rather than what the queue
 * remembers. `sweep.heartbeat` is registered today; the three session sweepers
 * join the same loop once `participant_sessions` exists (see `sweepers/`).
 *
 * Job handlers are still absent — they arrive in Phase 7 against the handler
 * contract in ADR-005, which `sweepers/reconcile.ts` already implements.
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
   * One pool for the process. The sweep loop runs on it, and it is separate
   * from pg-boss's own connection deliberately in this phase: a queue that
   * cannot connect must not be able to stop the sweepers, because the sweepers
   * are the mechanism that survives the queue failing (ADR-005).
   */
  const pool = createPool({
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

  const boss = new PgBoss({
    connectionString: env.DATABASE_URL,
    // pg-boss owns its own schema. It is infrastructure, not domain data,
    // and is deliberately kept out of `research` and `identity` (ADR-003).
    schema: "pgboss",
  });

  boss.on("error", (error) => {
    console.error("pg-boss error:", error);
    Sentry.captureException(error);
  });

  await boss.start();
  console.log(
    `worker started (${env.NODE_ENV}) as "${workerId}"; pg-boss connected; ` +
      `0 handlers; reconciliation sweeping every ${env.SWEEP_INTERVAL_SECONDS}s`,
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
    await boss.stop({ graceful: true }).catch((error: unknown) => {
      console.error(`worker failed to stop pg-boss cleanly: ${describe(error)}`);
    });

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
  console.error("worker failed to start:", error);
  process.exit(1);
});
