import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createPool, type Pool } from "@lpr/db";
import {
  ACT,
  SWEEP_BATCH_LIMIT,
  noOp,
  reconcile,
  type ReconcileHandlers,
  type SweepClient,
} from "./reconcile.js";
import type { SweepContext, SweepLogger } from "./sweeper.js";

/**
 * The ADR-005 guarantee, against real PostgreSQL.
 *
 * `FOR UPDATE SKIP LOCKED`, blocking row locks, and per-row transaction
 * isolation are the three mechanisms the entire scheduling design rests on, and
 * none of them has a faithful in-memory equivalent — a fake would answer
 * whichever way it was written to (STRUCTURE.md §16).
 *
 * The table below is a stand-in for `participant_sessions`, shaped like the
 * part of it `sweep.activate_due` reads: a status and a time at which the row
 * becomes due. It is created and dropped by this file. Testing against the real
 * table is Phase 7's job; testing the RECONCILIATION is this file's, and the
 * two are separable precisely because the discipline is generic.
 */
const connectionString = process.env["DATABASE_URL"];
if (!connectionString) {
  throw new Error("DATABASE_URL is required for integration tests.");
}

const TEST_SCHEMA = "sweep_reconcile_test";

let pool: Pool;

const silentLogger: SweepLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function context(signal = new AbortController().signal): SweepContext {
  return { pool, logger: silentLogger, signal };
}

interface SessionRow {
  readonly id: string;
  readonly status: string;
}

/**
 * Handlers shaped exactly like the Phase 7 `sweep.activate_due` will be:
 * claim what is due, re-read it under lock, act only if it is still due.
 */
function activateDue(batch: string): ReconcileHandlers<SessionRow> {
  return {
    claim: async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `SELECT id FROM ${TEST_SCHEMA}.sessions
          WHERE batch = $1 AND status = 'SCHEDULED' AND available_from <= now()
          FOR UPDATE SKIP LOCKED
          LIMIT ${String(SWEEP_BATCH_LIMIT)}`,
        [batch],
      );
      return rows.map((row) => row.id);
    },
    lock: async (client, id) => {
      const { rows } = await client.query<SessionRow>(
        `SELECT id, status FROM ${TEST_SCHEMA}.sessions WHERE id = $1 FOR UPDATE`,
        [id],
      );
      return rows[0] ?? null;
    },
    decide: (row) => (row.status === "SCHEDULED" ? ACT : noOp(`NOT_SCHEDULED_${row.status}`)),
    apply: async (client, row) => {
      await client.query(
        `UPDATE ${TEST_SCHEMA}.sessions
            SET status = 'AVAILABLE', activated_at = now(), activation_count = activation_count + 1
          WHERE id = $1`,
        [row.id],
      );
    },
  };
}

const batches: string[] = [];
function nextBatch(): string {
  const batch = `batch-${Math.random().toString(36).slice(2, 10)}`;
  batches.push(batch);
  return batch;
}

