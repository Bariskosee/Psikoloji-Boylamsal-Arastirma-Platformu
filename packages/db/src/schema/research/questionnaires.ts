import { sql } from "drizzle-orm";
import { index, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { researcherUsers } from "../identity/researcher-users";
import { research } from "../schemas";
import { studies } from "./studies";

/**
 * A questionnaire — a stable, study-scoped label its versions are filed
 * under (STRUCTURE.md §6, PLAN.md Phase 3).
 *
 * `name` and `description` are researcher-facing labels only, editable at any
 * time regardless of the draft or any published version's state — unlike
 * question content, renaming a questionnaire does not change what a
 * participant ever saw, so it carries none of the immutability rules that
 * apply to `questionnaire_versions`.
 */
export const questionnaires = research.table(
  "questionnaires",
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
  (table) => [
    // The builder's landing page lists a study's questionnaires newest-first.
    index("questionnaires_study_idx").on(table.studyId, table.createdAt.desc()),
  ],
);

export type QuestionnaireRow = typeof questionnaires.$inferSelect;
export type NewQuestionnaireRow = typeof questionnaires.$inferInsert;
