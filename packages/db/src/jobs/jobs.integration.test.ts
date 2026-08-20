import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "../client.js";
import { defineJob } from "./job-definition.js";
import { JobEnqueueError, createJobQueue, type JobQueue } from "./queue.js";
import { withJobTransaction } from "./transaction.js";
import type { Pool } from "pg";

/**
 * Integration tests for the job system (ADR-004). These need a REAL PostgreSQL.
 *
 * The unit tests pin down the decisions this package makes around pg-boss.
 * These prove the decisions pg-boss itself makes are the ones the ADR claims:
 * that an enqueue really does join the caller's transaction, that a
 * `singletonKey` really does collapse duplicates, that five retries really do
 * end in the dead-letter queue, and that a send to a missing queue really is
 * silently dropped — which is why this package refuses to return normally
 * when it happens.
 *
 * Run with: pnpm --filter=@lpr/db test:integration
 */
const connectionString = process.env["DATABASE_URL"];
if (!connectionString) {
  throw new Error(
    "DATABASE_URL is required for integration tests.\n" +
      "  Local:  pnpm db:up && cp .env.example .env\n" +
      "  CI:     provide it in the job environment",
  );
}

/**
 * A throwaway schema, so a test run never touches the `pgboss` schema a
 * developer's worker is using, and never leaves jobs behind in it.
 */
const JOB_SCHEMA = "pgboss_integration_test";
const FIXTURE_SCHEMA = "jobs_integration_test";

const payload = {
  parse: (input: unknown): { marker: string } => {
    const marker = (input as { marker?: unknown } | null)?.marker;
    if (typeof marker !== "string") throw new Error("marker must be a string");
    return { marker };
  },
};

const committed = defineJob({ name: "test.committed", payload });
const collapsing = defineJob({ name: "test.collapsing", payload, dedupe: "while-queued" });
const ghost = defineJob({ name: "test.ghost", payload });
const failing = defineJob({
  name: "test.failing",
  payload,
  // Two retries at a flat one second, so the walk to the dead-letter queue
  // finishes inside a test rather than inside the ADR's real 5×backoff.
  retry: { retryLimit: 2, retryDelaySeconds: 1, retryBackoff: false },
});
const handled = defineJob({ name: "test.handled", payload });

let pool: Pool;
let queue: JobQueue;

async function jobRows(queueName: string): Promise<{ id: string; state: string; data: unknown }[]> {
  const { rows } = await pool.query<{ id: string; state: string; data: unknown }>(
    `SELECT id, state, data FROM ${JOB_SCHEMA}.job WHERE name = $1 ORDER BY created_on`,
    [queueName],
  );
  return rows;
}

async function waitFor(
  label: string,
  predicate: () => Promise<boolean>,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`timed out after ${String(timeoutMs)}ms waiting for ${label}`);
}

beforeAll(async () => {
  pool = createPool({ connectionString, max: 6, onError: () => {} });

  await pool.query(`DROP SCHEMA IF EXISTS ${JOB_SCHEMA} CASCADE`);
  await pool.query(`DROP SCHEMA IF EXISTS ${FIXTURE_SCHEMA} CASCADE`);
  await pool.query(`CREATE SCHEMA ${FIXTURE_SCHEMA}`);
  await pool.query(
    `CREATE TABLE ${FIXTURE_SCHEMA}.domain_writes (marker text primary key, written_at timestamptz not null default now())`,
  );

  queue = createJobQueue({
    pool,
    role: "owner",
    schema: JOB_SCHEMA,
    pollingIntervalSeconds: 1,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });

  await queue.start([committed, collapsing, ghost, failing, handled]);
}, 60_000);

afterAll(async () => {
  await queue.stop({ graceful: false });
  await pool.query(`DROP SCHEMA IF EXISTS ${JOB_SCHEMA} CASCADE`);
  await pool.query(`DROP SCHEMA IF EXISTS ${FIXTURE_SCHEMA} CASCADE`);
  await pool.end();
}, 60_000);

