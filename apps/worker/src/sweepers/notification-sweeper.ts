import type { NotificationKind } from "@lpr/contracts";
import { processNotification, type SendDependencies } from "../notifications/send.js";
import { SWEEP_BATCH_LIMIT, type SweepClient } from "./reconcile.js";
import {
  EMPTY_SWEEP,
  SWEEP_LOCK_TIMEOUT_MS,
  type SweepContext,
  type SweepOutcome,
  type Sweeper,
} from "./sweeper.js";

/**
 * `sweep.notifications_due` (STRUCTURE.md §8.4, §9.1; ADR-005).
 *
 * The safety net under the reminder chain. Chains are self-propagating — each
 * link enqueues the next — which is efficient and has one failure mode: if a
 * link is ever lost, the chain stops silently and the participant is never
 * contacted again for that session. Nothing else in the system would notice.
 *
 * This sweeper closes that hole by re-deriving, every cycle, which link each
 * open session is owed next, entirely from `notification_attempts` and the
 * policy. It needs no memory of what was enqueued, which is what makes it
 * survive a wiped queue, a restored backup, or a worker that died holding a job.
 *
 * ── Why it calls the pipeline directly rather than enqueuing ────────────────
 * ADR-005's test is "wipe every pending job, run the sweepers, assert full
 * convergence". A sweeper that only enqueued would meet that test only while
 * the queue works — it would turn the queue back into a dependency by the back
 * door. Calling `processNotification` means the entire notification subsystem
 * functions with pg-boss switched off, one sweep interval late.
 *
 * ── Why it does not use `reconcile()` ───────────────────────────────────────
 * Every other sweeper does, and should. `reconcile()` supplies one transaction
 * per row around a lock/decide/apply triple — but this work cannot live in one
 * transaction: the attempt row must COMMIT before the network call
 * (STRUCTURE.md §9.1), so the send spans two. `processNotification` owns that
 * shape and enforces the same discipline internally: it takes the same row
 * lock, re-derives every decision from canonical state, and is safe to run
 * twice.
 *
 * The cross-replica advisory lock still applies, but NOT from this file:
 * `ReconciliationRunner` wraps every sweeper in it by name. Taking it again
 * here would use a second pooled connection, fail to acquire, and silently skip
 * the entire cycle's work.
 *
 * ── Why nothing enqueues on activation ──────────────────────────────────────
 * STRUCTURE.md §9.1 sketches the chain as starting from an enqueue when a
 * session becomes AVAILABLE. It starts here instead. The sweeper already has to
 * derive "this open session has never been notified" in order to be a safety
 * net at all, so an activation-time enqueue would be a second path to the same
 * conclusion — and a second path is a second thing that can disagree. The cost
 * is that an initial notification can be up to one sweep interval late, which
 * is sixty seconds against reminder cadences measured in hours, and well inside
 * the staleness guard's fifteen-minute floor.
 */

interface DueRow {
  session_id: string;
  kind: NotificationKind;
  occurrence_index: number;
  scheduled_for: Date;
}

/**
 * Which link each open session is owed next, and whether it is due.
 *
 * Read from the ATTEMPTS, never from the queue:
 *
 *  - no attempt at all → the INITIAL notification, due at
 *    `available_from + initial_delay`;
 *  - otherwise → the link after the highest one recorded, due one interval
 *    after that link was scheduled for.
 *
 * Measuring from the previous link's `scheduled_for` rather than from when it
 * actually ran is what keeps a cadence from drifting later all day, and it
 * matches `nextChainLink` in the domain — the two must agree, and the domain's
 * version is the tested one, so this query is deliberately its mirror rather
 * than an independent idea about the same thing.
 *
 * Sessions whose step has no reminder policy still appear, for their INITIAL
 * notification only: `max_reminders` is then treated as 0 by the pipeline, so
 * the chain ends after one contact.
 */
