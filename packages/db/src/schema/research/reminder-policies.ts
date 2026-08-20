import { sql } from "drizzle-orm";
import { check, integer, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { research } from "../schemas";

/**
 * A reminder policy (FR-40, STRUCTURE.md §8).
 *
 * One row per step that has one. Kept as its own table rather than columns on
 * `protocol_steps` because Phase 9's sending logic reads a policy on its own,
 * and because a policy is deep-copied at publish alongside the step it belongs
 * to — a published step must keep the cadence it was published with even if
 * the draft's is edited afterwards.
 *
 * `max_reminders` is NOT NULL with no default on purpose. FR-40 makes the cap
 * mandatory so that "how many times will this person be contacted?" always has
 * an answer a researcher chose, rather than one that emerged from the cadence
 * and the window length.
 */
export const reminderPolicies = research.table(
  "reminder_policies",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),

    /** How long after the window opens the first reminder may go out. */
    initialDelayIso: text("initial_delay_iso").notNull(),
    /** Spacing between reminders after the first. */
    intervalIso: text("interval_iso").notNull(),
    maxReminders: integer("max_reminders").notNull(),

    /** Local wall-clock `HH:MM`, in the participant's zone. Both or neither. */
    quietHoursStart: text("quiet_hours_start"),
    quietHoursEnd: text("quiet_hours_end"),
    quietHoursBehavior: text("quiet_hours_behavior").notNull().default("DEFER"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("reminder_policies_max_nonnegative", sql`${table.maxReminders} >= 0`),
    check(
      "reminder_policies_quiet_hours_behavior_valid",
      sql`${table.quietHoursBehavior} IN ('SKIP', 'DEFER')`,
    ),
    /**
     * A start without an end does not describe an interval, and the sender
     * would have to invent the missing half at 3am on someone's phone.
     */
    check(
      "reminder_policies_quiet_hours_paired",
      sql`(${table.quietHoursStart} IS NULL) = (${table.quietHoursEnd} IS NULL)`,
    ),
  ],
);
