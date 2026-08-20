import { sql } from "drizzle-orm";
import { check, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { research } from "../schemas";
import { questionVersions } from "./question-versions";

/**
 * Per-locale question wording (STRUCTURE.md §15: "researcher-entered content
 * — application data in `*_translations` tables keyed by (entity version,
 * locale)").
 *
 * Kept out of `question_versions` itself so a question can exist with only
 * the study's default locale filled in and gain the rest later, and so
 * translating an EXISTING published question's wording is structurally
 * impossible — a `question_versions` row under a `PUBLISHED` parent is
 * immutable, and so, by the same trigger, is every translation row beneath
 * it.
 *
 * `text` is stored and MUST be rendered as plain text, never HTML — a
 * malicious script payload entered here is exactly the stored-XSS case
 * STRUCTURE.md §11.5 requires the builder preview to defend against.
 */
export const questionVersionTranslations = research.table(
  "question_version_translations",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),

    questionVersionId: uuid("question_version_id")
      .notNull()
      .references(() => questionVersions.id, { onDelete: "cascade" }),

    locale: text("locale").notNull(),
    text: text("text").notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("question_version_translations_locale_key").on(
      table.questionVersionId,
      table.locale,
    ),
    check("question_version_translations_locale_valid", sql`${table.locale} IN ('en', 'tr')`),
  ],
);

export type QuestionVersionTranslationRow = typeof questionVersionTranslations.$inferSelect;
export type NewQuestionVersionTranslationRow = typeof questionVersionTranslations.$inferInsert;
