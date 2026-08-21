import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { research } from "../schemas";
import { participantSessions } from "./participant-sessions";
import { participants } from "./participants";
import { questionOptions } from "./question-options";
import { questionVersions } from "./question-versions";

/**
 * A participant's answer to one question (STRUCTURE.md §6).
 *
 * Typed columns rather than one `value_json`. Every analytics query and every
 * export cell is an aggregate over these values: typed columns index and
 * aggregate directly, while jsonb needs a cast on every read with no type
 * guarantee, and cannot enforce that a selected option belongs to the version
 * the participant was shown.
 *
 * Unique on `(session_id, question_version_id)`: one current answer per
 * question. The history of how it got there lives in `response_history`, so
 * this table stays the "what is true now" that every read wants.
 */
export const responses = research.table(
  "responses",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),

    sessionId: uuid("session_id")
      .notNull()
      .references(() => participantSessions.id, { onDelete: "cascade" }),
    /**
     * Denormalised from the session so that participant-scoped erasure and
     * every per-participant analytic query can find responses without joining
     * through sessions.
     */
    participantId: uuid("participant_id")
      .notNull()
      .references(() => participants.id, { onDelete: "restrict" }),

    questionVersionId: uuid("question_version_id")
      .notNull()
      .references(() => questionVersions.id, { onDelete: "restrict" }),

    /** Which typed column carries the value. */
    valueKind: text("value_kind").notNull(),
    valueNumber: doublePrecision("value_number"),
    valueText: text("value_text"),
    valueBoolean: boolean("value_boolean"),

    answeredAt: timestamp("answered_at", { withTimezone: true }).notNull(),
    /**
     * The client's monotonic counter for this question. The autosave gate: a
     * write at or below the stored revision is ignored, which makes a retry a
     * no-op and stops a replayed outbox entry overwriting a later correction.
     */
    clientRevision: integer("client_revision").notNull().default(0),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("responses_session_question_idx").on(table.sessionId, table.questionVersionId),
    index("responses_participant_idx").on(table.participantId),
    index("responses_session_idx").on(table.sessionId),
    check(
      "responses_value_kind_valid",
      sql`${table.valueKind} IN ('NUMBER', 'TEXT', 'OPTION', 'BOOLEAN')`,
    ),
    check("responses_client_revision_nonnegative", sql`${table.clientRevision} >= 0`),
  ],
);

/**
 * The options selected by a choice answer.
 *
 * Normalised rather than an array on `responses`, because option distributions
 * are `GROUP BY` queries and because a foreign key is what guarantees a
 * selection refers to an option that actually existed in the version shown.
 */
export const responseOptionSelections = research.table(
  "response_option_selections",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),

    responseId: uuid("response_id")
      .notNull()
      .references(() => responses.id, { onDelete: "cascade" }),
    questionOptionId: uuid("question_option_id")
      .notNull()
      .references(() => questionOptions.id, { onDelete: "restrict" }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("response_option_selections_idx").on(table.responseId, table.questionOptionId),
    index("response_option_selections_option_idx").on(table.questionOptionId),
  ],
);

/**
 * Append-only record of every write the server accepted OR refused.
 *
 * Cheap, and it is the only thing that can answer "what did the client send,
 * when, and what did we do with it" — which is exactly the question asked when
 * an autosave conflict is suspected or a reviewer queries a value. Writes that
 * LOST are recorded too: a stale revision that was ignored is evidence, and
 * keeping only the winners would make the history agree with the current state
 * by construction and prove nothing.
 */
export const responseHistory = research.table(
  "response_history",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),

    sessionId: uuid("session_id")
      .notNull()
      .references(() => participantSessions.id, { onDelete: "cascade" }),
    questionVersionId: uuid("question_version_id")
      .notNull()
      .references(() => questionVersions.id, { onDelete: "restrict" }),

    clientRevision: integer("client_revision").notNull(),
    /** `APPLY`, `IGNORE_STALE`, `IGNORE_DUPLICATE`, or `REJECTED`. */
    outcome: text("outcome").notNull(),
    /** The submitted value as received, before it was accepted or refused. */
    submitted: jsonb("submitted").notNull(),

    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("response_history_session_idx").on(table.sessionId, table.receivedAt),
    check(
      "response_history_outcome_valid",
      sql`${table.outcome} IN ('APPLY', 'IGNORE_STALE', 'IGNORE_DUPLICATE', 'REJECTED')`,
    ),
  ],
);

/**
 * The completion record — 1:1 with a completed session.
 *
 * What distinguishes draft answers from a final submission is this row plus
 * the session's `COMPLETED` status; the answers themselves are never
 * duplicated, so there is no second copy to drift.
 *
 * `content_hash` is a fingerprint of exactly what was submitted, so a later
 * question about whether a stored answer changed after completion has an
 * answer that does not depend on trusting the audit trail.
 */
export const sessionSubmissions = research.table(
  "session_submissions",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),

    // UNIQUE, not just a foreign key: this is the idempotency guard that makes
    // ten concurrent completions produce exactly one submission (§8.6).
    sessionId: uuid("session_id")
      .notNull()
      .references(() => participantSessions.id, { onDelete: "cascade" }),

    completedAt: timestamp("completed_at", { withTimezone: true }).notNull(),
    answeredCount: integer("answered_count").notNull(),
    requiredCount: integer("required_count").notNull(),
    contentHash: text("content_hash").notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("session_submissions_session_idx").on(table.sessionId),
    check(
      "session_submissions_counts_nonnegative",
      sql`${table.answeredCount} >= 0 AND ${table.requiredCount} >= 0`,
    ),
  ],
);
