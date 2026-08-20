import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { defineJob, type JobDefinition } from "./job-definition.js";
import {
  DEFAULT_JOB_SCHEMA,
  JobEnqueueError,
  JobPayloadError,
  JobQueueError,
  createJobQueue,
  describeJobFailure,
  type JobConnection,
  type JobDriver,
  type JobLogger,
  type JobQueue,
} from "./queue.js";

interface JobPayload {
  sessionId: string;
}

const payloadCodec = {
  parse: (input: unknown): JobPayload => {
    if (
      typeof input !== "object" ||
      input === null ||
      typeof (input as { sessionId?: unknown }).sessionId !== "string"
    ) {
      throw new Error("sessionId is required");
    }
    return { sessionId: (input as JobPayload).sessionId };
  },
};

const activate = defineJob({ name: "session.activate", payload: payloadCodec });

const deduped = defineJob({
  name: "session.expire",
  payload: payloadCodec,
  dedupe: "while-queued",
});

interface WorkerRegistration {
  name: string;
  options: Record<string, unknown>;
  handler: (jobs: unknown[]) => Promise<unknown>;
}

/**
 * A stand-in for pg-boss. Nothing here talks to a database — these tests pin
 * down the decisions the wrapper makes BEFORE and AFTER pg-boss is called.
 * The behaviour of pg-boss itself is covered by the integration lane.
 */
class FakeDriver {
  readonly createQueueCalls: { name: string; options: Record<string, unknown> }[] = [];
  readonly sendCalls: { name: string; data: unknown; options: Record<string, unknown> }[] = [];
  readonly stopCalls: Record<string, unknown>[] = [];
  readonly workers: WorkerRegistration[] = [];
  readonly errorHandlers: ((error: Error) => void)[] = [];
  startCalls = 0;
  startError: Error | null = null;
  /** Job ids returned by successive sends; `null` models "inserted nothing". */
  sendResults: (string | null)[] = [];

  async start(): Promise<unknown> {
    this.startCalls += 1;
    if (this.startError) throw this.startError;
    return this;
  }

  async stop(options: Record<string, unknown>): Promise<void> {
    this.stopCalls.push(options);
  }

  async createQueue(name: string, options: Record<string, unknown>): Promise<void> {
    this.createQueueCalls.push({ name, options });
  }

  async send(
    name: string,
    data: unknown,
    options: Record<string, unknown>,
  ): Promise<string | null> {
    this.sendCalls.push({ name, data, options });
    return this.sendResults.length > 0 ? (this.sendResults.shift() ?? null) : `job-${name}`;
  }

  async work(
    name: string,
    options: Record<string, unknown>,
    handler: (jobs: unknown[]) => Promise<unknown>,
  ): Promise<string> {
    this.workers.push({ name, options, handler });
    return `worker-${name}`;
  }

  async offWork(): Promise<void> {}

  on(_event: string, handler: (error: Error) => void): this {
    this.errorHandlers.push(handler);
    return this;
  }

  /** Deliver a batch the way pg-boss would. */
  async deliver(name: string, jobs: unknown[]): Promise<unknown> {
    const worker = this.workers.find((candidate) => candidate.name === name);
    if (!worker) throw new Error(`no worker registered for ${name}`);
    return await worker.handler(jobs);
  }
}

function fakeJob(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "00000000-0000-0000-0000-0000000000aa",
    name: activate.name,
    data: { sessionId: "s-1" },
    retryCount: 0,
    retryLimit: 5,
    ...overrides,
  };
}

const noopPool = { query: vi.fn() } as unknown as Pool;

function silentLogger(): JobLogger & { errors: string[] } {
  const errors: string[] = [];
  return {
    errors,
    info: () => {},
    warn: () => {},
    error: (message: string) => errors.push(message),
  };
}

function build(options: { role?: "owner" | "client"; logger?: JobLogger } = {}): {
  queue: JobQueue;
  driver: FakeDriver;
} {
  const driver = new FakeDriver();
  const queue = createJobQueue({
    pool: noopPool,
    role: options.role ?? "owner",
    driver: driver as unknown as JobDriver,
    ...(options.logger ? { logger: options.logger } : { logger: silentLogger() }),
  });
  return { queue, driver };
}