const CLAIM_SQL = `
  WITH open_sessions AS (
    SELECT s.id,
           s.available_from,
           COALESCE(rp.initial_delay_iso, 'PT0S') AS initial_delay_iso,
           rp.interval_iso,
           COALESCE(rp.max_reminders, 0)          AS max_reminders
      FROM research.participant_sessions s
      JOIN research.participants p    ON p.id  = s.participant_id
      JOIN research.protocol_steps ps ON ps.id = s.protocol_step_id
      LEFT JOIN research.reminder_policies rp ON rp.id = ps.reminder_policy_id
     WHERE s.status IN ('AVAILABLE', 'STARTED')
       AND p.status = 'ACTIVE'
       AND s.available_from IS NOT NULL
       AND s.available_until > now()
  ),
  last_attempt AS (
    SELECT o.id,
           o.available_from,
           o.initial_delay_iso,
           o.interval_iso,
           o.max_reminders,
           a.kind             AS last_kind,
           a.occurrence_index AS last_occurrence,
           a.scheduled_for    AS last_scheduled_for
      FROM open_sessions o
      LEFT JOIN LATERAL (
        SELECT na.kind, na.occurrence_index, na.scheduled_for
          FROM research.notification_attempts na
         WHERE na.session_id = o.id
         ORDER BY (na.kind = 'REMINDER') DESC, na.occurrence_index DESC
         LIMIT 1
      ) a ON true
  )
  SELECT id                                  AS session_id,
         CASE WHEN last_kind IS NULL THEN 'INITIAL' ELSE 'REMINDER' END AS kind,
         CASE WHEN last_kind IS NULL THEN 0
              WHEN last_kind = 'INITIAL' THEN 1
              ELSE last_occurrence + 1 END   AS occurrence_index,
         CASE WHEN last_kind IS NULL
              THEN available_from + initial_delay_iso::interval
              ELSE last_scheduled_for + COALESCE(interval_iso, 'PT0S')::interval
         END                                 AS scheduled_for
    FROM last_attempt
   WHERE (last_kind IS NULL
            OR (CASE WHEN last_kind = 'INITIAL' THEN 1 ELSE last_occurrence + 1 END)
               <= max_reminders)
     AND (CASE WHEN last_kind IS NULL
               THEN available_from + initial_delay_iso::interval
               ELSE last_scheduled_for + COALESCE(interval_iso, 'PT0S')::interval
          END) <= now()
   ORDER BY scheduled_for
   LIMIT ${String(SWEEP_BATCH_LIMIT)}`;

export function notificationsDueSweeper(deps: Omit<SendDependencies, "logger">): Sweeper {
  return {
    name: "sweep.notifications_due",

    async run(context: SweepContext): Promise<SweepOutcome> {
      const due = await claim(context);
      if (due.length === 0) return EMPTY_SWEEP;

      let acted = 0;
      let failed = 0;
      const skipped: Record<string, number> = {};

      for (const row of due) {
        // Stop claiming new work when the worker is shutting down. The
        // remainder waits for the next cycle, which re-derives it from
        // scratch — nothing is lost, which is the point of being a sweeper.
        if (context.signal.aborted) break;

        try {
          const result = await processNotification(
            { ...deps, logger: context.logger },
            {
              sessionId: row.session_id,
              kind: row.kind,
              occurrenceIndex: row.occurrence_index,
              scheduledFor: row.scheduled_for,
            },
          );

          if (result.status === "SENT") {
            acted += 1;
          } else {
            // Every non-send is counted by reason. A sweep that suppressed
            // forty notifications because a study closed is a very different
            // operational picture from one that sent forty.
            const reason = result.status === "SUPPRESSED" ? result.reason : result.status;
            skipped[reason] = (skipped[reason] ?? 0) + 1;
          }
        } catch (error) {
          failed += 1;
          context.logger.error(
            `notification sweep failed for one session: ` +
              `${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      return { claimed: due.length, acted, skipped, failed };
    },
  };
}

/**
 * Read the due list in its own short transaction, then let it go.
 *
 * No `FOR UPDATE` here, deliberately. `processNotification` takes the real lock
 * per session, and holding one across the whole batch would block every
 * participant in it from completing a questionnaire while the sweep ran. The
 * list going stale between the claim and the work is expected and handled: each
 * row is re-judged under its own lock, and one that changed simply records why
 * it did nothing.
 */
async function claim(context: SweepContext): Promise<DueRow[]> {
  const client = await context.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL lock_timeout = '${String(SWEEP_LOCK_TIMEOUT_MS)}ms'`);
    const result = await (client as unknown as SweepClient).query<DueRow>(CLAIM_SQL);
    await client.query("COMMIT");
    return result.rows;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
