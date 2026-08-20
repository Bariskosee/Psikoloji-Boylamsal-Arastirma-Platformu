import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { research } from "../schemas";
import { questionnaireVersions } from "./questionnaire-versions";

/**
 * A question, scoped to one questionnaire version (STRUCTURE.md §6).
 *
 * Question WORDING lives in `question_version_translations`, not here — see
 * that table's comment. Everything queried relationally is a real column;
 * `config` holds only type-specific presentation parameters that are never
 * filtered or joined on, validated per type by @lpr/domain's question-type
 * registry before every write.
 */
export const questionVersions = research.table(
  "question_versions",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),

    questionnaireVersionId: uuid("questionnaire_version_id")
      .notNull()
      .references(() => questionnaireVersions.id, { onDelete: "cascade" }),

    /**
     * Stable across every edit and every future publish (FR-43). Assigned
     * once at creation by @lpr/domain's entity-key generator; nothing ever
     * regenerates it. This is the export column key.
     */
    questionKey: text("question_key").notNull(),

    /** `SINGLE_CHOICE | MULTI_CHOICE | LIKERT | NUMERIC | FREE_TEXT`. */
    type: text("type").notNull(),

    isRequired: boolean("is_required").notNull().default(true),

    /**
     * 0-based participant-facing page/section. Purely a grouping label — the
     * builder assigns it directly; reordering questions never changes it.
     */
    pageIndex: integer("page_index").notNull().default(0),

    /** 0-based global position across the whole questionnaire version. */
    displayOrder: integer("display_order").notNull(),

    config: jsonb("config")
      .notNull()
      .default(sql`'{}'::jsonb`),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("question_versions_key_key").on(table.questionnaireVersionId, table.questionKey),
    index("question_versions_order_idx").on(table.questionnaireVersionId, table.displayOrder),
    check(
      "question_versions_type_valid",
      sql`${table.type} IN ('SINGLE_CHOICE', 'MULTI_CHOICE', 'LIKERT', 'NUMERIC', 'FREE_TEXT')`,
    ),
    check("question_versions_page_index_nonnegative", sql`${table.pageIndex} >= 0`),
    check("question_versions_display_order_nonnegative", sql`${table.displayOrder} >= 0`),
  ],
);

export type QuestionVersionRow = typeof questionVersions.$inferSelect;
export type NewQuestionVersionRow = typeof questionVersions.$inferInsert;
