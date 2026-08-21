import { sql } from "drizzle-orm";
import { boolean, check, integer, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { research } from "../schemas";
import { studies } from "./studies";

/**
 * Study groups (FR-45).
 *
 * A study with no rows here behaves as a single-group study, and nothing about
 * that case is harder — which is why allocation returns null rather than
 * requiring a synthetic "default" group that would then appear in exports.
 *
 * The participant never sees a group label.
 */
export const studyGroups = research.table(
  "study_groups",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),

    studyId: uuid("study_id")
      .notNull()
      .references(() => studies.id, { onDelete: "cascade" }),

    key: text("key").notNull(),
    label: text("label").notNull(),
    /** Relative share. Zero means defined but not recruiting. */
    allocationWeight: integer("allocation_weight").notNull().default(1),
    isActive: boolean("is_active").notNull().default(true),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("study_groups_key_idx").on(table.studyId, table.key),
    check("study_groups_weight_nonnegative", sql`${table.allocationWeight} >= 0`),
  ],
);
