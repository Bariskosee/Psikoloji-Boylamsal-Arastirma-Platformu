import type { Pool } from "@lpr/db";
import { SWEEP_LOCK_TIMEOUT_MS, type SweepContext, type SweepOutcome } from "./sweeper.js";

/**
 * The universal handler contract, as executable code (ADR-005, STRUCTURE.md §8.5).
 *
 * ADR-005 states it in four lines, and every job handler and every sweeper in
 * this system is required to obey all four:
 *
 *   1. Open a transaction and take `SELECT … FOR UPDATE` on the row.
 *   2. Re-read canonical state and re-derive the decision. Never trust the
 *      payload beyond identifiers.
 *   3. No-op when the decision is no longer valid, recording why when
 *      research-relevant.
 *   4. Be safe to run twice, out of order, or a week late.
 *
 * Rules stated in prose get followed until the day someone is in a hurry. This
 * module makes them the only available shape: a caller supplies `claim`, `lock`,
 * `decide` and `apply`, and cannot express a handler that skips the lock or acts
 * on stale data, because `decide` is handed the freshly locked row and nothing
 * else.
 *
 * ── Why the claim and the work are separate transactions ─────────────────────
 *
 * `FOR UPDATE SKIP LOCKED` holds its locks until the transaction ends. Claiming
 * 500 rows and processing them inside that one transaction would hold 500 row
 * locks for the length of the batch, blocking every participant whose session is
 * in it — a participant hitting `POST /complete` would wait for a sweeper.
 *
 * So the claim commits immediately and the locks drop. Between the claim and the
 * work, anything may happen to those rows: another replica may take them, a
 * participant may complete one, an expiry may fire. That window is not a defect
 * to be closed. It is precisely why step 2 exists — every row is re-locked and
 * re-judged, and a row that changed underneath simply no-ops with a reason.
 *
 * The correctness of this design does not depend on the claim being exclusive.
 * That is what makes it safe under duplicate delivery, concurrent replicas, and
 * a queue that was wiped and restored from a backup.
 */

/**
 * The batch ceiling from ADR-005.
 *
 * A bound, not a target. Under normal load a sweep claims a handful of rows;
 * this caps the damage when it does not — the morning after an outage, or the
 * first sweep against a restored database. Recovery then takes several cycles
 * instead of one enormous transaction that holds connections, bloats WAL, and
 * times out halfway. Sixty seconds later the next cycle takes the next 500, and
 * the system converges either way.
 */
export const SWEEP_BATCH_LIMIT = 500;

/**
 * The database handle a sweeper's callbacks receive: one connection, inside one
 * open transaction.
 *
 * Structurally narrow on purpose. A real `pg.PoolClient` satisfies it, so
 * nothing is given up in production, while a test fake is a single method
 * rather than an implementation of the driver's whole surface — which is the
 * difference between the locking discipline in this file being tested and being
 * asserted about. It also keeps `pg` an implementation detail of `@lpr/db`,
 * as that package intends.
 */
export interface SweepClient {
  query<TRow>(text: string, values?: readonly unknown[]): Promise<{ rows: TRow[] }>;
}

/**
 * What re-deriving the decision under lock concluded.
 *
 * `NO_OP` carries a mandatory reason. "Nothing to do" is a research-relevant
 * fact — it is the difference between a reminder that was never owed and one
 * that was owed and lost — and a reason nobody was forced to supply is a reason
 * that will read `undefined` in the one incident where it mattered.
 */
export type ReconcileDecision =
  { readonly kind: "ACT" } | { readonly kind: "NO_OP"; readonly reason: string };

export const ACT: ReconcileDecision = Object.freeze({ kind: "ACT" });

export function noOp(reason: string): ReconcileDecision {
  return { kind: "NO_OP", reason };
}

export interface ReconcileHandlers<TRow> {
  /**
   * Identify candidates. Runs in its own short transaction and MUST use
   * `FOR UPDATE SKIP LOCKED LIMIT ${SWEEP_BATCH_LIMIT}` so replicas fan out
   * across disjoint rows instead of queueing behind each other.
   *
   * Returns identifiers only — never the state the decision will be made on.
   * Anything read here is stale by the time it is used, which is the mistake
   * step 2 of the contract exists to prevent.
   */
  claim(client: SweepClient): Promise<readonly string[]>;

  /**
   * Re-read ONE row with `SELECT … WHERE id = $1 FOR UPDATE`.
   *
   * Return `null` when the row is gone; the sweep records that and moves on.
   * A blocking `FOR UPDATE` — not `SKIP LOCKED` — because here we want to wait
   * for whoever holds it: that is usually the participant's own completion
   * request, and waiting for it is how the sweeper comes to see the completion
   * and correctly does nothing (STRUCTURE.md §9.2).
   */
  lock(client: SweepClient, id: string): Promise<TRow | null>;

