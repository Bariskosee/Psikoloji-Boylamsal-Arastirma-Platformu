import { sql } from "drizzle-orm";
import { check, integer, text, timestamp } from "drizzle-orm/pg-core";
import { research } from "../schemas";

/**
 * Proof that the reconciliation sweepers are alive (ADR-005, STRUCTURE.md §8.4).
 *
 * The scheduling guarantee is a claim about a loop that runs every sixty
 * seconds. A loop that has silently stopped looks *exactly* like a loop with
 * nothing to do: no error, no failed request, no alert. Every other table in
 * this schema records something that happened; this one exists so that
 * something NOT happening becomes observable.
 *
 * That is not hypothetical. ADR-010 warns that a hosting tier which spins the
 * worker down when idle disables the entire guarantee, and the only way that
 * becomes visible before a participant misses a measurement point is a row here
 * going stale.
 *
 * Two failures are recorded separately, because they need different responses:
 *
 *   `swept_at` going stale         the loop stopped          → restart the worker
 *   `consecutive_failures` rising  the loop runs, work fails → read `last_error`
 *
 * Collapsing them into one signal would hide the second: a worker whose
 * sweepers all throw still completes its cycles, so its heartbeat stays fresh
 * while it reconciles nothing.
 *
 * Contains no participant data and no secret. It is operational evidence, and
 * `app_analytics` being able to read it is harmless.
 *
 * Rows are never pruned automatically. A decommissioned worker leaves a row
 * that stays permanently stale, and that is the intended behaviour: deleting it
 * is an operator's deliberate act, because code that tidies away stale
 * heartbeats is code that deletes the evidence of an outage.
 */
export const systemHeartbeats = research.table(
  "system_heartbeats",
  {
    /**
     * The worker instance, not the process: `WORKER_ID`, falling back to the
     * hostname. Deliberately stable across restarts, so a crash-looping worker
     * keeps updating ONE row rather than leaving a trail of orphaned rows that
     * are permanently stale and therefore permanently alerting.
     */
    workerId: text("worker_id").primaryKey(),

    /**
     * When this instance last booted. Rewritten on every start, which is what
     * makes a restart loop visible: a `started_at` that keeps moving while
     * `swept_at` never gets far ahead of it.
     */
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),

    /**
     * The end of the last COMPLETED sweep cycle.
     *
     * Written from the database's `now()`, never from the worker's process
     * clock. The sweep queries compare `available_from <= now()` against that
     * same clock, so a skewed worker must not be able to write a heartbeat that
     * disagrees with the schedule it is enforcing.
     */
    sweptAt: timestamp("swept_at", { withTimezone: true }).notNull(),

    /**
     * The interval this worker is configured to sweep at. Recorded so a reader
     * can judge "stale" against how often this worker actually promised to
     * report, instead of against a threshold hard-coded somewhere else.
     */
    sweepIntervalSeconds: integer("sweep_interval_seconds").notNull(),

    /** Reset by any clean cycle. A rising value is the second alert signal. */
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),

    /**
     * The failure summary from the last unclean cycle; NULL after a clean one.
     * Sweeper names and error messages only — never a payload, and never a
     * participant identifier (AGENT.md §5).
     */
    lastError: text("last_error"),
  },
  (table) => [
    /**
     * Defence in depth rather than the primary check: the worker validates its
     * interval at boot and never decrements the counter. They exist because a
     * database constraint survives a bug in the one process that writes here,
     * and application-level checks lose races (AGENT.md §6).
     */
    check("system_heartbeats_sweep_interval_positive", sql`${table.sweepIntervalSeconds} > 0`),
    check(
      "system_heartbeats_consecutive_failures_nonnegative",
      sql`${table.consecutiveFailures} >= 0`,
    ),
  ],
);

/**
 * No index, deliberately. This table holds one row per worker instance — a
 * handful, forever. An index on `swept_at` would cost a write every sixty
 * seconds to accelerate a sequential scan of five rows.
 */
export type SystemHeartbeatRow = typeof systemHeartbeats.$inferSelect;
export type NewSystemHeartbeatRow = typeof systemHeartbeats.$inferInsert;
