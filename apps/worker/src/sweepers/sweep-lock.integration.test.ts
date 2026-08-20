import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, type Pool } from "@lpr/db";
import { LOCK_NOT_ACQUIRED, sweepLockKey, withSweepLock, wasSkipped } from "./sweep-lock.js";

/**
 * Cross-replica exclusion, against real PostgreSQL.
 *
 * An advisory lock cannot be faked into telling the truth: whether a second
 * caller is refused, and whether the lock survives an exception or a returned
 * connection, are properties of PostgreSQL's session state. A test double would
 * assert that this file calls the functions it calls, which is not the question.
 *
 * Worth restating, because it governs how seriously a failure here should be
 * taken: this lock is an EFFICIENCY measure. Correctness comes from `SKIP
 * LOCKED` and from re-deriving each decision under a row lock. A lock that
 * failed open would waste work; it would not corrupt anything.
 */
const connectionString = process.env["DATABASE_URL"];
if (!connectionString) {
  throw new Error("DATABASE_URL is required for integration tests.");
}

/** The namespace `sweep-lock.ts` confines this application's locks to. */
const SWEEP_LOCK_NAMESPACE = 0x4c50_5231;

let pool: Pool;
let otherReplica: Pool;

/** A promise the test resolves by hand, to hold a lock open deliberately. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function advisoryLockCount(): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    `SELECT count(*) AS count FROM pg_locks
      WHERE locktype = 'advisory' AND classid = $1`,
    [SWEEP_LOCK_NAMESPACE],
  );
  return Number(rows[0]?.count ?? "0");
}

const uniqueName = () => `sweep.test_${Math.random().toString(36).slice(2, 10)}`;

beforeAll(async () => {
  pool = createPool({ connectionString, max: 5 });
  // A separate pool is a separate set of sessions — the closest thing to a
  // second worker replica without starting a second process.
  otherReplica = createPool({ connectionString, max: 2 });
  await pool.query("SELECT 1");
});

afterAll(async () => {
  await pool.end();
  await otherReplica.end();
});

describe("withSweepLock", () => {
  it("runs the sweep and returns its result when the lock is free", async () => {
    const result = await withSweepLock(pool, uniqueName(), () => Promise.resolve("swept"));

    expect(wasSkipped(result)).toBe(false);
    expect(result).toBe("swept");
  });

  /**
   * The behaviour the whole file exists for: while one replica sweeps, another
   * is turned away immediately rather than queueing behind it. Queueing would
   * run the second cycle late to redo work the first replica had just done.
   */
  it("refuses a second replica while the first is sweeping", async () => {
    const name = uniqueName();
    const holding = deferred();
    let secondResult: unknown;

    const first = withSweepLock(pool, name, async () => {
      secondResult = await withSweepLock(otherReplica, name, () =>
        Promise.resolve("should not run"),
      );
      holding.resolve();
      return "first";
    });

    await holding.promise;
    await first;

    expect(secondResult).toBe(LOCK_NOT_ACQUIRED);
  });

  it("hands the lock over once the first sweep finishes", async () => {
    const name = uniqueName();

    await withSweepLock(pool, name, () => Promise.resolve("first"));
    const second = await withSweepLock(otherReplica, name, () => Promise.resolve("second"));

    expect(second).toBe("second");
  });

  /**
   * A sweeper that throws must still release. Otherwise the first exception in
   * production disables that sweeper on every replica until the connection is
   * recycled — silently, because the loop keeps reporting that it ran.
   */
  it("releases the lock when the sweep throws", async () => {
    const name = uniqueName();

    await expect(
      withSweepLock(pool, name, () => Promise.reject(new Error("deadlock detected"))),
    ).rejects.toThrow("deadlock detected");

    expect(await withSweepLock(otherReplica, name, () => Promise.resolve("free"))).toBe("free");
  });

  it("does not let one sweeper block another", async () => {
    const activate = uniqueName();
    const expire = uniqueName();
    const holding = deferred();
    let expireResult: unknown;

    const first = withSweepLock(pool, activate, async () => {
      expireResult = await withSweepLock(otherReplica, expire, () => Promise.resolve("expire ran"));
      holding.resolve();
      return "activate ran";
    });

    await holding.promise;
    await first;

    expect(expireResult).toBe("expire ran");
  });

  /**
   * Advisory locks live on the SESSION, and a pooled connection outlives the
   * sweep that borrowed it. A missed unlock would therefore ride that
   * connection back into the pool and hold the sweeper off indefinitely — the
   * one bug in this file that would not announce itself.
   */
  it("leaves nothing held on the connection it returns to the pool", async () => {
    const singleConnection = createPool({ connectionString, max: 1 });
    const name = uniqueName();

    try {
      for (let i = 0; i < 3; i += 1) {
        expect(await withSweepLock(singleConnection, name, () => Promise.resolve(i))).toBe(i);
      }

      // A different pool, and therefore a different session: it can only
      // succeed if the previous three genuinely released.
      expect(await withSweepLock(pool, name, () => Promise.resolve("free"))).toBe("free");
    } finally {
      await singleConnection.end();
    }
  });

  it("holds no advisory locks in this namespace once every sweep has finished", async () => {
    const name = uniqueName();

    await withSweepLock(pool, name, () => Promise.resolve(undefined));
    await withSweepLock(otherReplica, name, () => Promise.resolve(undefined));

    expect(await advisoryLockCount()).toBe(0);
  });

  it("takes the lock at the key derived from the sweeper name", async () => {
    const name = uniqueName();
    const holding = deferred();
    let heldKey: number | null = null;

    const sweeping = withSweepLock(pool, name, async () => {
      const { rows } = await pool.query<{ objid: number }>(
        `SELECT objid FROM pg_locks WHERE locktype = 'advisory' AND classid = $1`,
        [SWEEP_LOCK_NAMESPACE],
      );
      // pg_locks reports the key as an unsigned oid; the derivation is signed.
      heldKey = Number(rows[0]?.objid) | 0;
      holding.resolve();
      return undefined;
    });

    await holding.promise;
    await sweeping;

    expect(heldKey).toBe(sweepLockKey(name));
  });
});
