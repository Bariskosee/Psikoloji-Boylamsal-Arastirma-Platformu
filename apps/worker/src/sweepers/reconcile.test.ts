import { describe, expect, it, vi } from "vitest";
import type { Pool } from "@lpr/db";
import {
  ACT,
  RECONCILE_ROW_VANISHED,
  noOp,
  reconcile,
  type ReconcileDecision,
  type SweepClient,
} from "./reconcile.js";
import { SWEEP_LOCK_TIMEOUT_MS, type SweepContext, type SweepLogger } from "./sweeper.js";

/**
 * The universal handler contract (ADR-005), without a database.
 *
 * What is checked here is the DISCIPLINE: that every row is re-locked and
 * re-judged in its own transaction, that a decision reversed under lock becomes
 * a recorded no-op, and that one bad row cannot take the batch down. Whether
 * PostgreSQL actually isolates those transactions is a different question,
 * answered in `reconcile.integration.test.ts`.
 */

/**
 * A pool that records every statement in order, so the test can assert on the
 * transaction boundaries themselves rather than on their effects.
 */
function fakePool(): { pool: Pool; statements: string[]; released: number } {
  const statements: string[] = [];
  const state = { released: 0 };

  const pool = {
    connect: () =>
      Promise.resolve({
        query: (text: string) => {
          statements.push(text.trim().split("\n")[0]!.trim());
          return Promise.resolve({ rows: [] });
        },
        release: () => {
          state.released += 1;
        },
      }),
  };

  return {
    pool: pool as unknown as Pool,
    statements,
    get released() {
      return state.released;
    },
  };
}

/** `SET LOCAL`, so the timeout reverts with the transaction rather than
 * leaking onto the pooled connection and governing unrelated queries later. */
const LOCK_TIMEOUT_STATEMENT = `SET LOCAL lock_timeout = '${String(SWEEP_LOCK_TIMEOUT_MS)}ms'`;

function silentLogger(): SweepLogger & { errors: string[] } {
  const errors: string[] = [];
  return {
    errors,
    info: () => undefined,
    warn: () => undefined,
    error: (message) => errors.push(message),
  };
}

function contextFor(pool: Pool, signal = new AbortController().signal) {
  const logger = silentLogger();
  const context: SweepContext = { pool, logger, signal };
  return { context, logger };
}

interface Row {
  readonly id: string;
  readonly status: string;
}

/** Handlers whose behaviour the test drives, with sensible defaults. */
function handlers(overrides: {
  ids?: string[];
  lock?: (client: SweepClient, id: string) => Promise<Row | null>;
  decide?: (row: Row) => ReconcileDecision;
}) {
  const applied: string[] = [];
  return {
    applied,
    handlers: {
      claim: () => Promise.resolve(overrides.ids ?? []),
      lock:
        overrides.lock ??
        ((_client: SweepClient, id: string) => Promise.resolve({ id, status: "SCHEDULED" })),
      decide: overrides.decide ?? (() => ACT),
      apply: (_client: SweepClient, row: Row) => {
        applied.push(row.id);
        return Promise.resolve();
      },
    },
  };
}