describe("transactional enqueue (ADR-004)", () => {
  it("commits the domain write and its job together", async () => {
    await withJobTransaction({ pool, queue }, async ({ db, enqueue }) => {
      await db.execute(
        sql.raw(`INSERT INTO ${FIXTURE_SCHEMA}.domain_writes (marker) VALUES ('committed-1')`),
      );
      await enqueue(committed, { marker: "committed-1" });
    });

    const writes = await pool.query(
      `SELECT marker FROM ${FIXTURE_SCHEMA}.domain_writes WHERE marker = 'committed-1'`,
    );
    const jobs = await jobRows(committed.name);

    expect(writes.rowCount).toBe(1);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.data).toEqual({ marker: "committed-1" });
  });

  it("leaves no job behind when the domain write fails", async () => {
    // The failure mode this rules out: the database says the session is
    // completed while the queue never received the follow-up job, so the
    // participant's next questionnaire silently never appears.
    await expect(
      withJobTransaction({ pool, queue }, async ({ db, enqueue }) => {
        await db.execute(
          sql.raw(`INSERT INTO ${FIXTURE_SCHEMA}.domain_writes (marker) VALUES ('rolled-back')`),
        );
        await enqueue(committed, { marker: "rolled-back" });
        throw new Error("later step failed");
      }),
    ).rejects.toThrow("later step failed");

    const writes = await pool.query(
      `SELECT marker FROM ${FIXTURE_SCHEMA}.domain_writes WHERE marker = 'rolled-back'`,
    );
    const jobs = await jobRows(committed.name);

    expect(writes.rowCount).toBe(0);
    expect(jobs.map((job) => job.data)).not.toContainEqual({ marker: "rolled-back" });
  });

  it("rolls the write back when the enqueue is the step that fails", async () => {
    await expect(
      withJobTransaction({ pool, queue }, async ({ db, enqueue }) => {
        await db.execute(
          sql.raw(`INSERT INTO ${FIXTURE_SCHEMA}.domain_writes (marker) VALUES ('bad-payload')`),
        );
        await enqueue(committed, { marker: 42 } as unknown as { marker: string });
      }),
    ).rejects.toThrow(/marker must be a string/);

    const writes = await pool.query(
      `SELECT marker FROM ${FIXTURE_SCHEMA}.domain_writes WHERE marker = 'bad-payload'`,
    );

    expect(writes.rowCount).toBe(0);
  });

  it("holds the job invisible to other connections until the commit", async () => {
    let visibleDuringTransaction = 0;

    await withJobTransaction({ pool, queue }, async ({ enqueue }) => {
      await enqueue(committed, { marker: "isolation" });
      // A different connection from the pool: an uncommitted job must not be
      // fetchable by a worker yet.
      const { rows } = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${JOB_SCHEMA}.job WHERE name = $1 AND data->>'marker' = 'isolation'`,
        [committed.name],
      );
      visibleDuringTransaction = Number(rows[0]?.count ?? "0");
    });

    const after = await jobRows(committed.name);

    expect(visibleDuringTransaction).toBe(0);
    expect(
      after.filter((job) => (job.data as { marker: string }).marker === "isolation"),
    ).toHaveLength(1);
  });
});

describe("queue configuration", () => {
  it("writes the ADR-004 retry policy onto the queue itself", async () => {
    const { rows } = await pool.query<{
      policy: string;
      retry_limit: number;
      retry_delay: number;
      retry_backoff: boolean;
      dead_letter: string;
    }>(
      `SELECT policy, retry_limit, retry_delay, retry_backoff, dead_letter
         FROM ${JOB_SCHEMA}.queue WHERE name = $1`,
      [committed.name],
    );

    expect(rows[0]).toMatchObject({
      policy: "standard",
      retry_limit: 5,
      retry_delay: 30,
      retry_backoff: true,
      dead_letter: "test.committed.dlq",
    });
  });

  it("creates a dead-letter queue for every job queue", async () => {
    const { rows } = await pool.query<{ name: string }>(
      `SELECT name FROM ${JOB_SCHEMA}.queue WHERE name LIKE '%.dlq' ORDER BY name`,
    );

    expect(rows.map((row) => row.name)).toEqual([
      "test.collapsing.dlq",
      "test.committed.dlq",
      "test.failing.dlq",
      "test.ghost.dlq",
      "test.handled.dlq",
    ]);
  });
});

describe("deduplication", () => {
  it("collapses a duplicate send while the first job is still queued", async () => {
    const first = await queue.send(collapsing, { marker: "dup" }, { singletonKey: "session-1" });
    const second = await queue.send(collapsing, { marker: "dup" }, { singletonKey: "session-1" });

    expect(first.deduplicated).toBe(false);
    expect(second).toEqual({ jobId: null, deduplicated: true });
    expect(await jobRows(collapsing.name)).toHaveLength(1);
  });

  it("keeps jobs with different keys apart", async () => {
    await queue.send(collapsing, { marker: "other" }, { singletonKey: "session-2" });

    expect(await jobRows(collapsing.name)).toHaveLength(2);
  });
});

describe("the silent-drop guard", () => {
  it("throws when the queue row is missing, instead of losing the job", async () => {
    // pg-boss inserts by joining the queue registry, so a queue that no longer
    // exists means the insert matches nothing and reports success. Reproduce it
    // by deleting the queue out from under a registered definition.
    await pool.query(`SELECT ${JOB_SCHEMA}.delete_queue($1)`, [ghost.name]);

    await expect(queue.send(ghost, { marker: "lost" })).rejects.toThrow(JobEnqueueError);
    await expect(queue.send(ghost, { marker: "lost" })).rejects.toThrow(/dropped/);
  });
});

describe("handlers", () => {
  it("delivers the payload and completes the job", async () => {
    const seen: { marker: string; attempt: number }[] = [];

    await queue.work(handled, async (job, context) => {
      seen.push({ marker: job.marker, attempt: context.attempt });
    });

    await queue.send(handled, { marker: "handled-1" });

    await waitFor("the handler to run", async () => seen.length > 0);
    await waitFor("the job to be marked complete", async () =>
      (await jobRows(handled.name)).some((job) => job.state === "completed"),
    );

    expect(seen).toEqual([{ marker: "handled-1", attempt: 1 }]);
  }, 30_000);

  it("retries a failing job and dead-letters it once the retries run out", async () => {
    const attempts: number[] = [];

    await queue.work(failing, async (_job, context) => {
      attempts.push(context.attempt);
      throw new Error("handler failed deliberately");
    });

    await queue.send(failing, { marker: "doomed" });

    await waitFor(
      "the job to reach the dead-letter queue",
      async () => (await queue.deadLetteredJobs(failing)).length > 0,
    );

    const dead = await queue.deadLetteredJobs(failing);

    // One delivery plus two retries, then the dead letter.
    expect(attempts).toEqual([1, 2, 3]);
    expect(dead).toHaveLength(1);
    expect(dead[0]?.queue).toBe("test.failing");
    expect(dead[0]?.deadLetterQueue).toBe("test.failing.dlq");
    expect(dead[0]?.reason).toBe("handler failed deliberately");

    // The operations page shows that a job died and why — not what it carried.
    expect(Object.keys(dead[0] ?? {})).not.toContain("data");
    expect(JSON.stringify(dead)).not.toContain("doomed");

    const failed = (await jobRows(failing.name)).filter((job) => job.state === "failed");
    expect(failed).toHaveLength(1);
  }, 40_000);
});

describe("the API's client role", () => {
  it("attaches to a schema the worker already installed, and enqueues", async () => {
    const client = createJobQueue({
      pool,
      role: "client",
      schema: JOB_SCHEMA,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });

    try {
      await client.start([committed]);
      const result = await client.send(committed, { marker: "from-the-api" });

      expect(result.deduplicated).toBe(false);
      expect(
        (await jobRows(committed.name)).some(
          (job) => (job.data as { marker: string }).marker === "from-the-api",
        ),
      ).toBe(true);
    } finally {
      await client.stop({ graceful: false });
    }
  }, 30_000);

  it("refuses to consume jobs even though it can reach the queue", async () => {
    const client = createJobQueue({
      pool,
      role: "client",
      schema: JOB_SCHEMA,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });

    try {
      await client.start([committed]);
      await expect(client.work(committed, async () => {})).rejects.toThrow(/must not consume jobs/);
    } finally {
      await client.stop({ graceful: false });
    }
  }, 30_000);

  it("fails at boot, with instructions, when the job schema is not installed", async () => {
    // Better here than at the first participant completion, when the enqueue
    // would be the step that discovers the deployment is misconfigured.
    const client = createJobQueue({
      pool,
      role: "client",
      schema: "pgboss_not_installed_test",
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });

    await expect(client.start([committed])).rejects.toThrow(
      /worker installs and migrates that schema/,
    );
    expect(client.started).toBe(false);
  }, 30_000);
});
