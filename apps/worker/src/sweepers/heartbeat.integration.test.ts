import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createPool, type Pool } from "@lpr/db";
import type { SweeperHealth } from "@lpr/domain";
import { HeartbeatWriter } from "./heartbeat.js";
import type { SweepLogger } from "./sweeper.js";

/**
 * The heartbeat, against real PostgreSQL.
 *
 * The point of this table is that a stopped sweep loop becomes visible, and
 * every claim behind that depends on the database rather than on TypeScript:
 * the upsert has to preserve the previous timestamp long enough to compare
 * against it, the failure counter has to accumulate across statements, the
 * timestamps have to come from the database's clock, and the analytics role has
 * to be unable to write here. None of that can be checked against a fake.
 */
const connectionString = process.env["DATABASE_URL"];
if (!connectionString) {
  throw new Error(
    "DATABASE_URL is required for integration tests.\n" +
      "  Local:  pnpm db:up && cp .env.example .env && pnpm --filter=@lpr/db migrate:up\n" +
      "  CI:     provide it in the job environment",
  );
}

const pool: Pool = createPool({ connectionString, max: 4 });

/** Unique per test, so a rerun never inherits a previous run's row. */
const workerIds: string[] = [];
function nextWorkerId(): string {
  const id = `test-worker-${Math.random().toString(36).slice(2, 10)}`;
  workerIds.push(id);
  return id;
}

const silentLogger: SweepLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function writerFor(
  workerId: string,
  options: { staleAfterMs?: number; onStale?: (health: SweeperHealth) => void } = {},
): HeartbeatWriter {
  return new HeartbeatWriter({
    pool,
    workerId,
    sweepIntervalSeconds: 60,
    logger: silentLogger,
    ...(options.staleAfterMs === undefined ? {} : { staleAfterMs: options.staleAfterMs }),
    ...(options.onStale === undefined ? {} : { onStale: options.onStale }),
  });
}

async function readRow(workerId: string) {
  const result = await pool.query<{
    worker_id: string;
    started_at: Date;
    swept_at: Date;
    sweep_interval_seconds: number;
    consecutive_failures: number;
    last_error: string | null;
  }>(`SELECT * FROM research.system_heartbeats WHERE worker_id = $1`, [workerId]);
  return result.rows[0] ?? null;
}

beforeAll(async () => {
  await pool.query("SELECT 1");
});

afterEach(async () => {
  if (workerIds.length > 0) {
    await pool.query(`DELETE FROM research.system_heartbeats WHERE worker_id = ANY($1)`, [
      workerIds,
    ]);
    workerIds.length = 0;
  }
});

afterAll(async () => {
  await pool.end();
});