describe("reconcile", () => {
  it("claims, then locks and applies each row in its own transaction", async () => {
    const { pool, statements } = fakePool();
    const { context } = contextFor(pool);
    const { handlers: h, applied } = handlers({ ids: ["a", "b"] });

    const outcome = await reconcile(context, "sweep.test", h);

    expect(outcome).toEqual({ claimed: 2, acted: 2, skipped: {}, failed: 0 });
    expect(applied).toEqual(["a", "b"]);
    // The claim's own transaction rolls back — it read, it wrote nothing — and
    // each row then commits separately. One transaction spanning the batch
    // would hold every row lock for the length of the sweep.
    //
    // Every transaction sets `lock_timeout` first. Asserted on the statement
    // sequence rather than trusted, because a missing one does not fail — it
    // hangs, and only against a database that happens to have a wedged
    // transaction at that moment.
    expect(statements).toEqual([
      "BEGIN",
      LOCK_TIMEOUT_STATEMENT,
      "ROLLBACK",
      "BEGIN",
      LOCK_TIMEOUT_STATEMENT,
      "COMMIT",
      "BEGIN",
      LOCK_TIMEOUT_STATEMENT,
      "COMMIT",
    ]);
  });

  it("returns every connection to the pool", async () => {
    const fake = fakePool();
    const { context } = contextFor(fake.pool);
    const { handlers: h } = handlers({ ids: ["a", "b", "c"] });

    await reconcile(context, "sweep.test", h);

    // One for the claim, one per row. A leaked connection would exhaust the
    // pool within minutes at a sixty-second cadence.
    expect(fake.released).toBe(4);
  });

  /**
   * Step 3 of the contract. The claim said this row was due; the locked read
   * says otherwise, and the locked read is the one that counts.
   */
  it("rolls back and records the reason when the decision no longer holds", async () => {
    const { pool, statements } = fakePool();
    const { context } = contextFor(pool);
    const { handlers: h, applied } = handlers({
      ids: ["a", "b"],
      decide: (row: Row) => (row.id === "a" ? noOp("ALREADY_COMPLETED") : ACT),
    });

    const outcome = await reconcile(context, "sweep.test", h);

    expect(outcome.acted).toBe(1);
    expect(outcome.skipped).toEqual({ ALREADY_COMPLETED: 1 });
    expect(applied).toEqual(["b"]);
    expect(statements).toEqual([
      "BEGIN",
      LOCK_TIMEOUT_STATEMENT,
      "ROLLBACK",
      "BEGIN",
      LOCK_TIMEOUT_STATEMENT,
      "ROLLBACK",
      "BEGIN",
      LOCK_TIMEOUT_STATEMENT,
      "COMMIT",
    ]);
  });

  it("aggregates repeated no-op reasons into counts rather than a list of rows", async () => {
    const { pool } = fakePool();
    const { context } = contextFor(pool);
    const { handlers: h } = handlers({
      ids: ["a", "b", "c", "d"],
      decide: (row: Row) => (row.id === "d" ? noOp("WITHDRAWN") : noOp("ALREADY_COMPLETED")),
    });

    const outcome = await reconcile(context, "sweep.test", h);

    expect(outcome.skipped).toEqual({ ALREADY_COMPLETED: 3, WITHDRAWN: 1 });
    expect(outcome.acted).toBe(0);
  });

  it("records a row that vanished between the claim and the lock", async () => {
    const { pool } = fakePool();
    const { context } = contextFor(pool);
    const { handlers: h, applied } = handlers({
      ids: ["gone"],
      lock: () => Promise.resolve(null),
    });

    const outcome = await reconcile(context, "sweep.test", h);

    expect(outcome.skipped).toEqual({ [RECONCILE_ROW_VANISHED]: 1 });
    expect(applied).toEqual([]);
  });

  /**
   * The failure mode this guards against is total: without it, one unparseable
   * row is claimed first on every cycle, throws, and stalls the scheduling of
   * every participant behind it — indefinitely, and with the sweeper still
   * appearing to run.
   */
  it("keeps going after a row throws, and reports it", async () => {
    const { pool } = fakePool();
    const { context, logger } = contextFor(pool);
    const { handlers: h, applied } = handlers({
      ids: ["good-1", "poison", "good-2"],
      lock: (_client, id) =>
        id === "poison"
          ? Promise.reject(new Error("malformed reminder policy"))
          : Promise.resolve({ id, status: "SCHEDULED" }),
    });

    const outcome = await reconcile(context, "sweep.test", h);

    expect(outcome).toEqual({ claimed: 3, acted: 2, skipped: {}, failed: 1 });
    expect(applied).toEqual(["good-1", "good-2"]);
    // The identifier is logged here and nowhere else: a row that fails every
    // cycle cannot be diagnosed without knowing which row it is.
    expect(logger.errors).toHaveLength(1);
    expect(logger.errors[0]).toContain("poison");
    expect(logger.errors[0]).toContain("malformed reminder policy");
  });

  it("stops claiming new rows once the worker is shutting down", async () => {
    const { pool } = fakePool();
    const abort = new AbortController();
    const { context } = contextFor(pool, abort.signal);
    const { handlers: h, applied } = handlers({ ids: ["a", "b", "c"] });

    const decide = vi.fn((row: Row) => {
      if (row.id === "b") abort.abort();
      return ACT;
    });

    const outcome = await reconcile(context, "sweep.test", { ...h, decide });

    // "a" and "b" complete; "c" is left for the next cycle. Nothing is lost by
    // stopping early — that is what being a sweeper means.
    expect(applied).toEqual(["a", "b"]);
    expect(outcome.claimed).toBe(3);
    expect(outcome.acted).toBe(2);
  });

  it("propagates a failure of the claim itself rather than reporting an empty sweep", async () => {
    const { pool } = fakePool();
    const { context } = contextFor(pool);

    await expect(
      reconcile(context, "sweep.test", {
        claim: () => Promise.reject(new Error("connection reset")),
        lock: () => Promise.resolve(null),
        decide: () => ACT,
        apply: () => Promise.resolve(),
      }),
    ).rejects.toThrow("connection reset");
  });

  /**
   * `decide` sees the row `lock` returned, never anything the claim believed.
   * A sweeper that judged on claimed state would act on a snapshot taken before
   * the lock — the exact mistake the contract's step 2 forbids.
   */
  it("judges the locked row, not the claimed identifier", async () => {
    const { pool } = fakePool();
    const { context } = contextFor(pool);
    const seen: Row[] = [];
    const { handlers: h } = handlers({
      ids: ["a"],
      lock: (_client, id) => Promise.resolve({ id, status: "COMPLETED" }),
    });

    await reconcile(context, "sweep.test", {
      ...h,
      decide: (row: Row) => {
        seen.push(row);
        return noOp("ALREADY_COMPLETED");
      },
    });

    expect(seen).toEqual([{ id: "a", status: "COMPLETED" }]);
  });
});
