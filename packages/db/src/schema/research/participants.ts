import { sql } from "drizzle-orm";
import { check, index, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { research } from "../schemas";
import { studies } from "./studies";

/**
 * A participant (STRUCTURE.md §6).
 *
 * Contains **no directly identifying field**: no name, no email, no device id.
 * What a researcher sees is `public_code`, and what makes the platform
 * pseudonymous rather than anonymous lives elsewhere — the continuity
 * credential in `identity`, and later a push endpoint. Describing this data as
 * anonymous anywhere is forbidden (AGENT.md §3.3).
 *
 * `public_code` is random, never sequential. A sequential code would leak
 * enrollment order and sample size from any single participant's own code,
 * which in a small cohort is a re-identification lever.
 */
export const participants = research.table(
  "participants",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),

    studyId: uuid("study_id")
      .notNull()
      .references(() => studies.id, { onDelete: "restrict" }),

    publicCode: text("public_code").notNull(),

    enrolledAt: timestamp("enrolled_at", { withTimezone: true }).notNull().defaultNow(),

    /** IANA identifier, validated on write. Null when the browser would not say. */
    timezone: text("timezone"),
    locale: text("locale").notNull(),

    status: text("status").notNull().default("ACTIVE"),
    withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }),
    withdrawalReason: text("withdrawal_reason"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Unique per study rather than globally: the code is what a researcher
    // reads off a dashboard, and scoping it keeps it short enough to be usable.
    uniqueIndex("participants_public_code_idx").on(table.studyId, table.publicCode),
    index("participants_study_idx").on(table.studyId),
    check(
      "participants_status_valid",
      sql`${table.status} IN ('ACTIVE', 'COMPLETED', 'WITHDRAWN')`,
    ),
    // Withdrawal is a fact with an instant. A WITHDRAWN row without one could
    // not answer "when did they stop?", which every compliance denominator and
    // every ethics report needs.
    check(
      "participants_withdrawal_complete",
      sql`(${table.status} = 'WITHDRAWN') = (${table.withdrawnAt} IS NOT NULL)`,
    ),
  ],
);