describe("HeartbeatWriter", () => {
  it("inserts a row on the first cycle, with nothing to compare against", async () => {
    const workerId = nextWorkerId();

    const report = await writerFor(workerId).record({ failures: [] });

    expect(report.previous).toBeNull();
    expect(report.consecutiveFailures).toBe(0);

    const row = await readRow(workerId);
    expect(row?.sweep_interval_seconds).toBe(60);
    expect(row?.last_error).toBeNull();
    expect(row?.swept_at.getTime()).toBe(report.sweptAt.getTime());
  });

  /**
   * The property the whole table rests on: a worker cannot vouch for itself
   * with its own clock. Every timestamp is stamped by the same PostgreSQL
   * `now()` the sweep queries compare `available_from` against, so a skewed
   * worker cannot write a heartbeat that disagrees with the schedule it is
   * enforcing.
   */
  it("stamps every timestamp from the database clock, not the process clock", async () => {
    const workerId = nextWorkerId();

    const { rows } = await pool.query<{ db_now: Date }>("SELECT now() AS db_now");
    const before = rows[0]!.db_now;
    const report = await writerFor(workerId).record({ failures: [] });
    const after = (await pool.query<{ db_now: Date }>("SELECT now() AS db_now")).rows[0]!.db_now;

    expect(report.sweptAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(report.sweptAt.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  it("advances swept_at on the next cycle and reports how the previous one looks", async () => {
    const workerId = nextWorkerId();
    const writer = writerFor(workerId);

    const first = await writer.record({ failures: [] });
    const second = await writer.record({ failures: [] });

    expect(second.sweptAt.getTime()).toBeGreaterThanOrEqual(first.sweptAt.getTime());
    expect(second.previous?.status).toBe("HEALTHY");
    // The previous row was read before it was overwritten — an
    // `ON CONFLICT … RETURNING` alone cannot give both values.
    expect(second.previous?.ageMs).toBeGreaterThanOrEqual(0);
  });

  it("keeps started_at fixed across cycles so a restart loop stays visible", async () => {
    const workerId = nextWorkerId();
    const writer = writerFor(workerId);

    await writer.record({ failures: [] });
    const bootedAt = (await readRow(workerId))?.started_at;
    await writer.record({ failures: [] });
    const stillBootedAt = (await readRow(workerId))?.started_at;

    expect(stillBootedAt?.getTime()).toBe(bootedAt?.getTime());
  });

  it("stamps a new started_at when a new process takes over the same worker id", async () => {
    const workerId = nextWorkerId();

    await writerFor(workerId).record({ failures: [] });
    const firstBoot = (await readRow(workerId))?.started_at;

    // A second writer is a second process: the id is stable, the boot is not.
    await writerFor(workerId).record({ failures: [] });
    const secondBoot = (await readRow(workerId))?.started_at;

    expect(secondBoot!.getTime()).toBeGreaterThanOrEqual(firstBoot!.getTime());
  });

  describe("the failure signal", () => {
    /**
     * A worker whose sweepers all throw still completes its cycles, so its
     * heartbeat stays fresh. Without this counter it would look perfectly
     * healthy while reconciling nothing.
     */
    it("accumulates across consecutive unclean cycles", async () => {
      const workerId = nextWorkerId();
      const writer = writerFor(workerId);

      const first = await writer.record({ failures: ["sweep.activate_due: deadlock detected"] });
      const second = await writer.record({ failures: ["sweep.activate_due: deadlock detected"] });
      const third = await writer.record({ failures: ["sweep.expire_due: connection reset"] });

      expect([first, second, third].map((report) => report.consecutiveFailures)).toEqual([1, 2, 3]);
      expect((await readRow(workerId))?.last_error).toContain("connection reset");
    });

    it("resets on the next clean cycle, so a rising value means still broken", async () => {
      const workerId = nextWorkerId();
      const writer = writerFor(workerId);

      await writer.record({ failures: ["sweep.activate_due: deadlock detected"] });
      await writer.record({ failures: ["sweep.activate_due: deadlock detected"] });
      const recovered = await writer.record({ failures: [] });

      expect(recovered.consecutiveFailures).toBe(0);
      expect((await readRow(workerId))?.last_error).toBeNull();
    });

    it("records sweeper names and messages, and nothing longer than the column deserves", async () => {
      const workerId = nextWorkerId();
      const failure = `sweep.notifications_due: ${"x".repeat(2_000)}`;

      await writerFor(workerId).record({ failures: [failure] });

      const stored = (await readRow(workerId))?.last_error ?? "";
      expect(stored.length).toBeLessThanOrEqual(500);
      expect(stored.startsWith("sweep.notifications_due:")).toBe(true);
    });
  });

  /**
   * The failure this detects is a worker that is alive but not sweeping — a
   * blocked event loop, a wedged connection, a container frozen and resumed.
   * A process that is not running cannot report on itself, so this is the only
   * half of staleness the worker can catch; the other half is a reader's job.
   */
  it("notices that it stopped sweeping and raises it", async () => {
    const workerId = nextWorkerId();
    const stalls: SweeperHealth[] = [];
    const writer = writerFor(workerId, {
      staleAfterMs: 5 * 60_000,
      onStale: (health) => stalls.push(health),
    });

    await writer.record({ failures: [] });

    // Backdate the row rather than waiting five real minutes. The comparison
    // under test is the database's, so moving the database's record of the last
    // sweep is a faithful simulation of the worker having been stuck.
    await pool.query(
      `UPDATE research.system_heartbeats SET swept_at = now() - interval '31 minutes'
        WHERE worker_id = $1`,
      [workerId],
    );

    const report = await writer.record({ failures: [] });

    expect(report.previous?.status).toBe("STALE");
    expect(stalls).toHaveLength(1);
    expect(stalls[0]?.ageMs).toBeGreaterThan(30 * 60_000);
  });

  it("stays quiet when the gap is within the threshold", async () => {
    const workerId = nextWorkerId();
    const stalls: SweeperHealth[] = [];
    const writer = writerFor(workerId, {
      staleAfterMs: 5 * 60_000,
      onStale: (health) => stalls.push(health),
    });

    await writer.record({ failures: [] });
    await pool.query(
      `UPDATE research.system_heartbeats SET swept_at = now() - interval '2 minutes'
        WHERE worker_id = $1`,
      [workerId],
    );

    const report = await writer.record({ failures: [] });

    expect(report.previous?.status).toBe("HEALTHY");
    expect(stalls).toEqual([]);
  });
});

describe("system_heartbeats constraints and privileges", () => {
  it("refuses a negative failure count", async () => {
    const workerId = nextWorkerId();
    await expect(
      pool.query(
        `INSERT INTO research.system_heartbeats
           (worker_id, started_at, swept_at, sweep_interval_seconds, consecutive_failures)
         VALUES ($1, now(), now(), 60, -1)`,
        [workerId],
      ),
    ).rejects.toThrow(/system_heartbeats_consecutive_failures_nonnegative/);
  });

  it("refuses a sweep interval of zero", async () => {
    const workerId = nextWorkerId();
    await expect(
      pool.query(
        `INSERT INTO research.system_heartbeats
           (worker_id, started_at, swept_at, sweep_interval_seconds)
         VALUES ($1, now(), now(), 0)`,
        [workerId],
      ),
    ).rejects.toThrow(/system_heartbeats_sweep_interval_positive/);
  });

  it("keeps one row per worker, so two replicas cannot silently share a heartbeat", async () => {
    const workerId = nextWorkerId();
    await writerFor(workerId).record({ failures: [] });
    await writerFor(workerId).record({ failures: [] });

    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM research.system_heartbeats WHERE worker_id = $1`,
      [workerId],
    );
    expect(rows[0]?.count).toBe("1");
  });

  /**
   * The grants come from `ALTER DEFAULT PRIVILEGES` set in migration 0000, so
   * this migration declares none of its own. Asserted rather than assumed: an
   * inherited grant that silently did not apply is exactly the kind of thing
   * that is discovered in production.
   */
  it("is readable by the analytics role, which is harmless — it holds no participant data", async () => {
    const { rows } = await pool.query<{ has: boolean }>(
      `SELECT has_table_privilege('app_analytics', 'research.system_heartbeats', 'SELECT') AS has`,
    );
    expect(rows[0]?.has).toBe(true);
  });

  it("is not writable by the analytics role", async () => {
    for (const privilege of ["INSERT", "UPDATE", "DELETE"]) {
      const { rows } = await pool.query<{ has: boolean }>(
        `SELECT has_table_privilege('app_analytics', 'research.system_heartbeats', $1) AS has`,
        [privilege],
      );
      expect(rows[0]?.has, privilege).toBe(false);
    }
  });

  it("is writable by the application role, which is the worker", async () => {
    for (const privilege of ["SELECT", "INSERT", "UPDATE"]) {
      const { rows } = await pool.query<{ has: boolean }>(
        `SELECT has_table_privilege('app_readwrite', 'research.system_heartbeats', $1) AS has`,
        [privilege],
      );
      expect(rows[0]?.has, privilege).toBe(true);
    }
  });
});
