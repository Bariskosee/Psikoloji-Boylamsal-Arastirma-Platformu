/**
 * Job definitions — the contract shared by the process that enqueues a job and
 * the process that runs it (ADR-004).
 *
 * A definition is data, not behaviour. It names the queue, states how the
 * payload is validated, and fixes the delivery policy: how duplicates are
 * collapsed, how often a failure is retried, and where the job lands when the
 * retries run out. Both `apps/api` and `apps/worker` import the same definition,
 * so the two processes cannot disagree about any of it.
 *
 * Handlers themselves live in `apps/worker` and arrive with the scheduling
 * engine in Phase 7. This module is the mechanism, not the schedule.
 */

/**
 * The slice of a schema this package needs in order to validate a payload.
 *
 * Structural on purpose: a Zod schema from `@lpr/contracts` satisfies it
 * directly, so job payload schemas stay in the package that owns schemas
 * (STRUCTURE.md §3) without `@lpr/db` taking a dependency on Zod.
 */
export interface JobPayloadCodec<TPayload> {
  parse(input: unknown): TPayload;
}

/**
 * How duplicate sends of the "same" job are collapsed.
 *
 * The names describe the guarantee rather than the storage mechanism, because
 * the guarantee is what a caller has to reason about. Each maps onto a pg-boss
 * queue policy, and the mapping is not cosmetic: a `singletonKey` on a queue
 * whose policy does not index it is silently ignored, which would leave the
 * system looking deduplicated while quietly running the job twice.
 *
 * `none`          Every send is its own job. The default.
 * `while-queued`  At most one job per key waits in the queue. A second send
 *                 while the first is still waiting is collapsed into it. This
 *                 is the ADR-004 "duplicates are collapsed" behaviour, and the
 *                 right choice for "activate this session" style work.
 * `while-running` At most one job per key runs at a time; another may queue
 *                 behind it. The right choice for sweepers, which must not run
 *                 concurrently across replicas but must keep running.
 * `per-state`     At most one job per key in each pre-completion state.
 */
export type JobDedupe = "none" | "while-queued" | "while-running" | "per-state";

/** The pg-boss queue policies this maps onto. */
export type QueuePolicyName = "standard" | "short" | "singleton" | "stately";

/** pg-boss queue policies, keyed by the guarantee they actually provide. */
export const DEDUPE_TO_QUEUE_POLICY: Readonly<Record<JobDedupe, QueuePolicyName>> = Object.freeze({
  none: "standard",
  "while-queued": "short",
  "while-running": "singleton",
  "per-state": "stately",
});

export interface JobRetryPolicy {
  /** Attempts after the first failure. ADR-004 fixes the default at 5. */
  readonly retryLimit: number;
  /** Base delay in seconds. With backoff on, this is the first interval. */
  readonly retryDelaySeconds: number;
  /** Exponential backoff between attempts (ADR-004). */
  readonly retryBackoff: boolean;
}

/**
 * ADR-004: "retries use exponential backoff with a limit of 5. Exhausted jobs
 * land in the dead-letter queue and surface on the operations page."
 *
 * The base delay is deliberately not 0: pg-boss clamps the first backoff
 * interval to at least one second, and a retry storm against a database that is
 * already struggling is how a small outage becomes a large one.
 */
export const DEFAULT_RETRY_POLICY: JobRetryPolicy = Object.freeze({
  retryLimit: 5,
  retryDelaySeconds: 30,
  retryBackoff: true,
});

/**
 * How long a handler may hold a job before it is treated as lost.
 *
 * Two minutes is far more than any handler here should need — every handler
 * takes a row lock, re-reads state and writes a decision — and short enough
 * that a worker killed mid-job releases it long before the next sweep would
 * have to compensate (ADR-005).
 */
export const DEFAULT_EXPIRE_IN_SECONDS = 120;

/**
 * How long completed and failed job rows are kept.
 *
 * These rows are the evidence for "did the reminder actually fire, and when",
 * so they outlive the job by a wide margin. They are operational data, not
 * research data: the canonical record of what a participant was sent lives in
 * `notification_attempts` (ADR-005), not here.
 */
export const DEFAULT_RETENTION_DAYS = 14;

/** Suffix identifying the dead-letter companion of a queue. */
export const DEAD_LETTER_SUFFIX = ".dlq";

/**
 * Queue names are lowercase, dot-separated segments: `session.activate`,
 * `sweep.activate_due`. The pattern is stricter than pg-boss requires so that a
 * name is predictable in SQL, in logs, and on the operations page.
 */
const QUEUE_NAME_PATTERN = /^[a-z][a-z0-9]*(?:\.[a-z0-9]+(?:_[a-z0-9]+)*)*$/;

