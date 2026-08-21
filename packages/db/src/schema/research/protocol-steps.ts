import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { research } from "../schemas";
import { protocolVersions } from "./protocol-versions";
import { questionnaireVersions } from "./questionnaire-versions";
import { reminderPolicies } from "./reminder-policies";

/**
 * A protocol step — the heart of the protocol engine (STRUCTURE.md §8).
 *
 * One row is one measurement occasion, or one recurring block of them. What it
 * administers, when it opens, how long it stays open, how often it repeats, and
 * how the participant is reminded.
 *
 * ── What is enforced here and what is not ───────────────────────────────────
 * The checks below are the ones answerable from a single row. The rules that
 * need the whole graph — dangling references, cycles, and the FR-48 rules
 * about recurring targets — are enforced at publish by @lpr/domain's
 * `validateTriggerGraph`, because a draft routinely references a step that does
 * not exist yet and a half-built draft must remain saveable.
 *
 * That split is deliberate: the database refuses rows that are nonsense on
 * their own, and the publish gate refuses protocols that are nonsense as a
 * whole. Neither can be skipped by going around the service.
 */
export const protocolSteps = research.table(
  "protocol_steps",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),

    protocolVersionId: uuid("protocol_version_id")
      .notNull()
      .references(() => protocolVersions.id, { onDelete: "cascade" }),

    /** Order within the protocol, as the researcher arranged it. */
    stepIndex: integer("step_index").notNull(),

    /**
     * The stable export column prefix (`docs/export-codebook.md`).
     * Researcher-authored, unlike `question_key`, because it appears in the
     * analyst's CSV headers where `baseline` beats a random string.
     */
    stepKey: text("step_key").notNull(),

    /**
     * Deliberately NOT unique across steps: a pre/post design pins one
     * published version at two steps so the two administrations are guaranteed
     * to be the same instrument rather than two copies that drift (FR-47).
     */
    questionnaireVersionId: uuid("questionnaire_version_id")
      .notNull()
      .references(() => questionnaireVersions.id, { onDelete: "restrict" }),

    stepKind: text("step_kind").notNull().default("SCHEDULED"),

    triggerType: text("trigger_type").notNull(),
    /** Self-reference: the step this one follows, within the same version. */
    triggerStepId: uuid("trigger_step_id"),
    triggerOccurrenceIndex: integer("trigger_occurrence_index"),
    /**
     * The designated day for a FIXED_DATETIME step. A DATE, not a timestamp:
     * the instant it denotes depends on the anchor zone, which for a
     * PARTICIPANT anchor differs per participant. Resolving it up front would
     * shift part of the cohort onto the previous day, silently.
     */
    triggerFixedDate: date("trigger_fixed_date"),

    offsetIso: text("offset_iso").notNull().default("PT0S"),
    anchorLocalTime: text("anchor_local_time"),
    anchorTimezoneSource: text("anchor_timezone_source"),

    windowDurationIso: text("window_duration_iso").notNull(),

    occurrenceCount: integer("occurrence_count").notNull().default(1),
    recurrenceIntervalIso: text("recurrence_interval_iso"),

    reminderPolicyId: uuid("reminder_policy_id").references(() => reminderPolicies.id, {
      onDelete: "set null",
    }),

    /** Excludes exploratory steps from the compliance denominator (FR-44). */
    countsTowardCompliance: boolean("counts_toward_compliance").notNull().default(true),

    /** Participant-initiated steps only (FR-46). */
    minIntervalIso: text("min_interval_iso"),
    maxPerDay: integer("max_per_day"),
    maxTotal: integer("max_total"),

    /** Empty means every group (FR-45). */
    allowedGroupIds: uuid("allowed_group_ids")
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("protocol_steps_version_idx").on(table.protocolVersionId),
    index("protocol_steps_questionnaire_version_idx").on(table.questionnaireVersionId),

    // One step key per version: two steps sharing a key would produce two
    // export column groups with the same prefix, silently merging two
    // different measurements.
    uniqueIndex("protocol_steps_key_idx").on(table.protocolVersionId, table.stepKey),
    uniqueIndex("protocol_steps_order_idx").on(table.protocolVersionId, table.stepIndex),

    check(
      "protocol_steps_trigger_type_valid",
      sql`${table.triggerType} IN ('ENROLLMENT', 'CONSENT', 'STEP_COMPLETED', 'STEP_AVAILABLE', 'FIXED_DATETIME')`,
    ),
    check(
      "protocol_steps_kind_valid",
      sql`${table.stepKind} IN ('SCHEDULED', 'PARTICIPANT_INITIATED')`,
    ),
    check(
      "protocol_steps_anchor_source_valid",
      sql`${table.anchorTimezoneSource} IS NULL OR ${table.anchorTimezoneSource} IN ('STUDY', 'PARTICIPANT')`,
    ),

    // A trigger that names another step, and only such a trigger, carries a
    // step reference.
    check(
      "protocol_steps_trigger_reference_matches_type",
      sql`(${table.triggerType} IN ('STEP_COMPLETED', 'STEP_AVAILABLE')) = (${table.triggerStepId} IS NOT NULL)`,
    ),
    // Only a fixed-datetime step carries a designated date, and it must.
    check(
      "protocol_steps_fixed_date_matches_type",
      sql`(${table.triggerType} = 'FIXED_DATETIME') = (${table.triggerFixedDate} IS NOT NULL)`,
    ),
    // An occurrence index is meaningless without a referenced step. Whether it
    // is REQUIRED depends on the target's occurrence count, which only the
    // graph knows — that is FR-48a, checked at publish.
    check(
      "protocol_steps_occurrence_index_needs_reference",
      sql`${table.triggerOccurrenceIndex} IS NULL OR ${table.triggerStepId} IS NOT NULL`,
    ),
    check(
      "protocol_steps_occurrence_index_nonnegative",
      sql`${table.triggerOccurrenceIndex} IS NULL OR ${table.triggerOccurrenceIndex} >= 0`,
    ),

    // A local time with no zone to read it in is not an instant.
    check(
      "protocol_steps_wall_clock_paired",
      sql`(${table.anchorLocalTime} IS NULL) = (${table.anchorTimezoneSource} IS NULL)`,
    ),

    check("protocol_steps_occurrence_count_positive", sql`${table.occurrenceCount} >= 1`),
    // A step that repeats needs an interval; one that does not must not have one.
    check(
      "protocol_steps_recurrence_matches_count",
      sql`(${table.occurrenceCount} > 1) = (${table.recurrenceIntervalIso} IS NOT NULL)`,
    ),

    // Rate limits belong to participant-initiated steps alone (FR-46).
    check(
      "protocol_steps_rate_limits_scoped",
      sql`${table.stepKind} = 'PARTICIPANT_INITIATED'
          OR (${table.minIntervalIso} IS NULL AND ${table.maxPerDay} IS NULL AND ${table.maxTotal} IS NULL)`,
    ),

    check("protocol_steps_step_index_nonnegative", sql`${table.stepIndex} >= 0`),
  ],
);
