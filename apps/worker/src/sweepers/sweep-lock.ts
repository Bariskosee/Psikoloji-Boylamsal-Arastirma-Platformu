import type { Pool } from "@lpr/db";

/**
 * One sweeper, one runner, across every replica (ADR-005, STRUCTURE.md §8.4).
 *
 * PostgreSQL advisory locks, taken on a dedicated session for the duration of
 * one sweep.
 *
 * **This is an efficiency measure, not a correctness measure, and the
 * difference is load-bearing.** Correctness comes from `FOR UPDATE SKIP LOCKED`
 * plus re-deriving each decision under a row lock: run three replicas with no
 * lock at all and the outcome is still right, just wasteful — they claim
 * overlapping candidates, block on the same rows, and mostly conclude there is
 * nothing left to do. Anything built on top of this must keep that true. A
 * sweeper that would misbehave if two ran at once is a broken sweeper, and this
 * lock would only be hiding it.
 *
 * Why advisory locks rather than a `sweep_locks` table or a queue singleton:
 * they are released by the database when the session ends, however it ends.
 * A worker killed mid-sweep — OOM, SIGKILL, a severed network — leaves nothing
 * behind. A lock row would survive, and the next worker would find the sweepers
 * held by a process that no longer exists, with no safe way to tell that from a
 * sweep still legitimately in progress. That failure mode is exactly the one
 * ADR-005 exists to eliminate, so it must not be reintroduced by the mechanism
 * meant to protect it.
 *
 * STRUCTURE.md §8.4 describes this exclusion as a job `singletonKey`. An
 * advisory lock is the stronger form of the same intent: a singleton key
 * collapses duplicate *enqueues*, while this excludes overlapping *execution*,
 * which is the property actually wanted — and it holds for the configurable
 * `SWEEP_INTERVAL_SECONDS`, which cron's one-minute granularity cannot express.
 */

/**
 * The first half of every advisory-lock key.
 *
 * Advisory locks share one global 64-bit space per database, so an unnamespaced
 * key can collide with a lock taken by an extension, a migration tool, or any
 * other application sharing the database. `pg-boss` in particular runs
 * maintenance in this same database (ADR-004). The namespace confines this
 * application's locks to a 32-bit subspace nothing else has a reason to use.
 */
const SWEEP_LOCK_NAMESPACE = 0x4c50_5231; // "LPR1"

/**
 * FNV-1a, 32-bit, forced into PostgreSQL's signed `int4`.
 *
 * Computed here rather than with PostgreSQL's `hashtext()` because `hashtext`
 * is an internal function with no compatibility promise across major versions.
 * Deriving the key in TypeScript keeps the lock identity a property of this
 * codebase, so a database upgrade cannot silently re-partition which sweepers
 * exclude which.
 */
export function sweepLockKey(sweeperName: string): number {
  let hash = 0x811c_9dc5;
  for (let i = 0; i < sweeperName.length; i += 1) {
    hash ^= sweeperName.charCodeAt(i);
    // FNV prime, via shifts: Math.imul keeps the multiply in 32-bit range
    // instead of drifting past Number.MAX_SAFE_INTEGER.
    hash = Math.imul(hash, 0x0100_0193);
  }
  // `| 0` reinterprets the 32 bits as signed, which is what int4 holds.
  return hash | 0;
}

/** Returned instead of the callback's value when another replica holds the lock. */
export const LOCK_NOT_ACQUIRED = Symbol("sweep lock not acquired");

export type LockedResult<T> = T | typeof LOCK_NOT_ACQUIRED;

export function wasSkipped<T>(result: LockedResult<T>): result is typeof LOCK_NOT_ACQUIRED {
  return result === LOCK_NOT_ACQUIRED;
}

/**
 * Run `fn` while holding the sweeper's advisory lock, or return
 * `LOCK_NOT_ACQUIRED` immediately if another replica has it.
 *
 * Never waits. A sweeper that queued behind another replica would run its cycle
 * late for no benefit — the replica holding the lock is doing the identical
 * work, and this cycle's answer will be recomputed from scratch in sixty
 * seconds anyway.
 *
 * The lock is held on ONE checked-out client and released in `finally`.
 * Advisory locks are session-scoped, so releasing before returning the client
 * to the pool is mandatory: a leaked lock would ride the pooled connection and
 * silently disable this sweeper on every replica until that connection is
 * recycled.
 */
export async function withSweepLock<T>(
  pool: Pool,
  sweeperName: string,
  fn: () => Promise<T>,
): Promise<LockedResult<T>> {
  const key = sweepLockKey(sweeperName);
  const client = await pool.connect();

  try {
    const acquired = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock($1::int, $2::int) AS locked",
      [SWEEP_LOCK_NAMESPACE | 0, key],
    );

    if (acquired.rows[0]?.locked !== true) {
      return LOCK_NOT_ACQUIRED;
    }

    try {
      return await fn();
    } finally {
      // Unlock on the same session that locked; any other connection's unlock
      // is a no-op that returns false. Failing to unlock is not fatal — the
      // lock dies with the session — but it would hold the sweeper off for as
      // long as this pooled connection lives, so it is worth the round trip.
      await client.query("SELECT pg_advisory_unlock($1::int, $2::int)", [
        SWEEP_LOCK_NAMESPACE | 0,
        key,
      ]);
    }
  } finally {
    client.release();
  }
}