const MAX_QUEUE_NAME_LENGTH = 64;

export interface JobDefinition<TPayload> {
  readonly name: string;
  readonly payload: JobPayloadCodec<TPayload>;
  readonly dedupe: JobDedupe;
  readonly retry: JobRetryPolicy;
  readonly expireInSeconds: number;
  readonly retentionDays: number;
  /** Where a job goes once its retries are exhausted. Derived, never guessed. */
  readonly deadLetterQueue: string;
}

export interface DefineJobInput<TPayload> {
  name: string;
  payload: JobPayloadCodec<TPayload>;
  dedupe?: JobDedupe;
  retry?: Partial<JobRetryPolicy>;
  expireInSeconds?: number;
  retentionDays?: number;
}

export class JobDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobDefinitionError";
  }
}

export function deadLetterQueueName(queueName: string): string {
  return `${queueName}${DEAD_LETTER_SUFFIX}`;
}

export function isDeadLetterQueueName(queueName: string): boolean {
  return queueName.endsWith(DEAD_LETTER_SUFFIX);
}

/**
 * Declare a job. Invalid definitions throw at module load, not at the first
 * send: a queue misconfigured in a way that drops or duplicates work should
 * stop the process from booting rather than surface days later as a
 * participant who never received a questionnaire.
 */
export function defineJob<TPayload>(input: DefineJobInput<TPayload>): JobDefinition<TPayload> {
  assertQueueName(input.name);

  if (isDeadLetterQueueName(input.name)) {
    throw new JobDefinitionError(
      `Job name "${input.name}" ends with the reserved ${DEAD_LETTER_SUFFIX} suffix, ` +
        "which names the dead-letter companion of a queue.",
    );
  }

  if (typeof input.payload?.parse !== "function") {
    throw new JobDefinitionError(
      `Job "${input.name}" needs a payload schema exposing parse(). ` +
        "An unvalidated payload is an unvalidated database write one process later.",
    );
  }

  const retry: JobRetryPolicy = {
    ...DEFAULT_RETRY_POLICY,
    ...input.retry,
  };

  if (!Number.isInteger(retry.retryLimit) || retry.retryLimit < 0) {
    throw new JobDefinitionError(
      `Job "${input.name}" has retryLimit ${String(retry.retryLimit)}; expected an integer >= 0.`,
    );
  }

  if (!Number.isInteger(retry.retryDelaySeconds) || retry.retryDelaySeconds < 0) {
    throw new JobDefinitionError(
      `Job "${input.name}" has retryDelaySeconds ${String(retry.retryDelaySeconds)}; ` +
        "expected an integer >= 0.",
    );
  }

  // pg-boss raises a backoff delay of 0 to 1 second anyway. Saying so here
  // keeps the declared policy and the executed policy identical.
  if (retry.retryBackoff && retry.retryDelaySeconds < 1) {
    throw new JobDefinitionError(
      `Job "${input.name}" enables backoff with retryDelaySeconds ${String(
        retry.retryDelaySeconds,
      )}. Backoff needs a base delay of at least 1 second.`,
    );
  }

  const expireInSeconds = input.expireInSeconds ?? DEFAULT_EXPIRE_IN_SECONDS;
  if (!Number.isInteger(expireInSeconds) || expireInSeconds < 1) {
    throw new JobDefinitionError(
      `Job "${input.name}" has expireInSeconds ${String(expireInSeconds)}; expected an integer >= 1.`,
    );
  }

  const retentionDays = input.retentionDays ?? DEFAULT_RETENTION_DAYS;
  if (!Number.isInteger(retentionDays) || retentionDays < 1) {
    throw new JobDefinitionError(
      `Job "${input.name}" has retentionDays ${String(retentionDays)}; expected an integer >= 1.`,
    );
  }

  return Object.freeze({
    name: input.name,
    payload: input.payload,
    dedupe: input.dedupe ?? "none",
    retry: Object.freeze(retry),
    expireInSeconds,
    retentionDays,
    deadLetterQueue: deadLetterQueueName(input.name),
  });
}

export function assertQueueName(name: string): void {
  if (typeof name !== "string" || name.length === 0) {
    throw new JobDefinitionError("A job name is required.");
  }

  if (name.length > MAX_QUEUE_NAME_LENGTH) {
    throw new JobDefinitionError(
      `Job name "${name}" is longer than ${String(MAX_QUEUE_NAME_LENGTH)} characters.`,
    );
  }

  if (!QUEUE_NAME_PATTERN.test(name)) {
    throw new JobDefinitionError(
      `Job name "${name}" is not a lowercase dot-separated name such as "session.activate".`,
    );
  }
}
