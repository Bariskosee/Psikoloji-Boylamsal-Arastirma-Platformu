// Must be the FIRST import: populates process.env before anything reads it.
import "./config/load-env.js";
import "reflect-metadata";
import { hostname } from "node:os";
import * as Sentry from "@sentry/node";
import { ALL_JOB_DEFINITIONS, createJobQueue, createPool, type JobQueue, type Pool } from "@lpr/db";
import { isPushConfigured, loadWorkerEnv } from "./config/env.js";
import { registerNotificationHandler } from "./notifications/handler.js";
import type { SendDependencies } from "./notifications/send.js";
import {
  RecordingPushTransport,
  createWebPushTransport,
  type PushTransport,
} from "./notifications/transport.js";
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
 * remembers. Registered today: `sweep.heartbeat`, the two session sweepers from
 * Phase 7, and the two push-subscription sweepers from Phase 8 (see
 * `sweepers/index.ts` for what each one is for and what is still missing).
 *
 * Job scope: `notification.send` (Phase 9), the first and so far only job in
 * the system. Everything else is done by sweepers, which is ADR-005 working as
 * intended rather than a gap — jobs make the system prompt, sweepers make it
 * correct, and a reminder is the first piece of work where promptness is the
 * point. Its safety net, `sweep.notifications_due`, re-derives the same work
 * from canonical state, so losing the queue costs timing and not contact.
 */
async function bootstrap(): Promise<void> {
  const env = loadWorkerEnv();

  /**
   * A holder, because the reconciliation loop starts before the queue does.
   *
   * The loop must start first: it is the correctness guarantee, and it has to
   * survive a queue that never comes up (ADR-005). The notification sweeper
   * still wants to enqueue the next link of a chain when it can, so it reads
   * the queue through this rather than being handed a value that was null at
   * the moment it was constructed.
   */
  const queueRef: { value: JobQueue | null } = { value: null };

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

  const logger = {
    info: (message: string) => console.info(`[sweep] ${message}`),
    warn: (message: string) => console.warn(`[sweep] ${message}`),
    error: (message: string) => console.error(`[sweep] ${message}`),
  };

  /**
   * The push transport (ADR-006).
   *
   * A deployment with no VAPID pair gets the recording transport rather than a
   * refusal to start. The worker runs five sweepers and the entire scheduling
   * guarantee rests on this process staying up (ADR-010); losing that over an
   * optional feature would be a far worse failure than losing push. The
   * recording transport still produces `notification_attempts` rows, so the
   * absence is visible in the data instead of being silence.
   */
  let transport: PushTransport;
  if (isPushConfigured(env)) {
    transport = await createWebPushTransport({
      publicKey: env.VAPID_PUBLIC_KEY,
      privateKey: env.VAPID_PRIVATE_KEY,
      subject: env.VAPID_SUBJECT,
    });
  } else {
    transport = new RecordingPushTransport();
    console.warn(
      "worker has no VAPID key pair: notifications will be RECORDED AND NOT SENT. " +
        "Participants will only see new questionnaires by opening the app (ADR-006).",
    );
  }

  const reconciliation = startReconciliation({
    pool,
    workerId,
    sweepIntervalSeconds: env.SWEEP_INTERVAL_SECONDS,
    logger,
    // The queue is attached AFTER the loop starts, so the sweeper receives it
    // through this holder rather than by value. A sweeper that captured `null`
    // at construction would spend the process's life unable to enqueue the next
    // link, and the chain would advance one sweep interval at a time forever.
    notifications: {
      pool,
      transport,
      get queue() {
        return queueRef.value;
      },
    } as unknown as Omit<SendDependencies, "logger">,
    onError: (error) => Sentry.captureException(error),
  });

  const queue: JobQueue = createJobQueue({
    pool,
    role: "owner",
    definitions: ALL_JOB_DEFINITIONS,
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
    await queue.start(ALL_JOB_DEFINITIONS);
    queueRef.value = queue;

    // Handlers only once the queue is up. Registering against a queue that
    // failed to start would throw and take down the sweepers with it, which is
    // exactly the coupling the try/catch below exists to prevent.
    await registerNotificationHandler(queue, { pool, transport, queue, logger });

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
      `${String(queue.registeredQueues.length)} queues, ` +
      `${queueReady ? "1" : "0"} handlers, ` +
      `${String(reconciliation.sweeperNames.length)} sweepers ` +
      `(${reconciliation.sweeperNames.join(", ")}); ` +
      `reconciliation sweeping every ${String(env.SWEEP_INTERVAL_SECONDS)}s; ` +
      `push ${isPushConfigured(env) ? "ENABLED" : "RECORDED ONLY (no VAPID pair)"}`,
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
