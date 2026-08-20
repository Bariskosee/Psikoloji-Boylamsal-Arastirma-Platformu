import { describe, expect, it } from "vitest";
import { sweepLockKey } from "./sweep-lock.js";

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