describe("queue registration", () => {
  it("creates the dead-letter queue before the queue that references it", async () => {
    const { queue, driver } = build();

    await queue.start([activate as JobDefinition<unknown>]);

    expect(driver.createQueueCalls.map((call) => call.name)).toEqual([
      "session.activate.dlq",
      "session.activate",
    ]);
  });

  it("passes the ADR-004 delivery policy through to the queue", async () => {
    const { queue, driver } = build();

    await queue.start([activate as JobDefinition<unknown>]);

    expect(driver.createQueueCalls[1]?.options).toMatchObject({
      name: "session.activate",
      policy: "standard",
      retryLimit: 5,
      retryDelay: 30,
      retryBackoff: true,
      expireInSeconds: 120,
      deadLetter: "session.activate.dlq",
      retentionMinutes: 14 * 24 * 60,
    });
  });

  it("maps a deduplicating job onto the queue policy that indexes the key", async () => {
    const { queue, driver } = build();

    await queue.start([deduped as JobDefinition<unknown>]);

    expect(driver.createQueueCalls[1]?.options).toMatchObject({ policy: "short" });
  });

  it("keeps dead letters longer than the jobs that produced them", async () => {
    const { queue, driver } = build();

    await queue.start([activate as JobDefinition<unknown>]);

    const dlq = driver.createQueueCalls[0]?.options ?? {};
    expect(dlq["retryLimit"]).toBe(0);
    expect(dlq["retentionMinutes"]).toBeGreaterThan(14 * 24 * 60);
  });

  it("is idempotent across repeated starts and registrations", async () => {
    const { queue, driver } = build();

    await queue.start([activate as JobDefinition<unknown>]);
    await queue.start([activate as JobDefinition<unknown>]);
    await queue.register(activate);

    expect(driver.startCalls).toBe(1);
    expect(driver.createQueueCalls).toHaveLength(2);
    expect(queue.registeredQueues).toEqual(["session.activate"]);
  });

  it("explains what to do when the API cannot attach to the job schema", async () => {
    const driver = new FakeDriver();
    driver.startError = new Error('relation "pgboss.version" does not exist');
    const queue = createJobQueue({
      pool: noopPool,
      role: "client",
      driver: driver as unknown as JobDriver,
      logger: silentLogger(),
    });

    // A client that cannot see the schema must fail at boot, not at the first
    // participant completion.
    await expect(queue.start()).rejects.toThrow(/worker installs and migrates that schema/);
    expect(queue.started).toBe(false);
  });

  it("does not disguise a start failure in the process that owns the schema", async () => {
    const driver = new FakeDriver();
    driver.startError = new Error("connection refused");
    const queue = createJobQueue({
      pool: noopPool,
      role: "owner",
      driver: driver as unknown as JobDriver,
      logger: silentLogger(),
    });

    await expect(queue.start()).rejects.toThrow("connection refused");
  });

  it("rejects a schema name that is not a plain identifier", () => {
    expect(() =>
      createJobQueue({ pool: noopPool, role: "owner", schema: 'pgboss"; drop schema research --' }),
    ).toThrow(JobQueueError);
  });
});

describe("send", () => {
  let queue: JobQueue;
  let driver: FakeDriver;

  beforeEach(async () => {
    ({ queue, driver } = build());
    await queue.start([activate as JobDefinition<unknown>, deduped as JobDefinition<unknown>]);
  });

  it("returns the job id and forwards the validated payload", async () => {
    driver.sendResults = ["job-1"];

    const result = await queue.send(activate, { sessionId: "s-1" });

    expect(result).toEqual({ jobId: "job-1", deduplicated: false });
    expect(driver.sendCalls[0]).toMatchObject({
      name: "session.activate",
      data: { sessionId: "s-1" },
    });
  });

  it("rejects an invalid payload at enqueue rather than at run time", async () => {
    await expect(queue.send(activate, { sessionId: 42 } as unknown as JobPayload)).rejects.toThrow(
      /sessionId is required/,
    );

    expect(driver.sendCalls).toHaveLength(0);
  });

  it("forwards a transaction handle so the job commits with the domain write", async () => {
    const connection: JobConnection = { executeSql: async () => ({ rows: [] }) };

    await queue.send(activate, { sessionId: "s-1" }, { connection });

    expect(driver.sendCalls[0]?.options["db"]).toBe(connection);
  });

  it("forwards scheduling options", async () => {
    const startAfter = new Date("2026-09-01T09:00:00.000Z");

    await queue.send(activate, { sessionId: "s-1" }, { startAfter, priority: 3 });

    expect(driver.sendCalls[0]?.options).toMatchObject({ startAfter, priority: 3 });
  });

  it("reports a collapsed duplicate on a deduplicating queue", async () => {
    driver.sendResults = ["job-1", null];

    const first = await queue.send(deduped, { sessionId: "s-1" }, { singletonKey: "s-1" });
    const second = await queue.send(deduped, { sessionId: "s-1" }, { singletonKey: "s-1" });

    expect(first).toEqual({ jobId: "job-1", deduplicated: false });
    expect(second).toEqual({ jobId: null, deduplicated: true });
  });

  it("throws when pg-boss inserts nothing on a queue that does not deduplicate", async () => {
    // pg-boss inserts a job by joining the queue registry, so a missing queue
    // silently drops the job and reports success. This is the guard that turns
    // that into a loud failure.
    driver.sendResults = [null, null];

    await expect(queue.send(activate, { sessionId: "s-1" })).rejects.toThrow(JobEnqueueError);
    await expect(queue.send(activate, { sessionId: "s-1" })).rejects.toThrow(/dropped/);
  });

  it("refuses a singletonKey the queue policy would ignore", async () => {
    await expect(
      queue.send(activate, { sessionId: "s-1" }, { singletonKey: "s-1" }),
    ).rejects.toThrow(/stored and ignored/);
  });

  it("refuses a send with no key on a deduplicating queue", async () => {
    await expect(queue.send(deduped, { sessionId: "s-1" })).rejects.toThrow(/needs a singletonKey/);
  });

  it("refuses to send to a queue this process never registered", async () => {
    const other = defineJob({ name: "notification.send", payload: payloadCodec });

    await expect(queue.send(other, { sessionId: "s-1" })).rejects.toThrow(/not registered/);
  });

  it("refuses to send before the queue is started", async () => {
    const { queue: fresh } = build();

    await expect(fresh.send(activate, { sessionId: "s-1" })).rejects.toThrow(
      /has not been started/,
    );
  });
});

