import { sql } from "drizzle-orm";
import { check, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { research } from "../schemas";
import { questionOptions } from "./question-options";

/**
 * Per-locale option label. See `question_version_translations` for the full
 * reasoning — the same translation-table pattern applies here.
 */
export const questionOptionTranslations = research.table(
  "question_option_translations",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),

    questionOptionId: uuid("question_option_id")
      .notNull()
      .references(() => questionOptions.id, { onDelete: "cascade" }),

    locale: text("locale").notNull(),
    label: text("label").notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("question_option_translations_locale_key").on(table.questionOptionId, table.locale),
    check("question_option_translations_locale_valid", sql`${table.locale} IN ('en', 'tr')`),
  ],
);

export type QuestionOptionTranslationRow = typeof questionOptionTranslations.$inferSelect;
export type NewQuestionOptionTranslationRow = typeof questionOptionTranslations.$inferInsert;
