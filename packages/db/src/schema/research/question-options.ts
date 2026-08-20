import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { research } from "../schemas";
import { questionVersions } from "./question-versions";

/**
 * A selectable option under a `SINGLE_CHOICE` or `MULTI_CHOICE` question
 * (STRUCTURE.md §6).
 *
 * Normalised as rows rather than embedded in `config` jsonb: option
 * distributions are `GROUP BY` queries in Phase 11's analytics, and
 * `response_option_selections` (Phase 6) needs a real foreign key to the
 * exact option a participant was shown, not a value inside a blob.
 *
 * Label text lives in `question_option_translations`, mirroring
 * `question_version_translations` — see that table's comment.
 */
export const questionOptions = research.table(
  "question_options",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),

    questionVersionId: uuid("question_version_id")
      .notNull()
      .references(() => questionVersions.id, { onDelete: "cascade" }),

    /** Stable across edits and future publishes, like `question_key` (FR-43). */
    optionKey: text("option_key").notNull(),

    /** 0-based position within the question's option list. */
    displayOrder: integer("display_order").notNull(),

    /** Optional numeric coding for analysis (e.g. a Likert-style scale point). */
    valueNumber: doublePrecision("value_number"),

    /**
     * "None of the above" / "Prefer not to say" style options that a later
     * response-validation phase must treat as mutually exclusive with every
     * other selection on a `MULTI_CHOICE` question. Recorded now because it is
     * a property of the option's definition, not of any one response.
     */
    isExclusive: boolean("is_exclusive").notNull().default(false),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("question_options_key_key").on(table.questionVersionId, table.optionKey),
    index("question_options_order_idx").on(table.questionVersionId, table.displayOrder),
    check("question_options_display_order_nonnegative", sql`${table.displayOrder} >= 0`),
  ],
);

export type QuestionOptionRow = typeof questionOptions.$inferSelect;
export type NewQuestionOptionRow = typeof questionOptions.$inferInsert;
