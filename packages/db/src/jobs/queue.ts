import PgBoss from "pg-boss";
import type { Pool } from "pg";
import { DEDUPE_TO_QUEUE_POLICY, assertQueueName, type JobDefinition } from "./job-definition.js";

/**
 * The job queue (ADR-004): pg-boss, on the same PostgreSQL database, with no
 * Redis.
 *
 * This class is the only place in the repository that talks to pg-boss. Two
 * things justify wrapping it rather than calling it directly:
 *
 *  1. **Silent drops.** pg-boss inserts a job by joining the queue registry, so
 *     sending to a queue that was never created inserts nothing and returns
 *     `null` — no error, no job, no participant questionnaire. `send()` here
 *     refuses to return normally in that case.
 *
 *  2. **Deduplication that is real.** A `singletonKey` only collapses
 *     duplicates on a queue whose policy indexes it. Set on a `standard` queue
 *     it is accepted, stored, and ignored. `send()` rejects that combination
 *     rather than letting a job run twice under a guarantee that was never in
 *     force.
 *
 * Delivery is at-least-once. Handlers must be idempotent and must re-derive
 * every decision from canonical state — see AGENT.md §8 and ADR-005. Nothing
 * here can make an unsafe handler safe.
 */

/**
 * A database handle pg-boss can execute on. Satisfied by a pool, and — the
 * reason it exists — by a single client inside an open transaction, which is
 * what makes the enqueue in `withJobTransaction` atomic with the domain write.
 */
export interface JobConnection {
  executeSql(text: string, values: unknown[]): Promise<{ rows: unknown[] }>;
}

/** The slice of pg-boss this wrapper uses. Narrow so tests can substitute it. */
export type JobDriver = Pick<
  PgBoss,
  "start" | "stop" | "createQueue" | "send" | "work" | "offWork" | "on"
>;

export interface JobLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/**
 * Log lines carry queue names, job ids and attempt counts — never payloads.
 * A job payload can reference a participant, and AGENT.md §5 forbids putting
 * that in logs by default.
 */
const consoleLogger: JobLogger = {
  info: (message) => console.info(`[jobs] ${message}`),
  warn: (message) => console.warn(`[jobs] ${message}`),
  error: (message) => console.error(`[jobs] ${message}`),
};

/**
 * `owner` — the worker. Installs and migrates the `pgboss` schema, runs
 *           maintenance, and is the only role that may consume jobs.
 * `client` — the API. Enqueues only, and refuses to start if the schema is not
 *           already installed, so a misconfigured deployment fails at boot
 *           rather than at the first participant completion.
 */
export type JobQueueRole = "owner" | "client";

export interface CreateJobQueueOptions {
  /**
   * The process's existing connection pool. Reused deliberately: a second,
   * invisible pool would double the connection count against the database
   * whose connection limit is the binding constraint (ADR-003).
   */
  pool: Pool;
  role: JobQueueRole;
  /** Declared up front so `send()` can tell "deduplicated" from "dropped". */
  definitions?: readonly JobDefinition<unknown>[];
  /** pg-boss owns this schema. Infrastructure, not domain data (ADR-004). */
  schema?: string;
  logger?: JobLogger;
  /** How often idle workers poll for work. Only meaningful for `owner`. */
  pollingIntervalSeconds?: number;
  /** Enables pg-boss cron. The Phase 7 sweepers turn this on (ADR-005). */
  cron?: boolean;
  onError?: (error: Error) => void;
  /** Test seam. Production callers never pass this. */
  driver?: JobDriver;
}

export interface EnqueueOptions {
  /**
   * Collapses duplicate sends. Requires a definition whose `dedupe` is not
   * `none`; see the class comment for why that is enforced rather than assumed.
   */
  singletonKey?: string;
  /**
   * When the job becomes eligible to run. A `Date` is an absolute instant, a
   * number is seconds from now. Always compute the instant from an injected
   * Clock at the call site — this layer does not read the wall clock.
   */
  startAfter?: Date | number;
  priority?: number;
  /** Enqueue on this handle instead of the pool — see `withJobTransaction`. */
  connection?: JobConnection;
}