describe("work", () => {
  it("subscribes one job at a time, with metadata", async () => {
    const { queue, driver } = build();
    await queue.start([activate as JobDefinition<unknown>]);

    await queue.work(activate, async () => {}, { pollingIntervalSeconds: 5 });

    expect(driver.workers[0]?.options).toMatchObject({
      batchSize: 1,
      includeMetadata: true,
      pollingIntervalSeconds: 5,
    });
  });

  it("hands the handler a parsed payload and a one-based attempt count", async () => {
    const { queue, driver } = build();
    await queue.start([activate as JobDefinition<unknown>]);
    const seen: unknown[] = [];

    await queue.work(activate, async (payload, context) => {
      seen.push({ payload, context });
    });
    await driver.deliver(activate.name, [fakeJob({ retryCount: 2 })]);

    expect(seen).toEqual([
      {
        payload: { sessionId: "s-1" },
        context: {
          jobId: "00000000-0000-0000-0000-0000000000aa",
          queue: "session.activate",
          attempt: 3,
          retryLimit: 5,
        },
      },
    ]);
  });

  it("fails a job whose stored payload no longer matches its schema", async () => {
    const { queue, driver } = build();
    await queue.start([activate as JobDefinition<unknown>]);
    const handler = vi.fn();

    await queue.work(activate, handler);

    await expect(
      driver.deliver(activate.name, [fakeJob({ data: { sessionId: 7 } })]),
    ).rejects.toThrow(JobPayloadError);
    expect(handler).not.toHaveBeenCalled();
  });

  it("rethrows a handler failure so pg-boss owns the retry", async () => {
    const logger = silentLogger();
    const { queue, driver } = build({ logger });
    await queue.start([activate as JobDefinition<unknown>]);

    await queue.work(activate, async () => {
      throw new Error("row is locked");
    });

    await expect(driver.deliver(activate.name, [fakeJob()])).rejects.toThrow("row is locked");
    expect(logger.errors[0]).toContain("attempt 1/6");
  });

  it("says where an exhausted job went, and never logs the payload", async () => {
    const logger = silentLogger();
    const { queue, driver } = build({ logger });
    await queue.start([activate as JobDefinition<unknown>]);

    await queue.work(activate, async () => {
      throw new Error("still locked");
    });

    await expect(
      driver.deliver(activate.name, [fakeJob({ retryCount: 5, data: { sessionId: "secret-id" } })]),
    ).rejects.toThrow("still locked");

    expect(logger.errors[0]).toContain("dead-lettering to session.activate.dlq");
    expect(logger.errors[0]).not.toContain("secret-id");
  });

  it("refuses to consume jobs in a client process", async () => {
    const driver = new FakeDriver();
    const queue = createJobQueue({
      pool: noopPool,
      role: "client",
      driver: driver as unknown as JobDriver,
      logger: silentLogger(),
    });
    await queue.start([activate as JobDefinition<unknown>]);

    await expect(queue.work(activate, async () => {})).rejects.toThrow(/must not consume jobs/);
  });

  it("refuses to work an unregistered queue", async () => {
    const { queue } = build();
    await queue.start();

    await expect(queue.work(activate, async () => {})).rejects.toThrow(/not registered/);
  });
});

