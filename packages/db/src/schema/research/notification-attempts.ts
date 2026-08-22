import { sql } from "drizzle-orm";
import { check, index, integer, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { research } from "../schemas";
import { participants } from "./participants";
import { participantSessions } from "./participant-sessions";

/**
 * Notification attempts (PLAN.md Phase 9, STRUCTURE.md §6, §9).
 *
 * The canonical record of what this study sent a participant, and — just as
 * importantly — of what it deliberately did not send them and why.
 *
 * ── The unique constraint IS the duplicate-reminder guard ───────────────────
 * `(session_id, kind, occurrence_index)`. Job delivery is at-least-once, two
 * workers may pick up the same job, and a sweeper may find work a job is
 * already doing. The application checks first because it is cheap; this index
 * is what makes the guarantee true, because an application check loses the
 * race and a database constraint does not.
 *
 * ── Why the row is committed BEFORE the network call ────────────────────────
 * The handler inserts `ATTEMPTED` and commits, then sends (STRUCTURE.md §9.1).
 * A process that dies mid-send therefore leaves a row saying "we may have sent
 * this, and we will not try again". That is at-most-once, chosen deliberately:
 * losing a reminder costs one nudge, while notifying a participant twice is
 * both an annoyance and a compliance-data artefact that no later analysis can
 * distinguish from a real second contact.
 *
 * ── This table is research data, not a log ──────────────────────────────────
 * Compliance analysis reads it. `notification_accepted` compared against
 * `session_completed` is the only evidence there is about outreach, and the
 * suppression reasons are what stop an outage of ours from being scored as
 * non-adherence of theirs (STRUCTURE.md §9.3). Rows are never pruned.
 */
export const notificationAttempts = research.table(
  "notification_attempts",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),

    sessionId: uuid("session_id")
      .notNull()
      .references(() => participantSessions.id, { onDelete: "cascade" }),

    /**
     * Denormalised from the session, as `responses` does, so the participant's
     * own notification history is one indexed read rather than a join — and so
     * a study-wide outreach query never has to touch the session table.
     */
    participantId: uuid("participant_id")
      .notNull()
      .references(() => participants.id, { onDelete: "cascade" }),

    kind: text("kind").notNull(),
    /** 0 for the initial notification; 1..n for links in the reminder chain. */
    occurrenceIndex: integer("occurrence_index").notNull(),

    /**
     * Which device this went to. Deliberately NOT a foreign key: the
     * subscription lives in the `identity` schema, and a cross-schema
     * constraint would reintroduce exactly the coupling that separation exists
     * to prevent (see `push-subscriptions.ts`).
     *
     * That absence is also what makes Phase 8's prune sweeper safe: a
     * subscription deleted after its retention window leaves this row intact,
     * which is correct — the attempt is research evidence and the endpoint was
     * only ever the means of delivery.
     */
    pushSubscriptionId: uuid("push_subscription_id"),

    /** When this link of the chain was due. Guard 8 measures lateness from it. */
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull(),
    /** Set when a send was actually attempted; null for every suppression. */
    attemptedAt: timestamp("attempted_at", { withTimezone: true }),

    outcome: text("outcome").notNull(),
    /** Set only when `outcome = 'SUPPRESSED'`; names which guard fired. */
    suppressionReason: text("suppression_reason"),

    /** What the push service answered. 404 and 410 mean the subscription is gone. */
    pushStatusCode: integer("push_status_code"),
    /**
     * A short failure description for an operator. Never a payload, never a
     * response body — a push service's error text is not somewhere participant
     * data should be able to arrive from, and this column is read by humans.
     */
    errorDetail: text("error_detail"),

    /**
     * Best-effort client reports (FR-19, STRUCTURE.md §9.3).
     *
     * Nullable and known to be lossy: the service worker is not running when
     * the device is off or has been killed under memory pressure, and iOS is
     * inconsistent about reporting at all. They are recorded because they are
     * the only window onto what happened after the push service accepted a
     * message — and they must never be used as a denominator. An absent
     * `displayed_at` means "we do not know", not "it was not displayed".
     */
    displayedAt: timestamp("displayed_at", { withTimezone: true }),
    clickedAt: timestamp("clicked_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /**
     * The primary duplicate-reminder guard (STRUCTURE.md §6).
     *
     * One row per (session, kind, occurrence), enforced by the database. Every
     * other protection against double-notifying a participant is an
     * optimisation on top of this one.
     */
    uniqueIndex("notification_attempts_unique_idx").on(
      table.sessionId,
      table.kind,
      table.occurrenceIndex,
    ),
    index("notification_attempts_participant_idx").on(table.participantId, table.scheduledFor),
    index("notification_attempts_session_idx").on(table.sessionId),

    check("notification_attempts_kind_valid", sql`${table.kind} IN ('INITIAL', 'REMINDER')`),
    check(
      "notification_attempts_outcome_valid",
      sql`${table.outcome} IN ('ATTEMPTED', 'SENT_ACCEPTED', 'FAILED', 'SUPPRESSED')`,
    ),
    check("notification_attempts_occurrence_nonnegative", sql`${table.occurrenceIndex} >= 0`),
    /**
     * A suppression must say which guard fired, and nothing else may claim to
     * have been suppressed. The reason is the research-relevant half of this
     * row — a suppression with no reason is indistinguishable from a
     * participant who ignored us, which is precisely the confusion the column
     * exists to prevent.
     */
    check(
      "notification_attempts_suppression_complete",
      sql`(${table.outcome} = 'SUPPRESSED' AND ${table.suppressionReason} IS NOT NULL)
          OR (${table.outcome} <> 'SUPPRESSED' AND ${table.suppressionReason} IS NULL)`,
    ),
    check(
      "notification_attempts_suppression_reason_valid",
      sql`${table.suppressionReason} IS NULL OR ${table.suppressionReason} IN (
            'SUPPRESSED_STATE', 'SUPPRESSED_EXPIRED', 'SUPPRESSED_WITHDRAWN',
            'SUPPRESSED_CAP', 'SUPPRESSED_NO_SUBSCRIPTION', 'SUPPRESSED_QUIET_HOURS',
            'SUPPRESSED_STALE')`,
    ),
    /**
     * A suppression was never attempted, and everything else was. This is what
     * keeps "how many times did we actually try to reach this participant?"
     * answerable by counting a single column.
     */
    check(
      "notification_attempts_attempted_at_consistent",
      sql`(${table.outcome} = 'SUPPRESSED' AND ${table.attemptedAt} IS NULL)
          OR (${table.outcome} <> 'SUPPRESSED' AND ${table.attemptedAt} IS NOT NULL)`,
    ),
  ],
);