export type EnqueueResult =
  | { readonly jobId: string; readonly deduplicated: false }
  | { readonly jobId: null; readonly deduplicated: true };

export interface JobContext {
  readonly jobId: string;
  readonly queue: string;
  /** 1 on the first delivery. */
  readonly attempt: number;
  readonly retryLimit: number;
}

export type JobHandler<TPayload> = (payload: TPayload, context: JobContext) => Promise<void>;

export class JobQueueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobQueueError";
  }
}

export class JobEnqueueError extends JobQueueError {
  constructor(message: string) {
    super(message);
    this.name = "JobEnqueueError";
  }
}

export class JobPayloadError extends JobQueueError {
  constructor(
    readonly queue: string,
    readonly jobId: string,
    cause: unknown,
  ) {
    super(
      `Job ${jobId} on queue "${queue}" carries a payload its schema rejects: ` +
        `${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = "JobPayloadError";
  }
}

/** Identifier, not a value: it is interpolated into SQL and cannot be bound. */
const SCHEMA_NAME_PATTERN = /^[a-z_][a-z0-9_]*$/;

export const DEFAULT_JOB_SCHEMA = "pgboss";

export interface DeadLetteredJob {
  readonly id: string;
  readonly queue: string;
  readonly deadLetterQueue: string;
  readonly createdOn: Date;
  /** The failure message pg-boss recorded, with no payload attached. */
  readonly reason: string;
}

export class JobQueue {
  readonly #boss: JobDriver;
  readonly #pool: Pool;
  readonly #schema: string;
  readonly #role: JobQueueRole;
  readonly #logger: JobLogger;
  readonly #registered = new Map<string, JobDefinition<unknown>>();
  #started = false;

  constructor(
    boss: JobDriver,
    options: {
      pool: Pool;
      schema: string;
      role: JobQueueRole;
      logger: JobLogger;
      onError?: (error: Error) => void;
    },
  ) {
    this.#boss = boss;
    this.#pool = options.pool;
    this.#schema = options.schema;
    this.#role = options.role;
    this.#logger = options.logger;

    // pg-boss emits 'error' for background maintenance failures. Node treats an
    // unhandled 'error' event as fatal, so an unlistened queue turns a transient
    // database blip into a dead worker — and a dead worker stops the sweepers
    // that the entire scheduling guarantee rests on (ADR-005).
    this.#boss.on("error", (error: Error) => {
      this.#logger.error(`pg-boss error: ${error.message}`);
      options.onError?.(error);
    });
  }

  get role(): JobQueueRole {
    return this.#role;
  }

  get started(): boolean {
    return this.#started;
  }

  get registeredQueues(): readonly string[] {
    return [...this.#registered.keys()];
  }

  async start(definitions: readonly JobDefinition<unknown>[] = []): Promise<void> {
    if (this.#started) return;

    try {
      await this.#boss.start();
    } catch (error) {
      if (this.#role === "client") {
        throw new JobQueueError(
          `Could not attach to the "${this.#schema}" job schema: ` +
            `${error instanceof Error ? error.message : String(error)}. ` +
            "The worker installs and migrates that schema; start it, or run the " +
            "deployment's migration step, before starting the API.",
        );
      }
      throw error;
    }

    this.#started = true;

    for (const definition of definitions) {
      await this.register(definition);
    }
  }

  /**
   * Create the queue and its dead-letter companion.
   *
   * Idempotent, and called by every process that uses the queue rather than
   * only by the worker. Two reasons: the API must not depend on the worker
   * having booted first, and a queue that exists is the difference between a
   * send that works and a send that silently inserts nothing.
   */
  async register<TPayload>(definition: JobDefinition<TPayload>): Promise<void> {
    this.#assertStarted("register a queue");

    const existing = this.#registered.get(definition.name);
    if (existing) {
      assertSamePolicy(existing, definition as JobDefinition<unknown>);
      return;
    }

    // The dead-letter queue first: pg-boss enforces a foreign key from a job's
    // dead_letter column to a real queue, so the companion must exist before
    // any job can name it. Its own retries are pointless — nothing runs it —
    // and it keeps rows longer, because a dead letter is evidence.
    await this.#boss.createQueue(definition.deadLetterQueue, {
      name: definition.deadLetterQueue,
      policy: "standard",
      retryLimit: 0,
      retentionMinutes: definition.retentionDays * 24 * 60 * 2,
    });

    await this.#boss.createQueue(definition.name, {
      name: definition.name,
      policy: DEDUPE_TO_QUEUE_POLICY[definition.dedupe],
      retryLimit: definition.retry.retryLimit,
      retryDelay: definition.retry.retryDelaySeconds,
      retryBackoff: definition.retry.retryBackoff,
      expireInSeconds: definition.expireInSeconds,
      retentionMinutes: definition.retentionDays * 24 * 60,
      deadLetter: definition.deadLetterQueue,
    });

    this.#registered.set(definition.name, definition as JobDefinition<unknown>);
  }

  /**
   * Enqueue a job.
   *
   * Pass `connection` to enqueue inside an open transaction — that is the
   * property ADR-004 chose pg-boss for, and `withJobTransaction` is the
   * supported way to get one.
   */
  async send<TPayload>(
    definition: JobDefinition<TPayload>,
    payload: TPayload,
    options: EnqueueOptions = {},
  ): Promise<EnqueueResult> {
    this.#assertStarted(`send "${definition.name}"`);

    const registered = this.#registered.get(definition.name);
    if (!registered) {
      throw new JobEnqueueError(
        `Queue "${definition.name}" is not registered in this process. ` +
          "Pass the definition to start(), or call register(), before sending — " +
          "pg-boss drops a send to an unknown queue without raising an error.",
      );
    }

    // The queue in the database was configured from whichever definition
    // registered first. A second definition of the same name would send under a
    // policy that is not the one actually in force.
    assertSamePolicy(registered, definition as JobDefinition<unknown>);

    const dedupes = definition.dedupe !== "none";

    if (options.singletonKey !== undefined && !dedupes) {
      throw new JobEnqueueError(
        `Queue "${definition.name}" is declared dedupe: "none", so the ` +
          "singletonKey would be stored and ignored. Declare how duplicates " +
          "should be collapsed on the job definition instead.",
      );
    }

    if (options.singletonKey === undefined && dedupes) {
      throw new JobEnqueueError(
        `Queue "${definition.name}" is declared dedupe: "${definition.dedupe}" ` +
          "and needs a singletonKey on every send. Without one, pg-boss treats " +
          "the empty key as shared and collapses unrelated jobs into each other.",
      );
    }

    // Validate before the job exists, not when it runs: a payload the handler's
    // schema will reject is a job that can only ever dead-letter, and the caller
    // is the one still holding the context to fix it.
    const validated = definition.payload.parse(payload);

    const jobId = await this.#boss.send(definition.name, validated as object, {
      ...(options.singletonKey === undefined ? {} : { singletonKey: options.singletonKey }),
      ...(options.startAfter === undefined ? {} : { startAfter: options.startAfter }),
      ...(options.priority === undefined ? {} : { priority: options.priority }),
      ...(options.connection === undefined ? {} : { db: options.connection }),
    });

    if (jobId !== null) {
      return { jobId, deduplicated: false };
    }

    // A null id means the insert matched nothing. On a deduplicating queue that
    // is the intended outcome. On any other queue it means the row went nowhere
    // — the exact silent data-loss failure ADR-004 exists to prevent.
    if (dedupes) {
      return { jobId: null, deduplicated: true };
    }

    throw new JobEnqueueError(
      `Enqueue on "${definition.name}" inserted no job and pg-boss reported no error. ` +
        "The queue row is missing from the pgboss schema; the job was dropped.",
    );
  }

  /**
   * Register a handler. Only the worker may consume jobs — an API instance that
   * quietly started processing would run scheduling work on a process that
   * scales to zero.
   */
  async work<TPayload>(
    definition: JobDefinition<TPayload>,
    handler: JobHandler<TPayload>,
    options: { pollingIntervalSeconds?: number } = {},
  ): Promise<string> {
    this.#assertStarted(`work "${definition.name}"`);

    if (this.#role !== "owner") {
      throw new JobQueueError(
        `A "${this.#role}" job queue must not consume jobs. Handlers belong to the worker.`,
      );
    }

    if (!this.#registered.has(definition.name)) {
      throw new JobQueueError(
        `Queue "${definition.name}" is not registered in this process; register it before working it.`,
      );
    }

    // One job per delivery. A batch shares a fate in pg-boss: one failure fails
    // every job in it, so a batch of five would retry four jobs that had already
    // succeeded.
    const workOptions: PgBoss.WorkOptions & { includeMetadata: true } = {
      batchSize: 1,
      includeMetadata: true,
    };
    if (options.pollingIntervalSeconds !== undefined) {
      workOptions.pollingIntervalSeconds = options.pollingIntervalSeconds;
    }

    return await this.#boss.work<TPayload>(definition.name, workOptions, async (jobs) => {
      for (const job of jobs) {
        const context: JobContext = {
          jobId: job.id,
          queue: definition.name,
          attempt: job.retryCount + 1,
          retryLimit: job.retryLimit,
        };

        let payload: TPayload;
        try {
          payload = definition.payload.parse(job.data);
        } catch (error) {
          throw new JobPayloadError(definition.name, job.id, error);
        }

        try {
          await handler(payload, context);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const exhausted = context.attempt > context.retryLimit;
          this.#logger.error(
            `${definition.name} job ${job.id} failed on attempt ` +
              `${String(context.attempt)}/${String(context.retryLimit + 1)}` +
              `${exhausted ? ` — dead-lettering to ${definition.deadLetterQueue}` : ""}: ` +
              message,
          );
          // Rethrown on purpose: pg-boss owns the retry schedule and the
          // dead-letter transition. Swallowing here would mark the job
          // complete and lose the work.
          throw error;
        }
      }
    });
  }

  /**
   * Jobs that exhausted their retries, newest first — the feed behind the
   * operations page (ADR-004).
   *
   * The payload is deliberately not returned. A dead letter is an operational
   * signal, and an operations page is not a place to render data that can
   * identify a participant (AGENT.md §5).
   */
  async deadLetteredJobs<TPayload>(
    definition: JobDefinition<TPayload>,
    limit = 50,
  ): Promise<DeadLetteredJob[]> {
    // Bounded: this feeds a page, and an operator typing a large number should
    // not be able to pull the whole dead-letter history into memory.
    const bounded = Math.min(Math.max(Math.trunc(limit), 1), 500);

    const { rows } = await this.#pool.query<{
      id: string;
      created_on: Date;
      output: unknown;
    }>(
      `SELECT id, created_on, output
         FROM ${this.#schema}.job
        WHERE name = $1
        ORDER BY created_on DESC
        LIMIT $2`,
      [definition.deadLetterQueue, bounded],
    );

    return rows.map((row) => ({
      id: row.id,
      queue: definition.name,
      deadLetterQueue: definition.deadLetterQueue,
      createdOn: row.created_on,
      reason: describeJobFailure(row.output),
    }));
  }

  async stop(options: { graceful?: boolean; timeoutMs?: number } = {}): Promise<void> {
    if (!this.#started) return;

    // Graceful by default: a handler killed mid-transaction leaves the job to be
    // retried, which is safe, but finishing the one in flight is cheaper than
    // re-deriving it.
    await this.#boss.stop({
      graceful: options.graceful ?? true,
      timeout: options.timeoutMs ?? 30_000,
      wait: true,
      // The pool belongs to the process, not to pg-boss.
      close: false,
    });

    this.#started = false;
  }

  #assertStarted(action: string): void {
    if (!this.#started) {
      throw new JobQueueError(`Cannot ${action}: the job queue has not been started.`);
    }
  }
}

/**
 * Extract a human-readable reason from pg-boss's recorded failure output
 * without echoing whatever else it serialised.
 */
export function describeJobFailure(output: unknown): string {
  if (output === null || output === undefined) return "no failure detail recorded";

  if (typeof output === "string") return output;

  if (typeof output === "object") {
    const value = (output as { value?: unknown }).value;
    if (typeof value === "string") return value;
    if (value !== null && typeof value === "object") {
      const message = (value as { message?: unknown }).message;
      if (typeof message === "string") return message;
    }
    const message = (output as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }

  return "failure detail not in a recognised shape";
}

/**
 * Two definitions of the same queue must agree on delivery policy.
 *
 * Only the first one to register configures the queue in the database, so a
 * second, differing definition would enqueue under a policy that is not the one
 * in force — a job that looks deduplicated and is not, or that retries a
 * different number of times than its author believes.
 */
function assertSamePolicy(
  registered: JobDefinition<unknown>,
  incoming: JobDefinition<unknown>,
): void {
  const differences: string[] = [];

  if (registered.dedupe !== incoming.dedupe) {
    differences.push(`dedupe ${registered.dedupe} vs ${incoming.dedupe}`);
  }
  if (registered.retry.retryLimit !== incoming.retry.retryLimit) {
    differences.push(
      `retryLimit ${String(registered.retry.retryLimit)} vs ${String(incoming.retry.retryLimit)}`,
    );
  }
  if (registered.retry.retryDelaySeconds !== incoming.retry.retryDelaySeconds) {
    differences.push(
      `retryDelaySeconds ${String(registered.retry.retryDelaySeconds)} vs ` +
        `${String(incoming.retry.retryDelaySeconds)}`,
    );
  }
  if (registered.retry.retryBackoff !== incoming.retry.retryBackoff) {
    differences.push(
      `retryBackoff ${String(registered.retry.retryBackoff)} vs ${String(incoming.retry.retryBackoff)}`,
    );
  }
  if (registered.expireInSeconds !== incoming.expireInSeconds) {
    differences.push(
      `expireInSeconds ${String(registered.expireInSeconds)} vs ${String(incoming.expireInSeconds)}`,
    );
  }

  if (differences.length > 0) {
    throw new JobQueueError(
      `Queue "${incoming.name}" is already registered with a different delivery policy ` +
        `(${differences.join(", ")}). One job name means one policy.`,
    );
  }
}

export function createJobQueue(options: CreateJobQueueOptions): JobQueue {
  const schema = options.schema ?? DEFAULT_JOB_SCHEMA;

  if (!SCHEMA_NAME_PATTERN.test(schema)) {
    throw new JobQueueError(`"${schema}" is not a valid PostgreSQL schema name for the job queue.`);
  }

  const definitions = options.definitions ?? [];
  for (const definition of definitions) {
    assertQueueName(definition.name);
  }

  const isOwner = options.role === "owner";

  const boss =
    options.driver ??
    new PgBoss({
      // pg-boss runs on the process's pool rather than opening its own. Note
      // that this also means pg-boss will not close it on stop().
      db: {
        executeSql: async (text: string, values: unknown[]) =>
          await options.pool.query(text, values),
      },
      schema,
      // Only the worker may create or migrate the schema. An API instance that
      // migrated on boot would race every other instance during a rolling
      // deploy.
      migrate: isOwner,
      supervise: isOwner,
      schedule: isOwner && (options.cron ?? false),
      ...(options.pollingIntervalSeconds === undefined
        ? {}
        : { pollingIntervalSeconds: options.pollingIntervalSeconds }),
    });

  return new JobQueue(boss, {
    pool: options.pool,
    schema,
    role: options.role,
    logger: options.logger ?? consoleLogger,
    ...(options.onError === undefined ? {} : { onError: options.onError }),
  });
}