  /**
   * Re-derive the decision from the locked row alone. Pure: no I/O, no clock,
   * no reference to what the claim believed. Given the same row it must return
   * the same decision, which is what makes a sweeper safe to run twice.
   */
  decide(row: TRow): ReconcileDecision;

  /**
   * Apply the decision, in the same transaction and under the same lock as the
   * `lock` and `decide` that authorised it. Anything enqueued here is enqueued
   * transactionally (ADR-004), so state and jobs commit together or not at all.
   */
  apply(client: SweepClient, row: TRow): Promise<void>;
}

/** Reasons this module records itself, distinct from a sweeper's own. */
export const RECONCILE_ROW_VANISHED = "ROW_VANISHED";

/**
 * Run one sweep: claim a batch, then reconcile each row under its own lock in
 * its own transaction.
 *
 * A row that throws is rolled back, counted, and does not stop the batch. One
 * poisoned row must not block the other 499 — a single unparseable record would
 * otherwise stall every participant's scheduling behind it, indefinitely,
 * because the next cycle would claim the same row first and fail the same way.
 */
export async function reconcile<TRow>(
  context: SweepContext,
  sweeperName: string,
  handlers: ReconcileHandlers<TRow>,
): Promise<SweepOutcome> {
  // Checked before the claim, not only inside the loop: during shutdown there
  // is no point paying for a round trip whose every result would be discarded.
  if (context.signal.aborted) return { claimed: 0, acted: 0, skipped: {}, failed: 0 };

  const ids = await claimBatch(context.pool, handlers);

  let acted = 0;
  let failed = 0;
  const skipped: Record<string, number> = {};

  for (const id of ids) {
    if (context.signal.aborted) break;

    try {
      const reason = await reconcileOne(context.pool, id, handlers);
      if (reason === null) {
        acted += 1;
      } else {
        skipped[reason] = (skipped[reason] ?? 0) + 1;
      }
    } catch (error) {
      failed += 1;
      // The identifier IS logged here, and only here. A row that fails
      // repeatedly cannot be diagnosed without knowing which row it is, and a
      // session id is pseudonymous — it resolves to a participant only through
      // the database, which is the boundary AGENT.md §5 draws. Successful rows
      // are never logged individually.
      context.logger.error(`${sweeperName}: reconciling ${id} failed: ${describeError(error)}`);
    }
  }

  return { claimed: ids.length, acted, skipped, failed };
}

/**
 * The claim, in a transaction that ends as soon as the ids are read.
 *
 * `ROLLBACK` rather than `COMMIT`: the claim writes nothing, and rolling back
 * states that. If a `claim` implementation ever does need to write — marking
 * rows as taken, say — that is a design change worth noticing here rather than
 * one that silently starts committing.
 */
async function claimBatch<TRow>(
  pool: Pool,
  handlers: ReconcileHandlers<TRow>,
): Promise<readonly string[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    try {
      // `SKIP LOCKED` never waits on a ROW lock, but the claim can still block
      // on a table-level lock — a migration mid-deploy is the realistic case.
      await setLockTimeout(client);
      const ids = await handlers.claim(client);
      await client.query("ROLLBACK");
      return ids;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {
        /* the transaction is dead either way; the original error explains it */
      });
      throw error;
    }
  } finally {
    client.release();
  }
}

/**
 * Lock one row, re-derive, act or not.
 *
 * Returns `null` when the decision was applied, or the no-op reason when it was
 * not — so the caller can aggregate reasons without the two outcomes ever being
 * confusable with a thrown error.
 */
async function reconcileOne<TRow>(
  pool: Pool,
  id: string,
  handlers: ReconcileHandlers<TRow>,
): Promise<string | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    try {
      await setLockTimeout(client);
      const row = await handlers.lock(client, id);

      if (row === null) {
        await client.query("ROLLBACK");
        return RECONCILE_ROW_VANISHED;
      }

      const decision = handlers.decide(row);

      if (decision.kind === "NO_OP") {
        await client.query("ROLLBACK");
        return decision.reason;
      }

      await handlers.apply(client, row);
      await client.query("COMMIT");
      return null;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {
        /* the transaction is dead either way; the original error explains it */
      });
      throw error;
    }
  } finally {
    client.release();
  }
}

/**
 * `SET LOCAL`, so it reverts when the transaction ends and cannot leak onto the
 * pooled connection and quietly govern unrelated queries later.
 */
async function setLockTimeout(client: SweepClient): Promise<void> {
  await client.query(`SET LOCAL lock_timeout = '${String(SWEEP_LOCK_TIMEOUT_MS)}ms'`);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
