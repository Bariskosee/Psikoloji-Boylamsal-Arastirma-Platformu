import { sql } from "drizzle-orm";
import { check, index, integer, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { research } from "../schemas";
import { participants } from "./participants";
import { protocolSteps } from "./protocol-steps";
import { protocolVersions } from "./protocol-versions";
import { questionnaireVersions } from "./questionnaire-versions";
import { studies } from "./studies";

/**
 * A ParticipantSession — one measurement occasion for one participant
 * (STRUCTURE.md §7, §8.2).
 *
 * The unit everything downstream counts: the compliance denominator, the
 * participant timeline, the export's column groups. One row per (participant,
 * protocol step, occurrence), and the unique index on that triple is the
 * duplicate-materialisation guard (§8.6) — a retried enrollment or a
 * re-delivered job cannot produce two sessions for one occasion.
 *
 * ── Why the questionnaire version is denormalised onto the row ──────────────
 * It is reachable through `protocol_step_id`, but it is stored here as well
 * because it is what the participant ACTUALLY answered. The step is part of an
 * immutable published protocol version, so the two cannot drift today — and
 * storing it means that stays true no matter what a later phase does to
 * protocol editing, without every read having to join two more tables.
 *
 * In Phase 6 these rows are created by test fixtures. The engine that
 * materialises them from a protocol is Phase 7.
 */
export const participantSessions = research.table(
  "participant_sessions",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),

    participantId: uuid("participant_id")
      .notNull()
      .references(() => participants.id, { onDelete: "restrict" }),
    studyId: uuid("study_id")
      .notNull()
      .references(() => studies.id, { onDelete: "restrict" }),

    protocolVersionId: uuid("protocol_version_id")
      .notNull()
      .references(() => protocolVersions.id, { onDelete: "restrict" }),
    protocolStepId: uuid("protocol_step_id")
      .notNull()
      .references(() => protocolSteps.id, { onDelete: "restrict" }),
    occurrenceIndex: integer("occurrence_index").notNull().default(0),

    questionnaireVersionId: uuid("questionnaire_version_id")
      .notNull()
      .references(() => questionnaireVersions.id, { onDelete: "restrict" }),

    status: text("status").notNull().default("SCHEDULED"),

    triggerFiredAt: timestamp("trigger_fired_at", { withTimezone: true }),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    availableFrom: timestamp("available_from", { withTimezone: true }),
    availableUntil: timestamp("available_until", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    expiredAt: timestamp("expired_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancellationReason: text("cancellation_reason"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // The duplicate-materialisation guard (STRUCTURE.md §8.6).
    uniqueIndex("participant_sessions_occurrence_idx").on(
      table.participantId,
      table.protocolStepId,
      table.occurrenceIndex,
    ),
    index("participant_sessions_participant_idx").on(table.participantId, table.status),
    index("participant_sessions_study_idx").on(table.studyId),
    // The two sweeper queries in §8.4 read exactly these shapes.
    index("participant_sessions_activation_idx")
      .on(table.availableFrom)
      .where(sql`${table.status} = 'SCHEDULED'`),
    index("participant_sessions_expiry_idx")
      .on(table.availableUntil)
      .where(sql`${table.status} IN ('AVAILABLE', 'STARTED')`),

    check(
      "participant_sessions_status_valid",
      sql`${table.status} IN ('PENDING_TRIGGER', 'SCHEDULED', 'AVAILABLE', 'STARTED',
                              'COMPLETED', 'EXPIRED_UNSTARTED', 'EXPIRED_PARTIAL', 'CANCELLED')`,
    ),
    check(
      "participant_sessions_cancellation_reason_valid",
      sql`${table.cancellationReason} IS NULL
          OR ${table.cancellationReason} IN ('WITHDRAWAL', 'STUDY_CLOSED', 'TRIGGER_UNREACHABLE', 'ENROLLED_AFTER_WINDOW')`,
    ),
    // A cancelled session must say why. `ENROLLED_AFTER_WINDOW` in particular
    // is excluded from both compliance terms, and a null reason would leave it
    // indistinguishable from a participant who dropped out.
    check(
      "participant_sessions_cancellation_complete",
      sql`(${table.status} = 'CANCELLED') = (${table.cancelledAt} IS NOT NULL AND ${table.cancellationReason} IS NOT NULL)`,
    ),
    check(
      "participant_sessions_completion_complete",
      sql`(${table.status} = 'COMPLETED') = (${table.completedAt} IS NOT NULL)`,
    ),
    check("participant_sessions_occurrence_nonnegative", sql`${table.occurrenceIndex} >= 0`),
    check(
      "participant_sessions_window_ordered",
      sql`${table.availableFrom} IS NULL OR ${table.availableUntil} IS NULL
          OR ${table.availableUntil} > ${table.availableFrom}`,
    ),
  ],
);
