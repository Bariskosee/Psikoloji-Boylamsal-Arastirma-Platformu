import { sql } from "drizzle-orm";
import { index, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { researcherUsers } from "../identity/researcher-users";
import { research } from "../schemas";
import { studies } from "./studies";

/**
 * A protocol — the stable label a study's schedule is known by (STRUCTURE.md §8).
 *
 * Exactly the same shape as `questionnaires`, and for the same reason: what a
 * participant is actually bound to at enrollment is a *version*, never this
 * row. Renaming a protocol therefore cannot disturb anyone already enrolled,
 * because the name they were enrolled under was never part of their binding.
 */
export const protocols = research.table(
  "protocols",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),

    studyId: uuid("study_id")
      .notNull()
      .references(() => studies.id, { onDelete: "cascade" }),

    name: text("name").notNull(),
    description: text("description").notNull().default(""),

    createdBy: uuid("created_by").references(() => researcherUsers.id, { onDelete: "set null" }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("protocols_study_idx").on(table.studyId)],
);
