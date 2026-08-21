import { expiryOutcome, type SessionStatus } from "@lpr/domain";
import { ACT, noOp, reconcile, type ReconcileDecision, type SweepClient } from "./reconcile.js";
import { SWEEP_BATCH_LIMIT } from "./reconcile.js";
import type { SweepContext, SweepOutcome, Sweeper } from "./sweeper.js";

/**
 * The two session sweepers (STRUCTURE.md §8.4, ADR-005).
 *
 * `sweep.activate_due` opens windows that have arrived; `sweep.expire_due`
 * closes windows that have passed. Between them they are what makes the
 * scheduling guarantee real: wipe every job in the queue and these two restore
 * correct state within one cycle, because they ask the database what is true
 * rather than what the queue remembers.
 *
 * ── Why the decision is re-derived from the row's own timestamps ────────────
 * Both sweepers could trust the status label — `SCHEDULED` means "not yet
 * open". They deliberately do not: `decide` compares `available_from` and
 * `available_until` against the row's own view of the clock, so a session
 * mislabelled by a crash mid-transition is corrected rather than skipped
 * forever.
 *
 * ── Why `now()` comes from the database ─────────────────────────────────────
 * Not from the worker's process clock. Two replicas with skewed clocks would
 * otherwise disagree about which sessions are due, and a worker whose clock
 * drifted an hour would open every window an hour early — invisibly, because
 * nothing else in the system would contradict it. One clock, the database's,
 * for the same reason `packages/domain` refuses to read a wall clock at all.
 */

interface DueRow {
  readonly id: string;
  readonly status: string;
  readonly available_from: Date | null;
  readonly available_until: Date | null;
  readonly response_count: string;
  readonly db_now: Date;
}

/** `SCHEDULED` sessions whose window has arrived. */
export function activateDueSweeper(): Sweeper {
  return {
    name: "sweep.activate_due",
    run: (context: SweepContext): Promise<SweepOutcome> =>
      reconcile<DueRow>(context, "sweep.activate_due", {
        claim: async (client) =>
          claimIds(
            client,
            `SELECT id FROM research.participant_sessions
            WHERE status = 'SCHEDULED' AND available_from <= now()
            ORDER BY available_from
            FOR UPDATE SKIP LOCKED
            LIMIT ${String(SWEEP_BATCH_LIMIT)}`,
          ),

        lock: (client, id) => lockSession(client, id),

        decide: (row): ReconcileDecision => {
          // Re-derived, not trusted. A row claimed a moment ago may have been
          // completed, cancelled, or already activated by another replica.
          if (row.status !== "SCHEDULED") return noOp(`NOT_SCHEDULED:${row.status}`);
          if (row.available_from === null) return noOp("NO_WINDOW");
          if (row.available_from.getTime() > row.db_now.getTime()) return noOp("NOT_YET_DUE");
          // A window that closed before anyone opened it is the expiry
          // sweeper's business, not this one's. Activating it first would
          // present the participant a questionnaire that refuses every write.
          if (
            row.available_until !== null &&
            row.available_until.getTime() <= row.db_now.getTime()
          ) {
            return noOp("ALREADY_CLOSED");
          }
          return ACT;
        },

        apply: async (client, row) => {
          await client.query(
            `UPDATE research.participant_sessions
                SET status = 'AVAILABLE', updated_at = now()
              WHERE id = $1 AND status = 'SCHEDULED'`,
            [row.id],
          );
        },
      }),
  };
}

/** `AVAILABLE` or `STARTED` sessions whose window has passed. */
export function expireDueSweeper(): Sweeper {
  return {
    name: "sweep.expire_due",
    run: (context: SweepContext): Promise<SweepOutcome> =>
      reconcile<DueRow>(context, "sweep.expire_due", {
        claim: async (client) =>
          claimIds(
            client,
            `SELECT id FROM research.participant_sessions
            WHERE status IN ('AVAILABLE', 'STARTED') AND available_until <= now()
            ORDER BY available_until
            FOR UPDATE SKIP LOCKED
            LIMIT ${String(SWEEP_BATCH_LIMIT)}`,
          ),

        lock: (client, id) => lockSession(client, id),

        decide: (row): ReconcileDecision => {
          // The participant may have submitted between the claim and the lock.
          // Waiting for their transaction and then declining to act is exactly
          // what the blocking lock in `lock()` is for.
          if (row.status !== "AVAILABLE" && row.status !== "STARTED") {
            return noOp(`NOT_OPEN:${row.status}`);
          }
          if (row.available_until === null) return noOp("NO_WINDOW");
          if (row.available_until.getTime() > row.db_now.getTime()) return noOp("STILL_OPEN");
          return ACT;
        },

        apply: async (client, row) => {
          /**
           * Which expired state, decided by the domain from the row itself.
           *
           * "Offered and ignored" and "opened and abandoned" are different
           * facts about the participant, and collapsing them would hide the
           * difference in every compliance figure afterwards (FR-44).
           */
          const outcome = expiryOutcome(row.status as SessionStatus, Number(row.response_count));
          if (outcome === null) return;

          await client.query(
            `UPDATE research.participant_sessions
                SET status = $2, expired_at = now(), updated_at = now()
              WHERE id = $1 AND status IN ('AVAILABLE', 'STARTED')`,
            [row.id, outcome],
          );
        },
      }),
  };
}

async function claimIds(client: SweepClient, text: string): Promise<readonly string[]> {
  const result = await client.query<{ id: string }>(text);
  return result.rows.map((row) => row.id);
}

/**
 * Re-read one session under a blocking lock, with its response count and the
 * database's clock in the same statement.
 *
 * All three together on purpose: a second round trip for the count would read
 * it outside the lock, and a second one for the time would read a different
 * instant than the one the decision is about.
 */
async function lockSession(client: SweepClient, id: string): Promise<DueRow | null> {
  const result = await client.query<DueRow>(
    `SELECT s.id,
            s.status,
            s.available_from,
            s.available_until,
            (SELECT count(*) FROM research.responses r WHERE r.session_id = s.id) AS response_count,
            now() AS db_now
       FROM research.participant_sessions s
      WHERE s.id = $1
      FOR UPDATE OF s`,
    [id],
  );
  return result.rows[0] ?? null;
}
