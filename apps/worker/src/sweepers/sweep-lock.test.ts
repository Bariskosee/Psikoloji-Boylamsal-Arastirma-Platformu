import { describe, expect, it } from "vitest";
import type { Pool } from "@lpr/db";
import { sweepLockKey, withSweepLock } from "./sweep-lock.js";

/** A pool that grants the lock and then fails to release it. */
function unlockFailsPool(): Pool {
  return {
    connect: () =>
      Promise.resolve({
        query: (text: string) => {
          if (text.includes("pg_advisory_unlock")) {
            return Promise.reject(new Error("connection terminated unexpectedly"));
          }
          return Promise.resolve({ rows: [{ locked: true }] });
        },
        release: () => undefined,
      }),
  } as unknown as Pool;
}

/**
 * The key derivation, without a database.
 *
 * Exclusion itself is only testable against real PostgreSQL and lives in
 * `sweep-lock.integration.test.ts`. What is worth pinning down here is that the
 * key is a pure function of the name: if it were not — a random salt, a
 * process-scoped counter, anything drifting — two replicas would compute
 * different keys, take different locks, and both sweep at once while appearing
 * to be excluded.
 */
describe("sweepLockKey", () => {
  it("is deterministic", () => {
    expect(sweepLockKey("sweep.activate_due")).toBe(sweepLockKey("sweep.activate_due"));
  });

  it("separates the sweepers ADR-005 names", () => {
    const names = [
      "sweep.activate_due",
      "sweep.expire_due",
      "sweep.notifications_due",
      "sweep.heartbeat",
    ];

    const keys = names.map(sweepLockKey);

    expect(new Set(keys).size).toBe(names.length);
  });

  /**
   * Advisory-lock keys are `int4`. A value outside that range is not truncated
   * by the driver — the query fails — so a sweeper would throw every cycle.
   */
  it("stays inside PostgreSQL's int4 range", () => {
    const names = ["sweep.activate_due", "sweep.expire_due", "", "x".repeat(500), "sweep.é🙂"];

    for (const name of names) {
      const key = sweepLockKey(name);
      expect(Number.isInteger(key), name).toBe(true);
      expect(key, name).toBeGreaterThanOrEqual(-2_147_483_648);
      expect(key, name).toBeLessThanOrEqual(2_147_483_647);
    }
  });

  it("distinguishes names that differ only in their last character", () => {
    expect(sweepLockKey("sweep.expire_due")).not.toBe(sweepLockKey("sweep.expire_dud"));
  });
});

/**
 * A dying connection fails the sweep AND fails the unlock. If the unlock's
 * error won, every incident of this kind would be reported as "connection
 * terminated" with the actual cause discarded — and the lock is released by the
 * database when the session ends regardless, so there is nothing to gain by
 * raising it.
 */
describe("withSweepLock when releasing the lock fails", () => {
  it("still reports the sweep's own failure, not the unlock's", async () => {
    await expect(
      withSweepLock(unlockFailsPool(), "sweep.activate_due", () =>
        Promise.reject(new Error("malformed reminder policy")),
      ),
    ).rejects.toThrow("malformed reminder policy");
  });

  it("still returns the sweep's result when the sweep succeeded", async () => {
    await expect(
      withSweepLock(unlockFailsPool(), "sweep.activate_due", () => Promise.resolve("swept")),
    ).resolves.toBe("swept");
  });
});
