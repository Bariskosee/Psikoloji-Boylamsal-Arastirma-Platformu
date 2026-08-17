import "reflect-metadata";
import * as Sentry from "@sentry/node";
import PgBoss from "pg-boss";
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
 * Phase 0 scope: connect to pg-boss and prove the process starts and stops
 * cleanly. ZERO job handlers and ZERO sweepers are registered — those arrive in
 * Phase 7, against the schema built in Phase 1.
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
    `worker started (${env.NODE_ENV}); pg-boss connected; ` +
      `0 handlers, 0 sweepers registered (Phase 0); ` +
      `sweep interval configured at ${env.SWEEP_INTERVAL_SECONDS}s`,
  );

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`worker received ${signal}, stopping pg-boss…`);
    // Graceful stop lets in-flight handlers finish, which matters once handlers
    // exist: a handler killed mid-transaction must not leave partial state.
    await boss.stop({ graceful: true });
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

void bootstrap().catch((error: unknown) => {
  console.error("worker failed to start:", error);
  process.exit(1);
});