async function seed(
  batch: string,
  count: number,
  options: { dueMinutesAgo?: number; status?: string } = {},
): Promise<string[]> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO ${TEST_SCHEMA}.sessions (batch, status, available_from)
     SELECT $1, $2, now() - ($3 || ' minutes')::interval
       FROM generate_series(1, $4)
     RETURNING id`,
    [batch, options.status ?? "SCHEDULED", String(options.dueMinutesAgo ?? 5), count],
  );
  return rows.map((row) => row.id);
}

async function statuses(batch: string): Promise<Record<string, number>> {
  const { rows } = await pool.query<{ status: string; count: string }>(
    `SELECT status, count(*) AS count FROM ${TEST_SCHEMA}.sessions
      WHERE batch = $1 GROUP BY status`,
    [batch],
  );
  return Object.fromEntries(rows.map((row) => [row.status, Number(row.count)]));
}

beforeAll(async () => {
  pool = createPool({ connectionString, max: 8 });
  await pool.query(`CREATE SCHEMA IF NOT EXISTS ${TEST_SCHEMA}`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${TEST_SCHEMA}.sessions (
      id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      batch            text        NOT NULL,
      status           text        NOT NULL,
      available_from   timestamptz NOT NULL,
      activated_at     timestamptz,
      -- Counts applications rather than merely recording the last one, so
      -- "exactly one effect" is checkable instead of merely plausible.
      activation_count integer     NOT NULL DEFAULT 0
    )`);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS sessions_batch_status_idx
       ON ${TEST_SCHEMA}.sessions (batch, status, available_from)`,
  );
});

afterEach(async () => {
  if (batches.length > 0) {
    await pool.query(`DELETE FROM ${TEST_SCHEMA}.sessions WHERE batch = ANY($1)`, [batches]);
    batches.length = 0;
  }
});

afterAll(async () => {
  await pool.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
  await pool.end();
});

describe("reconcile against PostgreSQL", () => {
  it("activates what is due and leaves what is not", async () => {
    const batch = nextBatch();
    await seed(batch, 4, { dueMinutesAgo: 5 });
    await seed(batch, 3, { dueMinutesAgo: -60 }); // due in an hour

    const outcome = await reconcile(context(), "sweep.activate_due", activateDue(batch));

    expect(outcome.claimed).toBe(4);
    expect(outcome.acted).toBe(4);
    expect(await statuses(batch)).toEqual({ AVAILABLE: 4, SCHEDULED: 3 });
  });

  /**
   * "Safe to run … a week late" (ADR-005). Overdue work is not special-cased
   * anywhere in the sweep — the query asks what is due, and a row that came due
   * seven days ago is due.
   *
   * Whether it should still be ACTED ON that late is a separate question, and
   * for notifications the answer is no; that is the staleness guard in
   * `@lpr/domain`, applied in `decide`, not here.
   */
  it("activates work that came due a week ago", async () => {
    const batch = nextBatch();
    await seed(batch, 3, { dueMinutesAgo: 7 * 24 * 60 });

    const outcome = await reconcile(context(), "sweep.activate_due", activateDue(batch));

    expect(outcome.acted).toBe(3);
  });

  /**
   * The idempotency claim ADR-005 makes gating for Phase 7: "duplicate job
   * delivery produces exactly one effect". Two sweeps running at the same
   * instant is the strongest form of that — both claim the same rows, because
   * the claim transaction ends before the work begins.
   *
   * Every row is activated exactly once regardless, because the decision is
   * re-derived under the row lock and the second sweep finds the work already
   * done.
   */
  it("produces exactly one effect per row when two sweeps run concurrently", async () => {
    const batch = nextBatch();
    await seed(batch, 40);

    const [first, second] = await Promise.all([
      reconcile(context(), "sweep.activate_due", activateDue(batch)),
      reconcile(context(), "sweep.activate_due", activateDue(batch)),
    ]);

    expect(first.acted + second.acted).toBe(40);
    expect(await statuses(batch)).toEqual({ AVAILABLE: 40 });

    const { rows } = await pool.query<{ max: number; min: number }>(
      `SELECT max(activation_count) AS max, min(activation_count) AS min
         FROM ${TEST_SCHEMA}.sessions WHERE batch = $1`,
      [batch],
    );
    expect(rows[0]).toEqual({ max: 1, min: 1 });
  });

  it("is a no-op on the second sweep, with the reason recorded", async () => {
    const batch = nextBatch();
    await seed(batch, 5);

    await reconcile(context(), "sweep.activate_due", activateDue(batch));
    const second = await reconcile(context(), "sweep.activate_due", activateDue(batch));

    // Nothing is even claimed: the rows no longer match the due query. The
    // no-op path is reached when a row changes AFTER being claimed, which the
    // next test forces.
    expect(second).toEqual({ claimed: 0, acted: 0, skipped: {}, failed: 0 });
  });

  /**
   * Step 2 of the handler contract, under the conditions it was written for.
   *
   * A participant completes their questionnaire in the window between the claim
   * and the lock. The sweeper's `SELECT … FOR UPDATE` BLOCKS on the
   * participant's transaction — deliberately not `SKIP LOCKED` here — and then
   * sees the completion and does nothing.
   *
   * This is STRUCTURE.md §9.2's claim that the completion-versus-reminder race
   * cannot produce a post-completion notification: the two paths serialise on
   * one row, and the sweeper is the one that yields.
   */
  it("waits for a concurrent completion and then declines to act on it", async () => {
    const batch = nextBatch();
    const [id] = await seed(batch, 1);
    const handlers = activateDue(batch);
    let interfered = false;

    const outcome = await reconcile(context(), "sweep.activate_due", {
      ...handlers,
      lock: async (client: SweepClient, rowId: string) => {
        if (!interfered) {
          interfered = true;

          // The participant's own transaction: take the row, complete it, and
          // hold the lock briefly so the sweeper genuinely has to wait.
          const participant = await pool.connect();
          await participant.query("BEGIN");
          await participant.query(
            `SELECT id FROM ${TEST_SCHEMA}.sessions WHERE id = $1 FOR UPDATE`,
            [rowId],
          );
          await participant.query(
            `UPDATE ${TEST_SCHEMA}.sessions SET status = 'COMPLETED' WHERE id = $1`,
            [rowId],
          );
          setTimeout(() => {
            void participant.query("COMMIT").finally(() => {
              participant.release();
            });
          }, 150);
        }

        return await handlers.lock(client, rowId);
      },
    });

    expect(outcome.claimed).toBe(1);
    expect(outcome.acted).toBe(0);
    expect(outcome.skipped).toEqual({ NOT_SCHEDULED_COMPLETED: 1 });

    const { rows } = await pool.query<{ status: string; activation_count: number }>(
      `SELECT status, activation_count FROM ${TEST_SCHEMA}.sessions WHERE id = $1`,
      [id],
    );
    expect(rows[0]).toEqual({ status: "COMPLETED", activation_count: 0 });
  });

  /**
   * `SKIP LOCKED` is what lets replicas fan out instead of queueing. A row
   * another transaction holds is left for the next cycle rather than blocking
   * the claim — which would turn one slow transaction into a stalled sweep for
   * every participant.
   */
  it("skips a row another transaction is holding rather than waiting for it", async () => {
    const batch = nextBatch();
    const ids = await seed(batch, 5);
    const holder = await pool.connect();

    try {
      await holder.query("BEGIN");
      await holder.query(`SELECT id FROM ${TEST_SCHEMA}.sessions WHERE id = $1 FOR UPDATE`, [
        ids[0],
      ]);

      const outcome = await reconcile(context(), "sweep.activate_due", activateDue(batch));

      expect(outcome.claimed).toBe(4);
      expect(outcome.acted).toBe(4);
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }

    // And the skipped row is picked up on the very next cycle. Nothing is lost
    // by skipping; it is deferred by one interval.
    const next = await reconcile(context(), "sweep.activate_due", activateDue(batch));
    expect(next.acted).toBe(1);
    expect(await statuses(batch)).toEqual({ AVAILABLE: 5 });
  });

  /**
   * Per-row transactions, verified by their effects rather than their shape.
   * The failing row must be rolled back completely while its neighbours commit
   * — one batch-wide transaction would lose all of them together.
   */
  it("rolls back only the row that failed, and commits the rest", async () => {
    const batch = nextBatch();
    const ids = await seed(batch, 6);
    const poisoned = ids[2]!;
    const handlers = activateDue(batch);

    const outcome = await reconcile(context(), "sweep.activate_due", {
      ...handlers,
      apply: async (client, row) => {
        // The update lands first, then the row fails: if the transaction did
        // not roll back, the partial write would survive and the row would be
        // both failed and activated.
        await handlers.apply(client, row);
        if (row.id === poisoned) throw new Error("simulated failure after a partial write");
      },
    });

    expect(outcome).toEqual({ claimed: 6, acted: 5, skipped: {}, failed: 1 });

    const { rows } = await pool.query<{ status: string; activation_count: number }>(
      `SELECT status, activation_count FROM ${TEST_SCHEMA}.sessions WHERE id = $1`,
      [poisoned],
    );
    expect(rows[0]).toEqual({ status: "SCHEDULED", activation_count: 0 });
    expect(await statuses(batch)).toEqual({ AVAILABLE: 5, SCHEDULED: 1 });
  });

  /**
   * A row that fails every time must not be able to stall the sweeper forever.
   * Without per-row isolation it would be claimed first on every cycle, throw,
   * and take every participant behind it down with it — indefinitely, while the
   * loop still reported that it ran.
   */
  it("makes progress on the next cycle even though the poisoned row still fails", async () => {
    const batch = nextBatch();
    const ids = await seed(batch, 4);
    const poisoned = ids[0]!;
    const handlers = activateDue(batch);
    const poisonous = {
      ...handlers,
      apply: async (client: SweepClient, row: SessionRow) => {
        if (row.id === poisoned) throw new Error("permanently malformed row");
        await handlers.apply(client, row);
      },
    };

    const first = await reconcile(context(), "sweep.activate_due", poisonous);
    const second = await reconcile(context(), "sweep.activate_due", poisonous);

    expect(first.acted).toBe(3);
    expect(first.failed).toBe(1);
    // The healthy rows are done; only the poisoned one is still claimed.
    expect(second).toEqual({ claimed: 1, acted: 0, skipped: {}, failed: 1 });
    expect(await statuses(batch)).toEqual({ AVAILABLE: 3, SCHEDULED: 1 });
  });

  /**
   * The morning after an outage, or the first sweep against a restored
   * database. The batch is capped so recovery takes several cycles instead of
   * one enormous transaction — and the system converges either way, which is
   * the property that matters.
   */
  it("caps the batch and converges over successive cycles", async () => {
    const batch = nextBatch();
    const backlog = SWEEP_BATCH_LIMIT + 120;
    await seed(batch, backlog);

    const first = await reconcile(context(), "sweep.activate_due", activateDue(batch));
    expect(first.claimed).toBe(SWEEP_BATCH_LIMIT);
    expect(first.acted).toBe(SWEEP_BATCH_LIMIT);

    const second = await reconcile(context(), "sweep.activate_due", activateDue(batch));
    expect(second.acted).toBe(120);

    expect(await statuses(batch)).toEqual({ AVAILABLE: backlog });
  }, 30_000);

  /**
   * The failure that would end the guarantee outright.
   *
   * `lock()` blocks on purpose — waiting for a participant's completion is how
   * the sweeper comes to see it — but a transaction nobody closes has no upper
   * bound. Without `lock_timeout` this test hangs forever, and so would the
   * real sweep loop: every later cycle queues behind the stuck row while the
   * worker still reports itself alive.
   *
   * With it, the wedged row costs one row one cycle, and everything else in the
   * batch is reconciled normally.
   */
  it("gives up on a row wedged by an abandoned transaction instead of hanging forever", async () => {
    const batch = nextBatch();
    const ids = await seed(batch, 4);
    const wedged = ids[0]!;
    const handlers = activateDue(batch);
    const abandoned = await pool.connect();

    try {
      // Claim first, so the row is claimable, and only then wedge it — that is
      // the window `lock()` has to survive.
      const claimed = await reconcile(context(), "sweep.activate_due", {
        ...handlers,
        claim: async (client) => {
          const rows = await handlers.claim(client);
          return rows;
        },
        lock: async (client, id) => {
          if (id === wedged && abandoned) {
            await abandoned.query("BEGIN");
            await abandoned.query(
              `SELECT id FROM ${TEST_SCHEMA}.sessions WHERE id = $1 FOR UPDATE`,
              [id],
            );
            // Never committed, never rolled back — an idle-in-transaction
            // session, which is what a wedged connection actually looks like.
          }
          return await handlers.lock(client, id);
        },
      });

      expect(claimed.claimed).toBe(4);
      expect(claimed.acted).toBe(3);
      expect(claimed.failed).toBe(1);
    } finally {
      await abandoned.query("ROLLBACK");
      abandoned.release();
    }

    // And the row is not lost: once the wedge clears, the next cycle takes it.
    const next = await reconcile(context(), "sweep.activate_due", activateDue(batch));
    expect(next.acted).toBe(1);
    expect(await statuses(batch)).toEqual({ AVAILABLE: 4 });
  }, 30_000);

  /**
   * `SET LOCAL` reverts with its transaction. `SET` would not: it would ride the
   * pooled connection and quietly impose a five-second lock timeout on every
   * later query that borrowed it — including a participant's completion.
   */
  it("does not leave its lock timeout on the connection it returns to the pool", async () => {
    const batch = nextBatch();
    await seed(batch, 2);

    await reconcile(context(), "sweep.activate_due", activateDue(batch));

    // Same pool, and with max: 8 and nothing else running, the same physical
    // connections the sweep just used.
    const { rows } = await pool.query<{ lock_timeout: string }>("SHOW lock_timeout");
    expect(rows[0]?.lock_timeout).toBe("0");
  });

  it("stops mid-batch when the worker is shutting down and finishes the rest next cycle", async () => {
    const batch = nextBatch();
    await seed(batch, 10);
    const abort = new AbortController();
    const handlers = activateDue(batch);
    let seen = 0;

    const outcome = await reconcile(context(abort.signal), "sweep.activate_due", {
      ...handlers,
      decide: (row) => {
        seen += 1;
        if (seen === 3) abort.abort();
        return handlers.decide(row);
      },
    });

    expect(outcome.claimed).toBe(10);
    expect(outcome.acted).toBe(3);

    // Nothing was lost — the remaining rows are simply still due.
    const next = await reconcile(context(), "sweep.activate_due", activateDue(batch));
    expect(next.acted).toBe(7);
    expect(await statuses(batch)).toEqual({ AVAILABLE: 10 });
  });
});