describe("one job name, one policy", () => {
  it("refuses a second definition of the same queue with a different policy", async () => {
    const { queue } = build();
    await queue.start([activate as JobDefinition<unknown>]);

    const impostor = defineJob({
      name: "session.activate",
      payload: payloadCodec,
      retry: { retryLimit: 2 },
    });

    // Only the first definition configures the queue in the database, so a
    // second one would enqueue under a policy that is not the one in force.
    await expect(queue.register(impostor)).rejects.toThrow(/different delivery policy/);
    await expect(queue.send(impostor, { sessionId: "s-1" })).rejects.toThrow(/retryLimit 5 vs 2/);
  });

  it("accepts a structurally identical definition", async () => {
    const { queue } = build();
    await queue.start([activate as JobDefinition<unknown>]);

    const twin = defineJob({ name: "session.activate", payload: payloadCodec });

    await expect(queue.register(twin)).resolves.toBeUndefined();
    await expect(queue.send(twin, { sessionId: "s-1" })).resolves.toMatchObject({
      deduplicated: false,
    });
  });

  it("names every policy difference it found", async () => {
    const { queue } = build();
    await queue.start([activate as JobDefinition<unknown>]);

    const impostor = defineJob({
      name: "session.activate",
      payload: payloadCodec,
      dedupe: "while-queued",
      retry: { retryDelaySeconds: 10, retryBackoff: false },
      expireInSeconds: 30,
    });

    await expect(queue.register(impostor)).rejects.toThrow(
      /dedupe none vs while-queued.*retryDelaySeconds 30 vs 10.*retryBackoff true vs false.*expireInSeconds 120 vs 30/s,
    );
  });
});

describe("dead-letter listing", () => {
  it("bounds the number of rows an operations page can pull", async () => {
    const pool = { query: vi.fn(async () => ({ rows: [] })) };
    const driver = new FakeDriver();
    const queue = createJobQueue({
      pool: pool as unknown as Pool,
      role: "owner",
      driver: driver as unknown as JobDriver,
      logger: silentLogger(),
    });
    await queue.start([activate as JobDefinition<unknown>]);

    await queue.deadLetteredJobs(activate, 10_000);
    await queue.deadLetteredJobs(activate, 0);

    expect(pool.query.mock.calls[0]?.[1]).toEqual(["session.activate.dlq", 500]);
    expect(pool.query.mock.calls[1]?.[1]).toEqual(["session.activate.dlq", 1]);
  });
});

describe("lifecycle", () => {
  it("stops gracefully and leaves the pool to its owner", async () => {
    const { queue, driver } = build();
    await queue.start();

    await queue.stop();

    expect(driver.stopCalls[0]).toMatchObject({ graceful: true, close: false, wait: true });
    expect(queue.started).toBe(false);
  });

  it("is a no-op when it was never started", async () => {
    const { queue, driver } = build();

    await queue.stop();

    expect(driver.stopCalls).toHaveLength(0);
  });

  it("keeps the process alive when pg-boss emits a background error", async () => {
    const logger = silentLogger();
    const onError = vi.fn();
    const driver = new FakeDriver();
    createJobQueue({
      pool: noopPool,
      role: "owner",
      driver: driver as unknown as JobDriver,
      logger,
      onError,
    });

    // Node makes an unhandled 'error' event fatal. A dead worker stops the
    // sweepers, which is the one failure the whole design refuses to allow.
    expect(driver.errorHandlers).toHaveLength(1);
    driver.errorHandlers[0]?.(new Error("maintenance failed"));

    expect(logger.errors[0]).toContain("maintenance failed");
    expect(onError).toHaveBeenCalledOnce();
  });

  it("defaults to the schema pg-boss owns", () => {
    expect(DEFAULT_JOB_SCHEMA).toBe("pgboss");
  });
});

describe("describeJobFailure", () => {
  it.each([
    [{ message: "boom" }, "boom"],
    [{ value: { message: "boom" } }, "boom"],
    [{ value: "boom" }, "boom"],
    ["boom", "boom"],
  ])("reads the message out of %j", (output, expected) => {
    expect(describeJobFailure(output)).toBe(expected);
  });

  it("says so rather than inventing a reason", () => {
    expect(describeJobFailure(null)).toBe("no failure detail recorded");
    expect(describeJobFailure({ unexpected: true })).toBe(
      "failure detail not in a recognised shape",
    );
  });
});
